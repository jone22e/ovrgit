/**
 * Deploy pelo Ovseer: cada repositório declara em `.ovseer/deploy.json` como o app sobe e acompanha o seu
 * deploy. Dois tipos de adaptador:
 * - `console`: um servidor local (como o deploy-console do Flexi) com a API de releases, fases, eventos e
 *   trava compartilhada; o manifesto diz quais fases do motor entram em cada etapa.
 * - `script`: um comando de shell (como `make deploy`) que o app roda na raiz do repositório; o script marca
 *   a etapa em que está com linhas `[ovseer] etapa <id>` na saída, e o código de saída decide o resultado.
 * Nos dois casos o app desenha a mesma lista numerada de etapas.
 */

export interface DeployStepSpec {
  id: string
  title: string
  /** Fases do motor que compõem a etapa, na ordem em que acontecem */
  phases: string[]
}

interface DeployManifestBase {
  ovseer: 'deploy'
  version: 1
  /** Nome mostrado no botão e no serviço que sobe o console (padrão: "Deploy") */
  name: string
  steps: DeployStepSpec[]
}
export interface DeployConsoleManifest extends DeployManifestBase {
  kind: 'console'
  /** Comando de shell que sobe o console, rodando na raiz do repositório */
  start: string
  /** Porta local em que o console responde */
  port: number
}
/** Alvo escolhido na hora do deploy (uma loja, um ambiente…); o id entra no comando no lugar de {target} */
export interface DeployTargetSpec {
  id: string
  title: string
}
export interface DeployScriptManifest extends DeployManifestBase {
  kind: 'script'
  /** Comando de shell do deploy, rodando na raiz do repositório; com alvos, contém {target} */
  command: string
  targets?: DeployTargetSpec[]
}
export type DeployManifest = DeployConsoleManifest | DeployScriptManifest

/** Linha que o script emite ao entrar numa etapa: `[ovseer] etapa <id>` */
export const DEPLOY_STEP_MARKER = /^\[ovseer\] etapa ([a-z0-9_-]+)\s*$/i
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

