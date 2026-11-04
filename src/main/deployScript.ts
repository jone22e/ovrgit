import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { IPty } from '@lydell/node-pty'
import {
  DEPLOY_STEP_MARKER, stripAnsi,
  type DeployLock, type DeployOperation, type DeployPhase, type DeployPlanResult, type DeployRelease, type DeployScriptManifest, type DeploySnapshot
} from '../shared/deploy'
import { trackPty } from './ptyRegistry'

/**
 * Adaptador `script`: o deploy é um comando de shell rodado num pseudoterminal na raiz do repositório. O script
 * avisa em que etapa está com linhas `[ovseer] etapa <id>`; a etapa anterior fecha como concluída, a última
 * fecha pelo código de saída. Cada execução vira uma "release" com o mesmo formato do adaptador console, e o
 * histórico (com a saída por etapa) fica em userData/deploy-runs, fora do repositório.
 */

interface ScriptRun {
  tag: string
  target?: string
  status: 'running' | 'failed' | 'completed'
  commit: string
  branch: string
  created_at: string
  updated_at: string
  exit_code?: number | null
  current?: string
  phases: Record<string, DeployPhase>
  logs: Record<string, string>
  failure?: { phase: string; error: string }
}

interface Active {
  run: ScriptRun
  pty: IPty
  /** Pedaço de linha ainda sem quebra, para achar marcadores que chegam partidos */
  partial: string
  cancelRequestedAt?: string
}

const runsByRoot = new Map<string, ScriptRun[]>()
const active = new Map<string, Active>()
const plans = new Map<string, { root: string; tag: string; target?: string; expiresAt: number }>()
const LOG_MAX = 200_000
const RUNS_MAX = 20

const runsFile = (root: string) => path.join(app.getPath('userData'), 'deploy-runs', `${Buffer.from(root).toString('base64url')}.json`)

function loadRuns(root: string): ScriptRun[] {
  const cached = runsByRoot.get(root)
  if (cached) return cached
  let runs: ScriptRun[] = []
  try {
    runs = JSON.parse(readFileSync(runsFile(root), 'utf8')) as ScriptRun[]
  } catch {
    runs = []
  }
  // o app fechou no meio de uma execução: ela não roda mais
  for (const r of runs) {
    if (r.status === 'running') {
      r.status = 'failed'
      r.failure = { phase: r.current ?? 'orquestracao_local', error: 'O Ovseer foi fechado durante o deploy.' }
      if (r.current && r.phases[r.current]?.status === 'running') r.phases[r.current] = { ...r.phases[r.current], status: 'failed', failed_at: r.updated_at, error: r.failure.error }
    }
  }
  runsByRoot.set(root, runs)
  return runs
}

function saveRuns(root: string) {
  const runs = loadRuns(root).slice(0, RUNS_MAX)
  runsByRoot.set(root, runs)
  const file = runsFile(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(runs))
  renameSync(`${file}.tmp`, file)
}

const git = (root: string, args: string[]) =>
  new Promise<string>((resolve) => execFile('git', args, { cwd: root, timeout: 8000, windowsHide: true }, (_e, out) => resolve(String(out ?? '').trim())))

