import type { AgentMode } from './types'

/**
 * Modo "Plano com Checklist": o plano termina com uma seção de checklist; ao aprovar, o app acompanha a
 * implementação marcando cada item quando o agente avisa que o concluiu.
 */

export const isPlanMode = (m: AgentMode | undefined) => m === 'plan' || m === 'checklist'

export interface ChecklistItem {
  text: string
  done: boolean
}

/** Instrução ao agente no modo Plano com Checklist: como terminar o plano */
export const CHECKLIST_FORMAT =
  'O plano deve terminar com uma seção "## Checklist": a lista dos passos de execução, na ordem, um por linha no formato "- [ ] passo" (de 3 a 12 itens, cada um uma ação concreta e verificável, curta). Nada depois dessa seção.'

/** Instrução ao implementar: como avisar que concluiu cada item */
export const CHECKLIST_PROGRESS =
  'Siga o checklist do plano na ordem. Assim que concluir cada item, escreva numa linha própria, exatamente, "[ok] N" (N é o número do item, começando em 1) e só então continue. Se um item não puder ser feito, escreva "[falhou] N" e explique. Não marque um item antes de ele estar pronto.'

/** Itens da seção "## Checklist" do plano (ou, sem a seção, os "- [ ]" do fim do texto) */
export function parseChecklist(plan: string): ChecklistItem[] {
  const text = plan.replace(/\r/g, '')
  const m = /^#{1,6}\s*checklist\b[^\n]*\n([\s\S]*)$/im.exec(text)
  const body = m ? m[1].split(/\n#{1,6}\s/)[0] : text
  const items: ChecklistItem[] = []
  for (const line of body.split('\n')) {
    const it = /^\s*(?:[-*+]|\d+[.)])\s*\[( |x|X)\]\s+(.+?)\s*$/.exec(line)
    if (it) items.push({ text: it[2].replace(/\s+/g, ' '), done: it[1] !== ' ' })
  }
  // sem a seção: só vale se o texto todo tiver uma lista de caixas (senão não é um checklist)
  return m || items.length >= 2 ? items : []
}

/** Números dos itens que o texto do agente marcou como concluídos ("[ok] 3", "[x] 3", "✅ 3") */
export function doneMarkers(text: string): { done: number[]; failed: number[] } {
  const done = new Set<number>()
  const failed = new Set<number>()
  for (const m of text.matchAll(/^\s*(?:\[(ok|x|X|concluído|concluido|done)\]|✅)\s*(?:item\s*|etapa\s*|passo\s*)?#?(\d{1,2})\b/gim)) done.add(Number(m[2]))
  for (const m of text.matchAll(/^\s*(?:\[(falhou|erro|failed)\]|❌)\s*(?:item\s*|etapa\s*|passo\s*)?#?(\d{1,2})\b/gim)) failed.add(Number(m[2]))
  return { done: [...done], failed: [...failed] }
}

/** Marca no checklist o que o texto do agente concluiu até agora; devolve true se algo mudou */
export function applyMarkers(items: ChecklistItem[], text: string): boolean {
  const { done } = doneMarkers(text)
  let changed = false
  for (const n of done) {
    const it = items[n - 1]
    if (it && !it.done) {
      it.done = true
      changed = true
    }
  }
  return changed
}
