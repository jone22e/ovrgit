/**
 * Resumo de uma resposta do agente para o gerenciador: um parágrafo que se sustente sozinho. Pula títulos,
 * frases de abertura que terminam em ":" ("Ao clicar em Salvar:") e trechos curtos demais; listas viram itens
 * separados por " · ". Prefere um parágrafo corrido; sem nenhum, a lista; sem nada, o primeiro trecho.
 */
export function summaryOf(text: string, max = 240): string {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^#{1,6}\s/.test(p))
  const isList = (p: string) => /^\s*(?:[-*+]|\d+[.)])\s/m.test(p)
  const clean = (p: string) =>
    p
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
      .join(isList(p) ? ' · ' : ' ')
      .replace(/[*`_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const lines = paras.map(clean)
  const standalone = (l: string) => !/[:：]$/.test(l) && l.length >= 25
  const idx = lines.findIndex((l, i) => standalone(l) && !isList(paras[i]))
  const pick = idx >= 0 ? lines[idx] : (lines.find(standalone) ?? lines[0] ?? '')
  return pick.length > max ? `${pick.slice(0, max - 3)}…` : pick
}