const nextTag = (root: string) => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `deploy-${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const taken = new Set(loadRuns(root).map((r) => r.tag))
  let tag = base
  for (let i = 2; taken.has(tag); i += 1) tag = `${base}-${i}`
  return tag
}

const toRelease = (r: ScriptRun): DeployRelease => ({
  tag: r.tag,
  target: r.target,
  status: r.status,
  commit: r.commit,
  created_at: r.created_at,
  updated_at: r.updated_at,
  phases: r.phases,
  failure_phase: r.failure?.phase,
  failure_detail: r.failure?.error
})

const operationOf = (a: Active): DeployOperation => ({
  operation_id: a.run.tag,
  name: 'deploy',
  started_at: a.run.created_at,
  release_tag: a.run.tag,
  cancellable: true,
  cancel_requested_at: a.cancelRequestedAt
})

export function snapshot(root: string): DeploySnapshot {
  const releases = [...loadRuns(root)].map(toRelease)
  const a = active.get(root)
  return { console: 'ready', origin: '', operation: a ? operationOf(a) : null, releases, current: releases[0] ?? null, expectedTests: 0, lockSupported: false }
}

export function lock(): DeployLock {
  return { status: 'free', stale: false, location: '', lock: null, checked_at: new Date().toISOString() }
}

export async function plan(root: string, m: DeployScriptManifest, target?: string): Promise<DeployPlanResult> {
  if (active.get(root)) throw new Error('Já há um deploy em andamento neste projeto.')
  if (m.targets) {
    if (!target) throw new Error('Escolha o alvo do deploy.')
    if (!m.targets.some((t) => t.id === target)) throw new Error(`Alvo desconhecido: ${target}.`)
  } else {
    target = undefined
  }
  const [commit, branch, porcelain] = await Promise.all([git(root, ['rev-parse', 'HEAD']), git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), git(root, ['status', '--porcelain'])])
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
  const previous = loadRuns(root).find((r) => r.status === 'completed')
  const tag = nextTag(root)
  const plan_id = randomBytes(18).toString('base64url')
  plans.set(plan_id, { root, tag, target, expiresAt: Date.now() + 15 * 60_000 })
  const reasons = [`branch ${branch || '?'}`, `${m.steps.length} etapas: ${m.steps.map((s) => s.title).join(' → ')}`]
  const warnings = dirty ? [`${dirty} arquivo(s) com alterações não salvas: o deploy pode recusar ou publicar o que está no disco.`] : []
  return { plan_id, plan: { tag, target, commit, previous_tag: previous?.tag ?? '', order: commandFor(m, target), plan: { reasons, warnings } } }
}

const commandFor = (m: DeployScriptManifest, target?: string) => (target ? m.command.replaceAll('{target}', target) : m.command)

export async function run(root: string, m: DeployScriptManifest, planId: string): Promise<DeployOperation> {
  const p = plans.get(planId)
  plans.delete(planId)
  if (!p || p.root !== root || p.expiresAt < Date.now()) throw new Error('Plano ausente ou expirado; gere um novo plano.')
  if (active.get(root)) throw new Error('Já há um deploy em andamento neste projeto.')
  const [commit, branch] = await Promise.all([git(root, ['rev-parse', 'HEAD']), git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])])
  const now = new Date().toISOString()
  const first = m.steps[0]
  const command = commandFor(m, p.target)
  const runRecord: ScriptRun = {
    tag: p.tag, target: p.target, status: 'running', commit, branch, created_at: now, updated_at: now,
    current: first.id, phases: { [first.id]: { status: 'running', started_at: now } }, logs: {}
  }
  const runs = loadRuns(root)
  runs.unshift(runRecord)
  const { spawn } = await import('@lydell/node-pty')
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const args = process.platform === 'win32' ? ['-NoLogo', '-Command', command] : ['-l', '-i', '-c', command]
  const pty = spawn(shell, args, {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: existsSync(root) ? root : os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'Ovseer', OVSEER_DEPLOY: '1', OVSEER_DEPLOY_TAG: p.tag, ...(p.target ? { OVSEER_DEPLOY_TARGET: p.target } : {}) } as Record<string, string>
  })
  trackPty(pty)
  const a: Active = { run: runRecord, pty, partial: '' }
  active.set(root, a)
  saveRuns(root)
  pty.onData((data) => consume(root, a, m, data))
  pty.onExit(({ exitCode }) => finish(root, a, exitCode))
  return operationOf(a)
}

/** Guarda a saída na etapa atual, linha a linha, e troca de etapa quando vê o marcador */
function consume(root: string, a: Active, m: DeployScriptManifest, data: string) {
  const r = a.run
  const combined = a.partial + stripAnsi(data).replace(/\r\n?/g, '\n')
  const lines = combined.split('\n')
  a.partial = lines.pop() ?? ''
  let changed = false
  for (const line of lines) {
    const match = line.trim().match(DEPLOY_STEP_MARKER)
    if (match && m.steps.some((s) => s.id === match[1]) && match[1] !== r.current) {
      const now = new Date().toISOString()
      if (r.current && r.phases[r.current]?.status === 'running') r.phases[r.current] = { ...r.phases[r.current], status: 'completed', completed_at: now }
      r.phases[match[1]] = { status: 'running', started_at: now }
      r.current = match[1]
      r.updated_at = now
      changed = true
      continue
    }
    appendLog(r, r.current ?? m.steps[0].id, `${line}\n`)
  }
  if (changed) saveRuns(root)
}

function appendLog(r: ScriptRun, phase: string, text: string) {
  r.logs[phase] = ((r.logs[phase] ?? '') + text).slice(-LOG_MAX)
}

function finish(root: string, a: Active, exitCode: number | null) {
  const r = a.run
  const now = new Date().toISOString()
  if (a.partial) {
    appendLog(r, r.current ?? 'orquestracao_local', `${a.partial}\n`)
    a.partial = ''
  }
  r.exit_code = exitCode
  r.updated_at = now
  if (exitCode === 0) {
    if (r.current && r.phases[r.current]?.status === 'running') r.phases[r.current] = { ...r.phases[r.current], status: 'completed', completed_at: now }
    r.status = 'completed'
  } else {
    const phase = r.current ?? 'orquestracao_local'
    const output = (r.logs[phase] ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean)
    const error = a.cancelRequestedAt ? 'Deploy cancelado pelo usuário.' : `${output[output.length - 1] ?? 'o comando falhou'} (código ${exitCode ?? 'sinal'})`
    if (r.current) r.phases[r.current] = { ...r.phases[r.current], status: 'failed', failed_at: now, error }
    r.status = 'failed'
    r.failure = { phase, error }
  }
  active.delete(root)
  saveRuns(root)
}

export function cancel(root: string, operationId: string) {
  const a = active.get(root)
  if (!a) throw new Error('Nenhum deploy está em andamento.')
  if (a.run.tag !== operationId) throw new Error('A operação ativa mudou; atualize a tela antes de cancelar.')
  if (!a.cancelRequestedAt) {
    a.cancelRequestedAt = new Date().toISOString()
    try {
      a.pty.kill('SIGTERM')
    } catch {
      /* já encerrado */
    }
    setTimeout(() => {
      if (active.get(root) === a) {
        try {
          a.pty.kill('SIGKILL')
        } catch {
          /* já encerrado */
        }
      }
    }, 10_000).unref()
  }
}

export function log(root: string, tag: string, phase: string): string {
  const r = loadRuns(root).find((x) => x.tag === tag)
  return r?.logs[phase] ?? ''
}
