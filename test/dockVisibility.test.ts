import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dockCovered, useDockVisibility } from '../src/renderer/src/dockVisibility'

const area = { x: 600, y: 97, width: 400, height: 600 }
const rect = (left: number, top: number, width: number, height: number) => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height
}) as DOMRect

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(snapshot: () => Promise<string | null> = () => Promise.resolve('foto')) {
  const api = { dockSnapshot: vi.fn(snapshot), orchestratorArea: vi.fn() }
  return { api, ...useDockVisibility(api) }
}

describe('menus sobre a conversa encaixada', () => {
  it('esconde novamente a vista ao reabrir um menu antes de a foto sair', async () => {
    const dock = setup()
    const first = dock.freeze()
    await vi.advanceTimersByTimeAsync(16)
    await first
    expect(dock.api.orchestratorArea).toHaveBeenLastCalledWith(null)

    dock.unfreeze(area)
    await vi.advanceTimersByTimeAsync(40)
    expect(dock.api.orchestratorArea).toHaveBeenLastCalledWith(area)
    await dock.freeze()
    expect(dock.api.orchestratorArea).toHaveBeenLastCalledWith(null)
    expect(dock.api.dockSnapshot).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(dock.frozen.value).toBe('foto')

    dock.unfreeze(area)
    await vi.advanceTimersByTimeAsync(80)
    expect(dock.frozen.value).toBeNull()
    dock.dispose()
  })

  it('não esconde a conversa se o menu fechar antes da captura terminar', async () => {
    let finish!: (image: string | null) => void
    const dock = setup(() => new Promise<string | null>((resolve) => (finish = resolve)))
    const freezing = dock.freeze()
    dock.unfreeze(area)
    finish('foto atrasada')
    await freezing
    expect(dock.frozen.value).toBeNull()
    expect(dock.api.orchestratorArea).toHaveBeenLastCalledWith(area)
    dock.dispose()
  })

  it('libera o menu mesmo quando a captura falha', async () => {
    const dock = setup(() => Promise.reject(new Error('falha na captura')))
    const freezing = dock.freeze()
    await vi.advanceTimersByTimeAsync(16)
    await freezing
    expect(dock.frozen.value).toBeNull()
    expect(dock.api.orchestratorArea).toHaveBeenLastCalledWith(null)
    dock.dispose()
  })

  it('ignora uma captura que terminar depois de sair da aba de agentes', async () => {
    let finish!: (image: string | null) => void
    const dock = setup(() => new Promise<string | null>((resolve) => (finish = resolve)))
    const freezing = dock.freeze()
    dock.dispose()
    finish('foto atrasada')
    await freezing
    expect(dock.frozen.value).toBeNull()
    expect(dock.api.orchestratorArea).toHaveBeenCalledExactlyOnceWith(null)
  })
})

describe('detecção de sobreposição', () => {
  function scene(menuRect: DOMRect | null) {
    const dock = { contains: (node: unknown) => node === dock } as unknown as HTMLElement
    const menu = { getBoundingClientRect: () => menuRect } as unknown as HTMLElement
    const document = {
      querySelector: () => null,
      querySelectorAll: () => menuRect ? [menu] : [],
      elementFromPoint: (x: number, y: number) => menuRect && x >= menuRect.left && x < menuRect.right && y >= menuRect.top && y < menuRect.bottom ? menu : dock
    }
    vi.stubGlobal('document', document)
    return dock
  }

  it('detecta um menu cobrindo só a borda, entre os pontos da amostragem', () => {
    const dock = scene(rect(590, 120, 14, 180))
    expect(dockCovered(dock, rect(600, 97, 400, 600))).toBe(true)
  })

  it('mantém a vista interativa quando o menu não cruza a conversa', () => {
    const dock = scene(rect(100, 120, 400, 180))
    expect(dockCovered(dock, rect(600, 97, 400, 600))).toBe(false)
  })

  it('mantém a vista interativa sem menus abertos', () => {
    const dock = scene(null)
    expect(dockCovered(dock, rect(600, 97, 400, 600))).toBe(false)
  })

  it('ignora a caixa de um menu escondido ou atrás da conversa', () => {
    const dock = scene(rect(590, 120, 14, 180))
    document.elementFromPoint = () => dock
    expect(dockCovered(dock, rect(600, 97, 400, 600))).toBe(false)
  })
})