/** Etapas padrão do adaptador `console`, iguais aos blocos do console do Flexi */
export const DEFAULT_CONSOLE_STEPS: DeployStepSpec[] = [
  { id: 'preflight', title: 'Preflight', phases: ['preflight'] },
  { id: 'plan', title: 'Plano', phases: ['plan'] },
  { id: 'tests', title: 'Testes', phases: ['tests'] },
  { id: 'tag', title: 'Tag da release', phases: ['publish_release_tag'] },
  { id: 'images', title: 'Imagens', phases: ['publish_images'] },
  { id: 'workers-prep', title: 'Workers (preparação)', phases: ['workers_preflight', 'prepare_workers', 'typesense', 'workers_typesense'] },
  { id: 'systems', title: 'Sistemas', phases: ['prepare_systems', 'deploy_systems'] },
  { id: 'workers', title: 'Workers', phases: ['workers_hybrid', 'workers_strict'] },
  { id: 'validation', title: 'Validação', phases: ['validation'] },
  { id: 'conclusion', title: 'Conclusão', phases: ['conclusion'] }
]

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Lê e valida o manifesto; erros vêm em linguagem de usuário, para a tela mostrar */
export function parseDeployManifest(text: string): DeployManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('O arquivo .ovseer/deploy.json não é um JSON válido.')
  }
  if (!isRecord(raw) || raw.ovseer !== 'deploy') throw new Error('O arquivo .ovseer/deploy.json precisa ter "ovseer": "deploy".')
  if (raw.version !== 1) throw new Error('Versão do .ovseer/deploy.json não suportada (esperada: 1).')
  if (raw.kind !== 'console' && raw.kind !== 'script') throw new Error(`Tipo de deploy não suportado: ${String(raw.kind)} (esperado: "console" ou "script").`)
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Deploy'
  const parseSteps = (required: boolean): DeployStepSpec[] | null => {
    if (raw.steps === undefined) {
      if (required) throw new Error('O .ovseer/deploy.json de tipo "script" precisa da lista "steps" (id e title de cada etapa).')
      return null
    }
    if (!Array.isArray(raw.steps) || !raw.steps.length) throw new Error('"steps" do .ovseer/deploy.json precisa ser uma lista com pelo menos uma etapa.')
    const steps = raw.steps.map((s, i) => {
      const phasesOk = s && typeof s === 'object' && 'phases' in s ? Array.isArray((s as { phases: unknown }).phases) && ((s as { phases: unknown[] }).phases).every((p) => typeof p === 'string') : true
      if (!isRecord(s) || typeof s.id !== 'string' || !/^[a-z0-9_-]+$/i.test(s.id) || typeof s.title !== 'string' || !phasesOk) {
        throw new Error(`Etapa ${i + 1} do .ovseer/deploy.json precisa de "id" (letras, números, - e _), "title" e, se houver, "phases".`)
      }
      return { id: s.id, title: s.title, phases: Array.isArray(s.phases) ? (s.phases as string[]) : [s.id] }
    })
    if (new Set(steps.map((st) => st.id)).size !== steps.length) throw new Error('As etapas do .ovseer/deploy.json têm "id" repetido.')
    return steps
  }
  if (raw.kind === 'script') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error('O .ovseer/deploy.json de tipo "script" precisa do "command" do deploy.')
    const command = raw.command.trim()
    let targets: DeployTargetSpec[] | undefined
    if (raw.targets !== undefined) {
      if (!Array.isArray(raw.targets) || !raw.targets.length) throw new Error('"targets" do .ovseer/deploy.json precisa ser uma lista com pelo menos um alvo.')
      targets = raw.targets.map((t, i) => {
        if (!isRecord(t) || typeof t.id !== 'string' || !/^[a-z0-9_-]+$/i.test(t.id) || typeof t.title !== 'string' || !t.title.trim()) {
          throw new Error(`Alvo ${i + 1} do .ovseer/deploy.json precisa de "id" (letras, números, - e _) e "title".`)
        }
        return { id: t.id, title: t.title.trim() }
      })
      if (new Set(targets.map((t) => t.id)).size !== targets.length) throw new Error('Os alvos do .ovseer/deploy.json têm "id" repetido.')
      if (!command.includes('{target}')) throw new Error('Com "targets", o "command" do .ovseer/deploy.json precisa conter {target}.')
    } else if (command.includes('{target}')) {
      throw new Error('O "command" usa {target}, mas o .ovseer/deploy.json não declara "targets".')
    }
    return { ovseer: 'deploy', version: 1, kind: 'script', name, command, steps: parseSteps(true)!, ...(targets ? { targets } : {}) }
  }
  if (typeof raw.start !== 'string' || !raw.start.trim()) throw new Error('O .ovseer/deploy.json precisa do comando "start" que sobe o console.')
  const port = Number(raw.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A "port" do .ovseer/deploy.json precisa ser um inteiro entre 1024 e 65535.')
  return { ovseer: 'deploy', version: 1, kind: 'console', name, start: raw.start.trim(), port, steps: parseSteps(false) ?? DEFAULT_CONSOLE_STEPS }
}

// ---------- o que a API do console devolve ----------

export type DeployPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface DeployPhase {
  status: DeployPhaseStatus | string
  started_at?: string
  completed_at?: string
  failed_at?: string
  error?: string
  result?: Record<string, unknown>
}

export interface DeployTestGroup {
  file: string
  total: number
  passed: number
  failed: number
}

export interface DeployRelease {
  tag: string
  /** Alvo escolhido (deploy por script com targets) */
  target?: string
  /** validating, running, failed, critical_passed, completed… (status efetivo calculado pelo console) */
  status: string
  commit?: string
  operator_arn?: string
  previous_tag?: string
  created_at?: string
  updated_at?: string
  effective_strategy?: string
  typesense_first?: boolean
  failure_phase?: string
  failure_detail?: string
  phases: Record<string, DeployPhase>
}

export interface DeployOperation {
  operation_id: string
  name: string
  started_at: string
  release_tag: string
  cancellable: boolean
  cancel_requested_at?: string
}

export interface DeployLockHolder {
  tag?: string
  operation?: string
  host?: string
  user?: string
  pid?: number
  acquired_at?: string
  status?: string
}

