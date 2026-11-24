import { nextTick, ref } from 'vue'

type Box = { x: number; y: number; width: number; height: number }
type DockApi = {
  dockSnapshot(): Promise<string | null>
  orchestratorArea(area: Box | null): void
}

/** A vista nativa fica acima do HTML: precisa sair quando algo cobre a área da conversa. */
export function dockCovered(el: HTMLElement, r: DOMRect): boolean {
  if (document.querySelector('.backdrop, .overlay-backdrop')) return true
  // Um menu pode cobrir só alguns pixels da borda, entre os pontos da amostragem.
  // Teste também dentro da interseção real dos menus e painéis flutuantes.
  const overlays = document.querySelectorAll<HTMLElement>(
    '.pop, .menu, [role="menu"], [role="dialog"], [role="listbox"], .repo-select-pop, .panel-backdrop, .toast, .voice-shade'
  )
  for (const overlay of overlays) {
    if (el.contains(overlay)) continue
    const b = overlay.getBoundingClientRect()
    const left = Math.max(r.left, b.left)
    const top = Math.max(r.top, b.top)
    const right = Math.min(r.right, b.right)
    const bottom = Math.min(r.bottom, b.bottom)
    if (right <= left || bottom <= top) continue
    // O hit-test descarta menus escondidos, recortados ou atrás da própria área.
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
    if (hit && !el.contains(hit)) return true
  }
  const step = 56
  for (let y = r.top + 6; y < r.bottom; y += step) {
    for (let x = r.left + 8; x < r.right; x += step) {
      const top = document.elementFromPoint(Math.min(x, r.right - 4), Math.min(y, r.bottom - 4))
      if (top && !el.contains(top)) return true
    }
  }
  return false
}

/** Troca a vista por uma foto enquanto um menu ou diálogo a cobre, sem mover a conversa. */
export function useDockVisibility(api: DockApi) {
  const frozen = ref<string | null>(null)
  let wantFrozen = false
  let freezing = false
  let disposed = false
  let unfreezeTimer: ReturnType<typeof setTimeout> | undefined

  async function freeze() {
    if (disposed) return
    wantFrozen = true
    clearTimeout(unfreezeTimer)
    // Ao reabrir em menos de 80 ms, a foto ainda existe, mas unfreeze já mostrou a vista.
    if (frozen.value) return api.orchestratorArea(null)
    if (freezing) return
    freezing = true
    try {
      const snap = await api.dockSnapshot().catch(() => null)
      // O menu pode ter fechado ou o gerenciador desmontado enquanto a foto era tirada.
      if (!wantFrozen) return
      frozen.value = snap
      await nextTick()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (wantFrozen) api.orchestratorArea(null)
    } finally {
      freezing = false
    }
  }

  function unfreeze(rect: Box) {
    if (disposed) return
    wantFrozen = false
    api.orchestratorArea(rect)
    clearTimeout(unfreezeTimer)
    unfreezeTimer = setTimeout(() => (frozen.value = null), 80)
  }

  function dispose() {
    disposed = true
    wantFrozen = false
    clearTimeout(unfreezeTimer)
    api.orchestratorArea(null)
  }

  return { frozen, freeze, unfreeze, dispose }
}
