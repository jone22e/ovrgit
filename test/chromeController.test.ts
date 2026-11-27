import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { BrowserController } from '../extensions/ovseer/controller.js'

function setup(input?: { type: string; autocomplete?: string; multiple?: boolean; disabled?: boolean; webkitdirectory?: boolean }) {
  const tabs = [{ id: 10, url: 'https://exemplo.test', title: 'Teste' }, { id: 20, url: 'https://outra.test', title: 'Outra' }, { id: 30, url: 'chrome://settings', title: 'Configurações' }]
  const field = input ? { tagName: 'INPUT', autocomplete: '', ...input, focus() {}, select() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ x: 20, y: 30, width: 20, height: 20 }) } : null
  const api = {
    runtime: { getURL: (file: string) => `chrome-extension://ovseer/${file}` },
    tabs: { get: vi.fn(async (id: number) => tabs.find((t) => t.id === id)), query: vi.fn(async () => tabs), update: vi.fn(async () => {}), create: vi.fn(async () => ({ id: 20 })), remove: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: vi.fn(async (_target: object, method: string, params: { functionDeclaration?: string; arguments?: { value: unknown }[]; expression?: string } = {}) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 123, role: { value: 'button' }, name: { value: 'Salvar' } }] }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } }
      if (method === 'DOM.describeNode') return { node: { nodeName: field?.tagName ?? 'BUTTON', attributes: field ? ['type', field.type, ...(['multiple', 'disabled', 'webkitdirectory'] as const).filter((name) => input?.[name]).flatMap((name) => [name, ''])] : [] } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: field ? runInNewContext(`(${params.functionDeclaration})`).apply(field, params.arguments?.map((a) => a.value) ?? []) : { x: 30, y: 40 } } }
      if (method === 'Runtime.evaluate' && params.expression?.includes('document.activeElement')) return { result: { value: runInNewContext(params.expression, { document: { activeElement: field } }) } }
      if (method === 'Page.captureScreenshot') return { data: 'png-base64' }
      return {}
    }) },
    scripting: { executeScript: vi.fn(async () => {}) }
  }
  const permission = vi.fn(async () => ({ epoch: 'permissao-atual' }))
  const controller = new BrowserController(api, permission)
  const infos = [{ id: 'a', label: 'Codex · Loja', state: 'approved', epoch: 'permissao-atual' }, { id: 'b', label: 'Claude · Flexi', state: 'approved', epoch: 'permissao-atual' }]
  const call = (name: string, args = {}, session = 'a') => controller.execute({ name, args, session, epoch: 'permissao-atual', deadline: Date.now() + 30_000 })
  return { api, permission, controller, infos, call }
}

