import type { AgentMode } from './types'

/**
 * Modo "Plano com Checklist": o plano termina com uma seção de checklist; ao aprovar, o app acompanha a
 * implementação marcando cada item quando o agente avisa que o concluiu.
 */

export const isPlanMode = (m: AgentMode | undefined) => m === 'plan' || m === 'checklist'

export interface ChecklistItem {
  text: string
  /** Etapa encerrada: concluída ou dispensada (ver `state`) */
  done: boolean
  /** `failed`: o agente tentou e não conseguiu; `skipped`: dispensada (deixou de ser necessária, ou o usuário dispensou) */
  state?: 'failed' | 'skipped'
  /** Motivo dado pelo agente ao falhar ou dispensar */
  note?: string
}

/** Instrução ao agente no modo Plano com Checklist: como terminar o plano */
export const CHECKLIST_FORMAT =
  'O plano deve terminar com uma seção "## Checklist": a lista dos passos de execução, na ordem, um por linha no formato "- [ ] passo" (de 3 a 12 itens, cada um uma ação concreta e verificável, curta). Nada depois dessa seção.'

/** Como o agente avisa o andamento de cada item, e a regra de não terminar com item em aberto */
const MARKERS_RULE =
  'Assim que concluir um item, escreva numa linha própria, exatamente, "[ok] N" (N é o número do item, começando em 1). Se um item não puder ser feito, escreva "[falhou] N — motivo". Se um item deixou de ser necessário (já estava feito, foi substituído, o usuário desistiu dele), escreva "[pulado] N — motivo". Não marque um item antes de ele estar resolvido. Não termine a resposta com itens em aberto sem dizer por quê: se um item depende de uma decisão ou autorização do usuário, pergunte (formato de perguntas ao usuário) em vez de simplesmente parar.'

/** Instrução ao implementar: seguir o checklist e marcar cada item */
export const CHECKLIST_PROGRESS = `Siga o checklist do plano na ordem. ${MARKERS_RULE}`

/**
 * Lembrete que acompanha as mensagens seguintes enquanto o checklist tem itens em aberto: o agente vê o que
 * falta (com os números) e como marcar, em vez de encerrar a conversa deixando etapas sem resposta.
 */
export function checklistReminder(items: ChecklistItem[]): string {
  const open = items.map((it, i) => ({ it, n: i + 1 })).filter(({ it }) => !it.done)
  if (!open.length) return ''
  return `<checklist_pendente>
O checklist do plano ainda tem itens em aberto:
${open.map(({ it, n }) => `${n}. ${it.text}${it.state === 'failed' ? ' (falhou antes)' : ''}`).join('\n')}
${MARKERS_RULE}
</checklist_pendente>`
}

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

const NUM = '(?:item\\s*|etapa\\s*|passo\\s*)?#?(\\d{1,2})\\b'
const NOTE = '[ \\t]*(?:[—–:-][ \\t]*)?([^\\n]*)'
const DONE_RE = new RegExp(`^\\s*(?:\\[(?:ok|x|concluído|concluido|done)\\]|✅)\\s*${NUM}`, 'gim')
const FAILED_RE = new RegExp(`^\\s*(?:\\[(?:falhou|erro|failed)\\]|❌)\\s*${NUM}${NOTE}`, 'gim')
const SKIPPED_RE = new RegExp(`^\\s*\\[(?:pulado|pulada|dispensado|dispensada|skipped|n/a)\\]\\s*${NUM}${NOTE}`, 'gim')

/** Números dos itens que o texto do agente marcou ("[ok] 3", "[x] 3", "✅ 3", "[falhou] 4", "[pulado] 5 — motivo") */
export function doneMarkers(text: string): { done: number[]; failed: number[]; skipped: number[]; notes: Record<number, string> } {
  const done = new Set<number>()
  const failed = new Set<number>()
  const skipped = new Set<number>()
  const notes: Record<number, string> = {}
  for (const m of text.matchAll(DONE_RE)) done.add(Number(m[1]))
  for (const m of text.matchAll(FAILED_RE)) {
    failed.add(Number(m[1]))
    if (m[2]?.trim()) notes[Number(m[1])] = m[2].trim()
  }
  for (const m of text.matchAll(SKIPPED_RE)) {
    skipped.add(Number(m[1]))
    if (m[2]?.trim()) notes[Number(m[1])] = m[2].trim()
  }
  return { done: [...done], failed: [...failed], skipped: [...skipped], notes }
}

/**
 * Aplica ao checklist o que o texto do agente marcou até agora; devolve true se algo mudou.
 * Concluído vence os demais; dispensado encerra o item; falhou só anota (o item continua em aberto).
 */
export function applyMarkers(items: ChecklistItem[], text: string): boolean {
  const { done, failed, skipped, notes } = doneMarkers(text)
  let changed = false
  for (const n of done) {
    const it = items[n - 1]
    if (it && (!it.done || it.state)) {
      it.done = true
      delete it.state
      delete it.note
      changed = true
    }
  }
  for (const n of skipped) {
    const it = items[n - 1]
    if (it && !it.done) {
      it.done = true
      it.state = 'skipped'
      if (notes[n]) it.note = notes[n]
      changed = true
    }
  }
  for (const n of failed) {
    const it = items[n - 1]
    if (it && !it.done && it.state !== 'failed') {
      it.state = 'failed'
      if (notes[n]) it.note = notes[n]
      changed = true
    }
  }
  return changed
}
