import { DEFAULT_EFFORT, DEFAULT_MODEL, MODES } from '@shared/models'
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
/** Modo rápido do Codex (cerca de 1,5x mais rápido, gastando mais do limite): vale para todas as conversas; começa desligado */
const CODEX_FAST = 'ovseer.agent.codexFast'
export function readCodexFast(): boolean {
  try {
    return localStorage.getItem(CODEX_FAST) === '1'
  } catch {
    return false
  }
}
export function writeCodexFast(on: boolean) {
  localStorage.setItem(CODEX_FAST, on ? '1' : '0')
}
export function readAgentPrefs(): AgentPrefs {
  const base: AgentPrefs = { provider: 'codex', model: { ...DEFAULT_MODEL }, effort: { ...DEFAULT_EFFORT }, mode: 'full' }
  try {
    const saved = JSON.parse(localStorage.getItem(AGENT_PREFS) ?? '{}') as Partial<AgentPrefs>
    // um modo que não existe mais (o antigo "Só edições") volta ao padrão
    const mode = MODES.some((m) => m.id === saved.mode) ? saved.mode! : base.mode
    return { ...base, ...saved, mode, model: { ...base.model, ...saved.model }, effort: { ...base.effort, ...saved.effort } }
  } catch {
    return base
  }
}