describe('controle das abas na extensão Ovseer', () => {
  it('abre o controle sem autorização no popup e bloqueia abas internas e abas de outra conversa', async () => {
    const { api, controller, infos, call } = setup()
    await controller.sync(infos)
    await expect(call('browser_snapshot')).rejects.toThrow('Abra uma aba')
    expect(api.debugger.attach).not.toHaveBeenCalled()
    await expect(controller.attachTab('a', 30)).rejects.toThrow('HTTP')
    await controller.attachTab('a', 10)
    await expect(controller.attachTab('b', 10)).rejects.toThrow('outra conversa')
    await call('browser_tabs', { action: 'select', tabId: 20 })
    expect(api.debugger.attach).toHaveBeenCalledWith({ tabId: 20 }, '1.3')
    expect(await call('browser_tabs', { action: 'list' })).toHaveLength(2)
  })

  it('usa referências reais, invalida após navegação e envia cliques pelo CDP', async () => {
    const { api, controller, infos, call } = setup()
    await controller.sync(infos); await controller.attachTab('a', 10)
    const snapshot = await call('browser_snapshot')
    expect(snapshot).toContain('[e1-123] button "Salvar"')
    await call('browser_click', { ref: 'e1-123' })
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 30, y: 40 }))
    controller.event({ tabId: 10 }, 'Page.frameNavigated', {})
    await expect(call('browser_click', { ref: 'e1-123' })).rejects.toThrow('Referência expirada')
    await expect(call('browser_navigate', { url: 'file:///etc/passwd' })).rejects.toThrow('HTTP')
    await expect(call('browser_navigate', { url: 'javascript:alert(1)' })).rejects.toThrow('HTTP')
  })

  it('intercepta o seletor de um campo oculto e orienta o envio sem diálogo nativo', async () => {
    const { api, controller, infos, call } = setup({ type: 'file' })
    await controller.sync(infos); await controller.attachTab('a', 10)
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Page.setInterceptFileChooserDialog', { enabled: true })
    const send = api.debugger.sendCommand.getMockImplementation()!
    api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Input.dispatchMouseEvent' && (params as any).type === 'mouseReleased') controller.event({ tabId: 10 }, 'Page.fileChooserOpened', { backendNodeId: 456, mode: 'selectSingle' })
      return send(target, method, params)
    })
    await call('browser_snapshot')
    expect(await call('browser_click', { ref: 'e1-123' })).toContain('browser_file_upload')
    expect(await call('browser_snapshot')).toContain('Seletor de arquivos aberto (um arquivo)')
    const paths = ['/projeto com espaços/versão-final.aab']
    await call('browser_file_upload', { paths })
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'DOM.setFileInputFiles', { backendNodeId: 456, files: paths })
    expect(await call('browser_snapshot')).not.toContain('Seletor de arquivos aberto')
    await expect(call('browser_file_upload', { paths })).rejects.toThrow('Nenhum seletor')
  })

  it('permite upload por referência e limpa a seleção com uma lista vazia', async () => {
    const { api, controller, infos, call } = setup({ type: 'file', multiple: true })
    await controller.sync(infos); await controller.attachTab('a', 10); await call('browser_snapshot')
    await call('browser_file_upload', { ref: 'e1-123', paths: ['/primeiro.pdf', '/segundo.png'] })
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'DOM.setFileInputFiles', { backendNodeId: 123, files: ['/primeiro.pdf', '/segundo.png'] })
    await call('browser_file_upload', { ref: 'e1-123', paths: [] })
    expect(api.debugger.sendCommand).toHaveBeenLastCalledWith({ tabId: 10 }, 'DOM.setFileInputFiles', { backendNodeId: 123, files: [] })
    await expect(call('browser_file_upload', { ref: 'inventada', paths: [] })).rejects.toThrow('Referência expirada')
  })

  it.each([
    { input: { type: 'text' }, paths: ['/arquivo.aab'], error: 'input type=file' },
    { input: { type: 'file' }, paths: ['/um.aab', '/dois.aab'], error: 'apenas um arquivo' },
    { input: { type: 'file', disabled: true }, paths: ['/arquivo.aab'], error: 'desabilitado' },
    { input: { type: 'file', webkitdirectory: true }, paths: ['/arquivo.aab'], error: 'exige uma pasta' }
  ])('recusa upload inválido: $error', async ({ input, paths, error }) => {
    const { api, controller, infos, call } = setup(input)
    await controller.sync(infos); await controller.attachTab('a', 10); await call('browser_snapshot')
    await expect(call('browser_file_upload', { ref: 'e1-123', paths })).rejects.toThrow(error)
    expect(api.debugger.sendCommand.mock.calls.some(([, method]) => method === 'DOM.setFileInputFiles')).toBe(false)
  })

  it('isola seletores por aba e conversa e os descarta ao navegar, fechar ou interromper', async () => {
    const { controller, infos, call } = setup({ type: 'file' })
    await controller.sync(infos); await controller.attachTab('a', 10); await controller.attachTab('b', 20)
    const open = (tabId: number) => controller.event({ tabId }, 'Page.fileChooserOpened', { backendNodeId: 456, mode: 'selectSingle' })
    open(10)
    await expect(call('browser_file_upload', { paths: ['/arquivo.aab'] }, 'b')).rejects.toThrow('Nenhum seletor')
    controller.event({ tabId: 10 }, 'Page.frameNavigated', {})
    await expect(call('browser_file_upload', { paths: ['/arquivo.aab'] })).rejects.toThrow('Nenhum seletor')
    open(10); await controller.stop('a')
    expect(controller.fileChoosers.has(10)).toBe(false)
    await expect(call('browser_file_upload', { paths: ['/arquivo.aab'] })).rejects.toThrow('Retomar')
    open(20); controller.removed(20)
    expect(controller.fileChoosers.size).toBe(0)
    open(10) // Eventos atrasados de uma aba sem controle são ignorados.
    expect(controller.fileChoosers.size).toBe(0)
  })

  it('não seleciona arquivos se o usuário interromper durante a resolução do campo', async () => {
    const { api, controller, infos, call } = setup({ type: 'file' })
    await controller.sync(infos); await controller.attachTab('a', 10); await call('browser_snapshot')
    const send = api.debugger.sendCommand.getMockImplementation()!
    api.debugger.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'DOM.describeNode') await controller.stop('a')
      return send(target, method, params)
    })
    await expect(call('browser_file_upload', { ref: 'e1-123', paths: ['/arquivo.aab'] })).rejects.toThrow('interrompido')
    expect(api.debugger.sendCommand.mock.calls.some(([, method]) => method === 'DOM.setFileInputFiles')).toBe(false)
  })

  it.each([
    { type: 'text', autocomplete: '', masked: false },
    { type: 'password', autocomplete: '', masked: true },
    { type: 'text', autocomplete: 'one-time-code', masked: true }
  ])('mostra a prévia de digitação com proteção para $type/$autocomplete', async ({ type, autocomplete, masked }) => {
    const { api, controller, infos, call } = setup({ type, autocomplete })
    await controller.sync(infos); await controller.attachTab('a', 10); await call('browser_snapshot')
    const text = 'texto-do-teste <b>literal</b>'
    await call('browser_type', { ref: 'e1-123', text })
    expect(api.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: [masked ? '••••••••' : text, 'Digitando', false] }))
    if (masked) expect(JSON.stringify(api.scripting.executeScript.mock.calls)).not.toContain(text)
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Input.insertText', { text })
  })

  it('mascara a prévia ao preencher uma senha pelo formulário', async () => {
    const { api, controller, infos, call } = setup({ type: 'password' })
    await controller.sync(infos); await controller.attachTab('a', 10); await call('browser_snapshot')
    await call('browser_fill_form', { fields: [{ ref: 'e1-123', type: 'textbox', value: 'senha-do-teste' }] })
    expect(api.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['••••••••', 'Digitando', false] }))
    expect(JSON.stringify(api.scripting.executeScript.mock.calls)).not.toContain('senha-do-teste')
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Input.insertText', { text: 'senha-do-teste' })
  })

  it.each(['text', 'password'])('protege caracteres enviados por teclas em campo $type', async (type) => {
    const { api, controller, infos, call } = setup({ type })
    await controller.sync(infos); await controller.attachTab('a', 10)
    await call('browser_press_key', { key: 'a' })
    expect(api.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: [type === 'password' ? '••••••••' : 'a', 'Digitando', type !== 'password'] }))
    expect(api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', text: 'a' }))
    await call('browser_press_key', { key: 'Control+A' })
    expect(api.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['Control+A', 'Tecla', false] }))
  })

  it('interromper remove a faixa, desanexa as abas e bloqueia ações futuras', async () => {
    const { api, permission, controller, infos, call } = setup()
    await controller.sync(infos); await controller.attachTab('a', 10); await controller.attachTab('a', 20)
    await controller.stop('a')
    expect(permission).toHaveBeenLastCalledWith('a', false)
    expect(api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 })
    expect(api.debugger.detach).toHaveBeenCalledWith({ tabId: 20 })
    expect(controller.owners.size).toBe(0)
    await expect(call('browser_snapshot')).rejects.toThrow('interrompido')
  })

  it('fechar a conversa desconecta; uma resposta de poll anterior à autorização não a revoga', async () => {
    const { api, controller, infos } = setup()
    await controller.sync(infos); await controller.attachTab('a', 10)
    await controller.sync(infos)
    expect(controller.sessions.has('a')).toBe(true)
    await controller.sync([])
    expect(api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 })
    expect(controller.sessions.size).toBe(0)
  })

  it('interromper durante attach não deixa um depurador anexado depois', async () => {
    const { api, controller, infos } = setup()
    await controller.sync(infos)
    let finish!: () => void
    api.debugger.attach.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const approving = expect(controller.attachTab('a', 10)).rejects.toThrow('interrompido')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await controller.stop('a')
    finish(); await approving
    expect(controller.owners.size).toBe(0)
    expect(api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 })
  })

  it('captura imagens e registra console/rede somente para abas autorizadas', async () => {
    const { controller, infos, call } = setup()
    await controller.sync(infos); await controller.attachTab('a', 10)
    controller.event({ tabId: 10 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'ok' }] })
    controller.event({ tabId: 20 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'privado' }] })
    controller.event({ tabId: 10 }, 'Network.requestWillBeSent', { requestId: '1', request: { method: 'GET', url: 'https://exemplo.test/api' } })
    controller.event({ tabId: 10 }, 'Network.responseReceived', { requestId: '1', response: { status: 200 } })
    expect(await call('browser_console_messages')).toEqual([{ type: 'log', text: 'ok' }])
    expect(await call('browser_network_requests')).toEqual([{ id: '1', method: 'GET', url: 'https://exemplo.test/api', status: 200 }])
    expect(await call('browser_take_screenshot')).toBe('png-base64')
  })

  it('recusa comandos expirados e comandos da autorização anterior', async () => {
    const { controller, infos } = setup()
    await controller.sync(infos); await controller.attachTab('a', 10)
    await expect(controller.execute({ name: 'browser_snapshot', args: {}, session: 'a', epoch: 'antiga', deadline: Date.now() + 30_000 })).rejects.toThrow('autorização anterior')
    await expect(controller.execute({ name: 'browser_snapshot', args: {}, session: 'a', epoch: 'permissao-atual', deadline: Date.now() - 1 })).rejects.toThrow('expirado')
  })

  it('revoga o controle se o JavaScript da página não responder ao comando', async () => {
    const { api, controller, infos } = setup()
    await controller.sync(infos); await controller.attachTab('a', 10)
    api.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}))
    await expect(controller.execute({ name: 'browser_evaluate', args: { function: '() => new Promise(() => {})' }, session: 'a', epoch: 'permissao-atual', deadline: Date.now() + 20 })).rejects.toThrow('controle foi interrompido')
    expect(controller.sessions.size).toBe(0)
    await vi.waitFor(() => expect(api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 }))
  })

  it('abre a própria aba no primeiro comando, sem confirmação manual e sem tocar nas outras abas', async () => {
    const { api, controller, infos, call, permission } = setup()
    await controller.sync(infos)
    const result = await call('browser_tabs', { action: 'new', url: 'https://nova.test' })
    expect(result).toEqual({ tabId: 20, url: 'https://nova.test/' })
    expect(api.tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active: true })
    expect(api.debugger.attach).toHaveBeenCalledWith({ tabId: 20 }, '1.3')
    expect(api.debugger.attach).not.toHaveBeenCalledWith({ tabId: 10 }, '1.3')
    expect(permission).not.toHaveBeenCalled()
    await call('browser_close')
    expect(controller.stopped.has('a')).toBe(false)
    expect(await call('browser_tabs', { action: 'new' })).toEqual({ tabId: 20, url: 'about:blank' })
  })

  it('Interromper bloqueia também a abertura de novas abas até o usuário clicar em Retomar', async () => {
    const { api, controller, infos, call } = setup()
    await controller.sync(infos)
    await controller.attachTab('a', 10)
    await controller.stop('a')
    // Uma resposta antiga do servidor não pode desfazer a interrupção local.
    await controller.sync(infos.map((s) => ({ ...s, state: 'approved' })))
    await expect(call('browser_tabs', { action: 'new' })).rejects.toThrow('Retomar')
    expect(api.tabs.create).not.toHaveBeenCalled()
    await controller.resume('a')
    expect(await call('browser_tabs', { action: 'new' })).toMatchObject({ tabId: 20 })
  })
})
