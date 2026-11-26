import type { AgentBlock, AgentChatEvent } from './types'

export type SubagentStatus = 'live' | 'done' | 'error' | 'stopped'
export interface SubagentSummary {
  id: string
  parentId?: string
  name: string
  provider: 'claude' | 'codex'
  nativeId?: string
  status: SubagentStatus
  activity?: string
  createdAt: number
  updatedAt: number
}
export interface SubagentDetail extends SubagentSummary {
  prompt?: string
  requests?: string[]
  result?: string
  blocks: AgentBlock[]
}
export interface SubagentUpdate {
  id: string
  provider: 'claude' | 'codex'
  parentId?: string
  name?: string
  nativeId?: string
  prompt?: string
  result?: string
  status?: SubagentStatus
  activity?: string
  event?: Extract<AgentChatEvent, { type: 'text' | 'tool' | 'toolResult' | 'thinking' | 'done' }>
}

export const SUBAGENT_STATUS: Record<SubagentStatus, string> = {
  live: 'Trabalhando', done: 'Concluído', error: 'Falhou', stopped: 'Interrompido'
}

/** Pais desconhecidos ficam na raiz; ciclos não podem esconder nós ou recursar sem fim. */
export function subagentRows(list: SubagentSummary[], collapsed: Set<string> = new Set()): { agent: SubagentSummary; depth: number }[] {
  const rows: { agent: SubagentSummary; depth: number }[] = []
  const seen = new Set<string>()
  const ids = new Set(list.map((a) => a.id))
  function add(agent: SubagentSummary, depth: number) {
    if (seen.has(agent.id)) return
    seen.add(agent.id)
    rows.push({ agent, depth })
    const children = list.filter((a) => a.parentId === agent.id)
    if (collapsed.has(agent.id)) {
      const mark = (a: SubagentSummary) => {
        if (seen.has(a.id)) return
        seen.add(a.id)
        list.filter((x) => x.parentId === a.id).forEach(mark)
      }
      children.forEach(mark)
    } else children.forEach((a) => add(a, depth + 1))
  }
  list.filter((a) => !a.parentId || !ids.has(a.parentId)).forEach((a) => add(a, 0))
  list.filter((a) => !seen.has(a.id)).forEach((a) => add(a, 0))
  return rows
}
