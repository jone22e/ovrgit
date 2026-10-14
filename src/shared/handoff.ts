import type { AgentTurn } from './types'
import { summaryOf } from './summary'
import { CONTINUE_REQUEST } from './autoRetry'

/**
 * "Nova conversa a partir desta": a nova começa com um contexto curto da anterior, não a transcrição toda.
 * O resumo automático (sem IA) entra na hora; a transcrição condensada vai para a IA refinar em segundo plano.
 * O texto final vai escondido com a primeira mensagem da conversa nova.
 */

/** Numa linha só, cortado em `max` */
const one = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const isContinue = (s: string) => s.trim() === CONTINUE_REQUEST
/** O que o agente escreveu na vez (sem o plano, que é um arquivo dele) */
const answerText = (t: AgentTurn) => t.blocks.flatMap((b) => (b.kind === 'text' && !b.plan ? [b.text] : [])).join('\n\n')
const filesOf = (t: AgentTurn) => t.blocks.flatMap((b) => (b.kind === 'files' ? b.paths : []))

/** Resumo automático: pedidos do usuário, arquivos alterados e onde parou. Serve enquanto a IA não resume, ou se ela falhar. */
export function handoffDigest(turns: AgentTurn[]): string {
  const asked = turns.filter((t) => !t.silent && t.user.trim() && !isContinue(t.user))
  const lines: string[] = []
  if (asked[0]) lines.push(`Pedido inicial: ${one(asked[0].user, 300)}`)
  const rest = asked.slice(1)
  if (rest.length) lines.push(`Pedidos seguintes: ${rest.slice(-4).map((t) => one(t.user, 120)).join(' · ')}`)
  const files = [...new Set(turns.flatMap(filesOf))]
  if (files.length) lines.push(`Arquivos alterados: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` e mais ${files.length - 12}` : ''}`)
  const last = [...turns].reverse().find((t) => answerText(t).trim())
  const end = last ? summaryOf(answerText(last), 300) : ''
  if (end) lines.push(`Onde parou: ${end}`)
  const tail = turns[turns.length - 1]
  if (tail?.error) lines.push(`A última resposta falhou: ${one(tail.error, 160)}`)
  return lines.join('\n')
}

/** Transcrição condensada para a IA resumir: cada vez numa linha por lado; passou do limite, corta do começo (o fim pesa mais) */
export function handoffTranscript(turns: AgentTurn[], max = 8000): string {
  const parts = turns.flatMap((t) => {
    const out: string[] = []
    if (!t.silent && t.user.trim()) out.push(`Usuário: ${one(t.user, 600)}`)
    const a = answerText(t)
    if (a.trim()) out.push(`Agente: ${one(a, 900)}`)
    const files = [...new Set(filesOf(t))]
    if (files.length) out.push(`Arquivos alterados: ${files.slice(0, 15).join(', ')}`)
    if (t.error) out.push(`(falhou: ${one(t.error, 120)})`)
    return out.length ? [out.join('\n')] : []
  })
  const text = parts.join('\n\n')
  return text.length > max ? `…${text.slice(-max)}` : text
}

/** O que vai escondido com a primeira mensagem da conversa nova */
export function handoffPreamble(text: string, from?: string): string {
  const where = from ? ` (“${from}”)` : ''
  return `Esta conversa é nova, mas dá sequência a outra, já encerrada${where}. O que foi feito lá, em resumo, para você usar como referência (não refaça nem repita):\n\n${text.trim()}`
}
