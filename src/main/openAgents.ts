import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentChatOpen, AgentEffort, AgentMode, AgentWindowInfo, CliProvider } from '../shared/types'
import { DEFAULT_EFFORT, EFFORTS } from '../shared/models'

/**
 * Agentes abertos: um retrato gravado em disco a cada mudança (e congelado quando o app começa a fechar), para
 * reabrir tudo como estava na próxima vez. Cada conversa volta retomada pela sessão do CLI, os agentes em espera
 * voltam prontos para a fila, e a conversa que ocupava a área do orquestrador volta a ela.
 */
export interface OpenAgent {
  provider: CliProvider
  model: string
  effort: AgentEffort
  mode: AgentMode
  cwd: string
  extraDirs?: string[]
  /** Sessão do CLI, para retomar a conversa (ausente: agente ainda sem conversa, ex.: em espera) */
  sessionId?: string
  standby?: boolean
  /** Escondida, em segundo plano (ex.: começada pelo mascote) */
  hidden?: boolean
  /** Ocupava a área da conversa no orquestrador */
  docked?: boolean
}

const MAX_AGENTS = 24
const SESSION_ID = /^[\w-]{8,80}$/
const PROVIDERS = new Set<CliProvider>(['claude', 'codex', 'agy'])

const file = () => path.join(app.getPath('userData'), 'open-agents.json')

/** O retrato de um agente aberto, a partir do que o processo principal sabe dele */
export function toOpenAgent(info: AgentWindowInfo, o: { docked: boolean; hidden: boolean }): OpenAgent {
  const a: OpenAgent = { provider: info.provider, model: info.model, effort: info.effort, mode: info.mode, cwd: info.cwd }
  if (info.extraDirs?.length) a.extraDirs = info.extraDirs
  if (info.sessionId) a.sessionId = info.sessionId
  if (info.standby) a.standby = true
  if (o.hidden) a.hidden = true
  if (o.docked) a.docked = true
  return a
}

/**
 * Pedido de abertura que recria o agente: retoma a sessão, em espera se era, escondido se estava. Nasce quieto
 * (sem tomar a área nem o foco), a não ser o que ocupava a área do orquestrador, que volta a ela.
 */
export function reopenRequest(a: OpenAgent, orchestrator: boolean): AgentChatOpen {
  return {
    provider: a.provider,
    model: a.model,
    effort: a.effort,
    mode: a.mode,
    cwd: a.cwd,
    extraDirs: a.extraDirs,
    resumeId: a.sessionId,
    standby: !!a.standby,
    hidden: !!a.hidden,
    quiet: !(orchestrator && a.docked)
  }
}

/** Lê o retrato gravado, descartando o que não serve: pasta que não existe mais, IA desconhecida, campos inválidos */
export function parseSnapshot(raw: string, exists: (p: string) => boolean = existsSync): OpenAgent[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray((data as { agents?: unknown })?.agents) ? ((data as { agents: unknown[] }).agents as Partial<OpenAgent>[]) : []
  const out: OpenAgent[] = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const provider = x.provider as CliProvider
    if (!PROVIDERS.has(provider) || typeof x.cwd !== 'string' || !x.cwd || !exists(x.cwd)) continue
    const effort = EFFORTS[provider].some((e) => e.id === x.effort) ? (x.effort as AgentEffort) : DEFAULT_EFFORT[provider]
    const a: OpenAgent = { provider, model: typeof x.model === 'string' ? x.model.slice(0, 80) : '', effort, mode: x.mode as AgentMode, cwd: x.cwd }
    const extra = Array.isArray(x.extraDirs) ? x.extraDirs.filter((d): d is string => typeof d === 'string' && d !== a.cwd && exists(d)).slice(0, 12) : []
    if (extra.length) a.extraDirs = extra
    if (typeof x.sessionId === 'string' && SESSION_ID.test(x.sessionId)) a.sessionId = x.sessionId
    if (x.standby === true) a.standby = true
    if (x.hidden === true) a.hidden = true
    if (x.docked === true && !out.some((o) => o.docked)) a.docked = true
    out.push(a)
    if (out.length >= MAX_AGENTS) break
  }
  return out
}

export function readOpenAgents(): OpenAgent[] {
  try {
    return parseSnapshot(readFileSync(file(), 'utf8'))
  } catch {
    return []
  }
}

/** Grava em arquivo temporário e renomeia, para não corromper o retrato se o app fechar no meio */
export function writeOpenAgents(agents: OpenAgent[]) {
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), agents }, null, 2))
    renameSync(tmp, file())
  } catch (e) {
    console.error('Agentes abertos: não consegui gravar o retrato:', (e as Error).message)
  }
}