export interface DeployLock {
  status: 'free' | 'active'
  stale: boolean
  location: string
  lock: DeployLockHolder | null
  checked_at: string
}

export interface DeployPlanResult {
  plan_id: string
  plan: {
    tag: string
    target?: string
    commit: string
    previous_tag: string
    order: string
    plan?: { build?: { backend?: boolean; frontend?: boolean }; reasons?: string[]; warnings?: string[] }
  }
}

/** Estado do deploy de um repositório, como o menu mostra */
export interface DeploySnapshot {
  /** Console local: parado, subindo (o serviço já roda mas ainda não responde), pronto ou com erro */
  console: 'stopped' | 'starting' | 'ready' | 'error'
  error?: string
  /** Serviço que sobe o console: o cadastrado (registered) ou o que o app propõe cadastrar */
  service?: { registered: boolean; name: string; command: string; cwd: string }
  /** Há trava compartilhada para consultar (só o adaptador console tem) */
  lockSupported: boolean
  /** Endereço do console, para abrir no navegador */
  origin: string
  operation: DeployOperation | null
  releases: DeployRelease[]
  /** Última release (com detalhes: progresso dos testes e motivo da falha) */
  current: DeployRelease | null
  expectedTests: number
}

/** Último estado de deploy de cada projeto recente com manifesto. */
export interface DeployOverviewEntry {
  root: string
  manifest: DeployManifest
  snapshot: DeploySnapshot
}

// ---------- etapas numeradas ----------

export interface DeploySubStep {
  id: string
  title: string
  status: DeployPhaseStatus
  detail: string
}

export interface DeployStepView {
  id: string
  index: number
  title: string
  status: DeployPhaseStatus
  /** Fases do motor que já têm registro, para abrir o log */
  phases: string[]
  startedAt?: string
  endedAt?: string
  detail: string
  error?: string
  subs: DeploySubStep[]
}

const ORDER: DeployPhaseStatus[] = ['pending', 'skipped', 'completed', 'running', 'failed']

function stepStatus(phases: DeployPhase[], specCount: number): DeployPhaseStatus {
  if (!phases.length) return 'pending'
  if (phases.some((p) => p.status === 'failed')) return 'failed'
  if (phases.some((p) => p.status === 'running')) return 'running'
  const done = phases.filter((p) => p.status === 'completed' || p.status === 'skipped')
  if (done.length === phases.length) {
    if (phases.every((p) => p.status === 'skipped')) return 'skipped'
    // uma fase ainda sem registro depois de outra concluída: a etapa está no meio do caminho
    return phases.length < specCount && phases.some((p) => p.status === 'completed') && !phases.some((p) => p.status === 'skipped') ? 'running' : 'completed'
  }
  return 'pending'
}

const groupName = (file: string) => file.replace(/\.tap$/, '')

function testsDetail(result: Record<string, unknown> | undefined, phaseStatus?: string): { detail: string; subs: DeploySubStep[] } {
  if (!result) return { detail: '', subs: [] }
  const total = Number(result.total ?? 0)
  const passed = Number(result.passed ?? 0)
  const failed = Number(result.failed ?? 0)
  const groups = Array.isArray(result.groups) ? (result.groups as DeployTestGroup[]) : []
  const subs: DeploySubStep[] = groups.map((g) => ({
    id: g.file,
    title: groupName(g.file),
    status: g.failed > 0 ? 'failed' : g.passed >= g.total && g.total > 0 ? 'completed' : phaseStatus === 'completed' ? 'completed' : phaseStatus === 'failed' ? 'failed' : 'running',
    detail: `${g.passed} / ${g.total}${g.failed ? ` · ${g.failed} falhas` : ''}`
  }))
  const detail = total ? `${passed} / ${total} · ${failed} ${failed === 1 ? 'falha' : 'falhas'}` : ''
  return { detail, subs }
}

