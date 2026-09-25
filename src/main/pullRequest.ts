import type { OperationResult, PullRequestInfo, StepResult } from '../shared/types'
import { runJsonTask } from './ai'
import { findBinary, runCli } from './cli'
import { git, refExists, run, status } from './git'
import { getSettings } from './settings'

/**
 * Pull Request pelo app, via GitHub CLI (gh). Em linguagem simples: "pedir revisão" do trabalho
 * e, depois de aprovado, "juntar na linha principal".
 */

const MAIN_NAMES = ['main', 'master', 'develop']

/** gh do sistema; testes automatizados podem apontar para um gh simulado. */
async function ghPath(): Promise<string | null> {
  if (process.env.OVRGIT_GH_BIN) return process.env.OVRGIT_GH_BIN
  return findBinary('gh')
}

async function gh(): Promise<string> {
  const bin = await ghPath()
  if (!bin) throw new Error('Para criar e acompanhar o PR pelo app, instale o GitHub CLI (gh) e rode "gh auth login".')
  return bin
}

async function ghJson<T>(root: string, args: string[]): Promise<T | null> {
  const r = await runCli(await gh(), args, '', root, 30_000)
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout) as T
  } catch {
    return null
  }
}

/** Linha principal de destino (a do servidor: main, master…). */
export async function defaultBase(root: string): Promise<string> {
  const head = (await run(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim()
  if (head) return head.replace(/^origin\//, '')
  for (const n of MAIN_NAMES) if (await refExists(root, `refs/remotes/origin/${n}`)) return n
  return 'main'
}

interface GhPr {
  number: number
  url: string
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '' | null
  baseRefName: string
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[]
}

function checksOf(pr: GhPr): PullRequestInfo['checks'] {
  const list = pr.statusCheckRollup ?? []
  if (!list.length) return 'none'
  const bad = list.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(String(c.conclusion ?? c.state)))
  if (bad) return 'failing'
  const pending = list.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')
  return pending ? 'pending' : 'passing'
}

/** PR da linha atual (se existir). */
export async function currentPullRequest(root: string): Promise<PullRequestInfo | null> {
  const bin = await ghPath()
  const st = await status(root)
  // a linha principal não tem PR "dela"
  if (!bin || !st.branch || !st.published || MAIN_NAMES.includes(st.branch)) return null
  const fields = 'number,url,title,state,isDraft,mergeable,reviewDecision,baseRefName,statusCheckRollup'
  const list = await ghJson<GhPr[]>(root, ['pr', 'list', '--head', st.branch, '--state', 'all', '--limit', '1', '--json', fields])
  const pr = list?.[0]
  if (!pr) return null
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open',
    base: pr.baseRefName,
    checks: checksOf(pr),
    review: pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending',
    conflicts: pr.mergeable === 'CONFLICTING'
  }
}

/** Contexto para a IA escrever o PR: versões da linha e resumo do que mudou. */
async function prContext(root: string, base: string, taskInfo: string | null) {
  const range = `origin/${base}...HEAD`
  const [log, stat, patch] = await Promise.all([
    git(root, ['log', '--no-merges', '--format=- %s%n%b', `origin/${base}..HEAD`]),
    git(root, ['diff', '--stat=120', range]),
    git(root, ['diff', '--unified=0', '--no-color', range])
  ])
  const changed = patch
    .split('\n')
    .filter((l) => /^[+-](?![+-]{2} )/.test(l) || l.startsWith('diff --git'))
    .map((l) => l.slice(0, 160))
    .join('\n')
    .slice(0, 9000)
  return [
    taskInfo ? `Tarefa relacionada: ${taskInfo}\n` : '',
    'Versões (commits) desta linha de trabalho:',
    log.trim().slice(0, 4000),
    '',
    'Arquivos alterados:',
    stat.trim().slice(0, 3000),
    '',
    'Trechos alterados (resumo):',
    changed
  ].join('\n')
}

const PR_SYSTEM = `Você escreve Pull Requests para um repositório Git.
Responda SEMPRE em português do Brasil e SOMENTE com JSON válido no formato pedido.
- "title": curto (até 72 caracteres), no presente, dizendo o que o PR entrega.
- "body": Markdown com as seções "## O que muda" (lista objetiva), "## Como testar" (passos simples)
  e, se houver tarefa relacionada, uma linha "Tarefa: <código>". Sem enrolação.`

export async function draftPullRequest(root: string, taskInfo: string | null): Promise<{ title: string; body: string; base: string }> {
  const base = await defaultBase(root)
  await run(root, ['fetch', '-q', 'origin', base])
  const context = await prContext(root, base, taskInfo)
  const r = await runJsonTask<{ title?: string; body?: string }>(
    getSettings(),
    PR_SYSTEM,
    { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
    'Escreva o Pull Request para as alterações abaixo.',
    context
  )
  return { title: String(r.title ?? '').trim(), body: String(r.body ?? '').trim(), base }
}

export async function createPullRequest(
  root: string,
  input: { title: string; body: string; base: string; draft: boolean }
): Promise<OperationResult> {
  const steps: StepResult[] = []
  const st = await status(root)
  if (!st.branch || !st.published) {
    return { ok: false, steps, error: 'Envie esta linha de trabalho para o servidor antes de pedir revisão.' }
  }
  if (!input.title.trim()) return { ok: false, steps, error: 'Escreva um título.' }
  if (!/^[\w./-]+$/.test(input.base) || input.base.startsWith('-')) return { ok: false, steps, error: 'Linha de destino inválida.' }
  const args = ['pr', 'create', '--head', st.branch, '--base', input.base, '--title', input.title.trim(), '--body-file', '-']
  if (input.draft) args.push('--draft')
  const r = await runCli(await gh(), args, input.body, root, 60_000)
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')
    steps.push({ label: 'Pedir revisão (PR)', ok: false, detail: msg })
    return { ok: false, steps, error: /already exists/i.test(msg) ? 'Já existe um PR para esta linha.' : msg }
  }
  const url = (r.stdout.match(/https:\/\/\S+\/pull\/\d+/) ?? [])[0] ?? null
  steps.push({ label: input.draft ? 'PR criado como rascunho' : 'PR criado: revisão pedida', ok: true, detail: url ?? undefined })
  return { ok: true, steps, prUrl: url }
}

/** Junta o PR na linha principal e volta para ela, atualizada. */
export async function mergePullRequest(root: string, method: 'merge' | 'squash'): Promise<OperationResult> {
  const steps: StepResult[] = []
  const pr = await currentPullRequest(root)
  if (!pr || pr.state !== 'open') return { ok: false, steps, error: 'Não há PR aberto para esta linha.' }
  const st = await status(root)
  if (st.files.length) {
    return { ok: false, steps, error: 'Salve ou descarte as alterações pendentes antes de juntar.' }
  }
  const r = await runCli(await gh(), ['pr', 'merge', String(pr.number), method === 'squash' ? '--squash' : '--merge'], '', root, 120_000)
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')
    steps.push({ label: 'Juntar na principal', ok: false, detail: msg })
    return { ok: false, steps, error: msg }
  }
  steps.push({ label: `PR #${pr.number} juntado em ${pr.base}`, ok: true })
  // volta para a principal já atualizada
  const back = await run(root, ['switch', pr.base])
  if (back.code === 0) {
    await run(root, ['pull', '--ff-only', '-q'])
    steps.push({ label: `Agora em "${pr.base}", atualizada`, ok: true })
  }
  return { ok: true, steps }
}

export const ghAvailable = async () => !!(await findBinary('gh'))
