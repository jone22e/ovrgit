/**
 * Balões e sobreposições com a conversa encaixada do orquestrador ao lado. A conversa é uma vista nativa, sempre por
 * cima da página: o que a cobrir fica escondido embaixo dela, e o gerenciador então a esconde ou recorta. O jeito é
 * não a cobrir: o gerenciador publica a largura da área em `--dock-w`, e quem abre um balão se mantém à esquerda dela.
 */

/** Largura da conversa encaixada (0: não há, ou está escondida) */
export const dockWidth = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-w')) || 0

/** Um balão ancorado à direita do seu chip (`position: absolute; right: 0`) é empurrado para a esquerda até sair da área */
export function keepOutOfDock(el: HTMLElement | undefined | null, margin = 8) {
  if (!el) return
  el.style.right = ''
  const dock = dockWidth()
  if (!dock) return
  const limit = window.innerWidth - dock - margin
  const r = el.getBoundingClientRect()
  if (r.right <= limit) return
  // não empurra para fora da janela pela esquerda
  el.style.right = `${Math.min(r.right - limit, Math.max(0, r.left - margin))}px`
}
