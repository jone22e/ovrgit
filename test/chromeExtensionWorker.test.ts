import { afterEach, expect, it, vi } from 'vitest'
import { ChromeBridge } from '../src/main/chromeBridge'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('conecta automaticamente, acompanha mudanças de porta e respeita pausa e autorização das abas', async () => {
  const bridge = new ChromeBridge()
  const { connection } = await bridge.ready
  let currentConnection = connection
  const local: Record<string, unknown> = { connection: 'configuração manual antiga' }, sessionStorage: Record<string, unknown> = {}
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/connection.json')) return Promise.resolve(new Response(JSON.stringify({ connection: currentConnection })))
    return originalFetch(input, init)
  }))
  const storage = (data: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (values: object) => { Object.assign(data, values) }),
    remove: vi.fn(async (key: string) => { delete data[key] })
  })
  const listener = () => ({ addListener: vi.fn() })
  const chrome = {
    runtime: { id: 'a'.repeat(32), getURL: (file: string) => `chrome-extension://${'a'.repeat(32)}/${file}`, onMessage: listener(), onStartup: listener(), onInstalled: listener() },
    storage: { local: storage(local), session: storage(sessionStorage) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    tabs: { query: vi.fn(async () => [{ id: 9, url: 'https://exemplo.test', title: 'Exemplo' }]), get: vi.fn(async () => ({ id: 9, url: 'https://exemplo.test', title: 'Exemplo' })), onRemoved: listener(), onUpdated: listener() },
    scripting: { executeScript: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), onEvent: listener(), onDetach: listener(), sendCommand: vi.fn(async (_target: object, method: string) => method === 'Page.captureScreenshot' ? { data: 'imagem-verificada' } : {}) },
    alarms: { create: vi.fn(async () => {}), onAlarm: listener() }
  }
  vi.stubGlobal('chrome', chrome)
  await import('../extensions/ovseer/background.js')
  const receive = chrome.runtime.onMessage.addListener.mock.calls[0][0] as (message: object, sender: object, respond: (result: any) => void) => void
  const message = (data: object, tab?: object): Promise<any> => new Promise((resolve) => receive(data, { id: chrome.runtime.id, url: tab ? 'https://exemplo.test' : chrome.runtime.getURL('popup.html'), ...(tab ? { tab } : {}) }, resolve))
  let nextBridge: ChromeBridge | undefined
  try {
    const tabPopup = await new Promise<any>((resolve) => receive({ type: 'state' }, { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html'), tab: { id: 55 } }, resolve))
    expect(tabPopup.error).toBeFalsy()
    expect(await message({ type: 'connect' }, { id: 9 })).toMatchObject({ error: 'Ação inválida.' })
    await vi.waitFor(async () => expect((await message({ type: 'state' })).connected).toBe(true))
    expect(local.connection).toBeUndefined()
    expect(JSON.stringify(await message({ type: 'state' }))).not.toContain(connection)
    const session = bridge.session('Codex · Extensão')
    await expect(session.call('browser_take_screenshot', {})).rejects.toThrow('autorize uma aba')
    let info: { id: string }
    await vi.waitFor(async () => { const state = await message({ type: 'state' }); expect(state.sessions).toHaveLength(1); info = state.sessions[0] })
    expect(await message({ type: 'approve', session: info!.id, tabId: 9 })).toEqual({ ok: true })
    expect(await session.call('browser_take_screenshot', {})).toBe('imagem-verificada')
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3')
    expect(await message({ type: 'stop', session: info!.id }, { id: 9 })).toEqual({ ok: true })
    await expect(session.call('browser_take_screenshot', {})).rejects.toThrow('nova autorização')
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 9 })
    await message({ type: 'disconnect' })
    expect(await message({ type: 'state' })).toMatchObject({ connected: false, paused: true })
    await message({ type: 'connect' })
    await vi.waitFor(async () => expect((await message({ type: 'state' })).connected).toBe(true))
    nextBridge = new ChromeBridge()
    currentConnection = (await nextBridge.ready).connection
    await bridge.close()
    await vi.waitFor(async () => {
      await message({ type: 'state' })
      expect(nextBridge!.connected).toBe(true)
    })
    await expect(nextBridge.session('Nova conversa').call('browser_snapshot', {})).rejects.toThrow('autorize uma aba')
  } finally {
    await message({ type: 'disconnect' })
    await bridge.close()
    await nextBridge?.close()
  }
})

it('retoma sozinho quando o app fica disponível depois da extensão, sem abrir o popup nem clicar', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  let ready = false, reads = 0, polls = 0
  const local: Record<string, unknown> = {}
  const listener = () => ({ addListener: vi.fn() })
  const chrome = {
    runtime: { id: 'a'.repeat(32), getURL: (f: string) => `chrome-extension://${'a'.repeat(32)}/${f}`, onMessage: listener(), onStartup: listener(), onInstalled: listener() },
    storage: {
      local: { get: async (k: string) => ({ [k]: local[k] }), set: async (v: object) => { Object.assign(local, v) }, remove: async (k: string) => { delete local[k] } },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { query: async () => [], onRemoved: listener(), onUpdated: listener() },
    debugger: { onEvent: listener(), onDetach: listener() },
    alarms: { create: async () => {}, onAlarm: listener() }
  }
  vi.stubGlobal('chrome', chrome)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/connection.json')) {
      reads++
      return ready ? new Response(JSON.stringify({ connection: `http://127.0.0.1:12345/extension/${'a'.repeat(32)}` })) : new Response('{}', { status: 404 })
    }
    polls++
    if (JSON.parse(String(init?.body)).immediate) return new Response(JSON.stringify({ sessions: [], commands: [] }))
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('Interrompido.')), { once: true }))
  }))
  await import('../extensions/ovseer/background.js')
  const receive = chrome.runtime.onMessage.addListener.mock.calls[0][0] as (m: object, s: object, cb: (r: any) => void) => void
  const message = (m: object) => new Promise<any>((resolve) => receive(m, { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }, resolve))
  try {
    await vi.waitFor(() => expect(reads).toBe(1))
    expect(polls).toBe(0)
    ready = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(reads).toBe(2)
    expect(polls).toBeGreaterThan(0)
    expect(await message({ type: 'state' })).toMatchObject({ connected: true, paused: false })
    await message({ type: 'disconnect' })
    const before = reads
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reads).toBe(before)
    expect(await message({ type: 'state' })).toMatchObject({ connected: false, paused: true })
  } finally { await message({ type: 'disconnect' }) }
})
