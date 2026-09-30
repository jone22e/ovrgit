import { DEFAULT_EFFORT, DEFAULT_MODEL } from '@shared/models'
import type { AgentEffort, AgentMode, CliProvider } from '@shared/types'

/** Última escolha do diálogo "Novo agente" (IA, modelo e esforço de cada uma, modo): vale também para despachar
 * uma tarefa direto pelo gerenciador de agentes */
export const AGENT_PREFS = 'ovseer.agent.prefs'
export interface AgentPrefs {
  provider: CliProvider
  model: Record<CliProvider, string>
  effort: Record<CliProvider, AgentEffort>
  mode: AgentMode
}
export function readAgentPrefs(): AgentPrefs {
  const base: AgentPrefs = { provider: 'codex', model: { ...DEFAULT_MODEL }, effort: { ...DEFAULT_EFFORT }, mode: 'safe' }
  try {
    const saved = JSON.parse(localStorage.getItem(AGENT_PREFS) ?? '{}') as Partial<AgentPrefs>
    return { ...base, ...saved, model: { ...base.model, ...saved.model }, effort: { ...base.effort, ...saved.effort } }
  } catch {
    return base
  }
}