/** Monta as etapas numeradas de uma release (ou todas pendentes, sem release) */
export function buildDeploySteps(manifest: DeployManifest, release: DeployRelease | null): DeployStepView[] {
  return manifest.steps.map((spec, i) => {
    const present = spec.phases.map((name) => [name, release?.phases?.[name]] as const).filter((e): e is readonly [string, DeployPhase] => !!e[1])
    const phases = present.map(([, p]) => p)
    let status = stepStatus(phases, spec.phases.length)
    // release que já não roda (falhou, orquestração interrompida) não pode ter etapa "em andamento"
    if (status === 'running' && release && !isLiveRelease(release)) status = 'failed'
    const starts = phases.map((p) => p.started_at).filter((s): s is string => !!s).sort()
    const ends = phases.map((p) => p.completed_at ?? p.failed_at).filter((s): s is string => !!s).sort()
    const failed = phases.find((p) => p.status === 'failed')
    let detail = ''
    let subs: DeploySubStep[] = []
    if (spec.phases.includes('tests')) {
      const t = testsDetail(release?.phases?.tests?.result, release?.phases?.tests?.status)
      detail = t.detail
      subs = t.subs
    } else if (status === 'skipped') {
      const reason = phases.map((p) => p.result?.reason).find((r): r is string => typeof r === 'string')
      detail = reason ?? 'pulada'
    }
    return {
      id: spec.id,
      index: i + 1,
      title: spec.title,
      status,
      phases: present.map(([name]) => name),
      startedAt: starts[0],
      endedAt: status === 'running' ? undefined : ends[ends.length - 1],
      detail,
      error: failed?.error,
      subs
    }
  })
}

/** Falha da release, inclusive quando aconteceu fora das etapas declaradas no manifesto. */
export function releaseFailure(release: DeployRelease | null, steps: DeployStepView[]): { title: string; detail: string } | null {
  if (release?.status !== 'failed') return null
  const phase = release.failure_phase || Object.entries(release.phases).find(([, p]) => p.status === 'failed')?.[0]
  const step = phase ? steps.find((s) => s.phases.includes(phase)) : steps.find((s) => s.status === 'failed')
  const title = step?.title ?? (phase === 'orquestracao_local' ? 'Orquestração local' : phase?.replace(/[_-]/g, ' ') || 'etapa não identificada')
  const detail = release.failure_detail?.trim() || step?.error?.trim() || 'O console não registrou o motivo da falha.'
  return { title, detail }
}

/** Maior status entre as etapas, para o ponto do botão: falhou > em andamento > concluído > nada */
export function overallStatus(steps: DeployStepView[]): DeployPhaseStatus {
  return steps.reduce<DeployPhaseStatus>((acc, s) => (ORDER.indexOf(s.status) > ORDER.indexOf(acc) ? s.status : acc), 'pending')
}

/** Release terminou bem: gate crítico aprovado ou concluída */
export const isSuccessfulRelease = (r: DeployRelease | null) => !!r && (r.status === 'completed' || r.status === 'critical_passed')
export const isLiveRelease = (r: DeployRelease | null) => !!r && (r.status === 'running' || r.status === 'validating')

export function releaseStatusLabel(status: string): string {
  switch (status) {
    case 'validating': return 'Validando'
    case 'running': return 'Em andamento'
    case 'failed': return 'Falhou'
    case 'critical_passed': return 'Gate crítico aprovado'
    case 'completed': return 'Concluído'
    default: return status
  }
}

/** mm:ss, ou hh:mm:ss a partir de uma hora */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return h ? `${String(h).padStart(2, '0')}:${mm}` : mm
}

/** Linha da trava: quem está com ela e desde quando, em hora local */
export function lockLine(lock: DeployLock, now = Date.now()): string {
  if (lock.status !== 'active' || !lock.lock) return 'Nenhum deploy em andamento em outro computador.'
  const l = lock.lock
  const since = l.acquired_at ? Date.parse(l.acquired_at) : NaN
  const ago = Number.isFinite(since) ? ` há ${formatDuration(now - since)}` : ''
  const op = l.operation === 'resume' ? 'Retomada' : l.operation === 'rollback' ? 'Rollback' : 'Deploy'
  return `${op} de ${l.tag ?? '?'} em andamento no computador ${l.host ?? '?'} (${l.user ?? '?'})${ago}${lock.stale ? ' · possivelmente abandonado' : ''}`
}
