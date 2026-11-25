const webUrl = (value) => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Somente páginas HTTP e HTTPS são permitidas.')
  return url.href
}

/** Estado e permissões pertencem à extensão, nunca à página visitada. */
export class BrowserController {
  constructor(api, permission) {
    this.api = api
    this.permission = permission
    this.sessions = new Map()
    this.owners = new Map()
    this.refs = new Map()
    this.logs = new Map()
    this.serial = 0
  }

  async sync(infos) {
    for (const id of this.sessions.keys()) if (!infos.some((s) => s.id === id)) await this.stop(id, false)
    this.infos = infos
    for (const info of infos) {
      const session = this.sessions.get(info.id)
      if (session && info.state === 'stopped') await this.stop(info.id, false)
      else if (session) session.label = info.label
    }
  }

  async approve(id, tabId) {
    const info = this.infos?.find((s) => s.id === id)
    if (!info) throw new Error('Conversa encerrada. Atualize a extensão.')
    const tab = await this.api.tabs.get(tabId)
    webUrl(tab.url)
    const owner = this.owners.get(tabId)
    if (owner && owner !== id) throw new Error('Esta aba já está sendo usada por outra conversa.')
    let session = this.sessions.get(id)
    if (!session) { session = { label: info.label, tabs: new Set(), current: tabId }; this.sessions.set(id, session) }
    if (!owner) {
      try { await this.api.debugger.attach({ tabId }, '1.3') }
      catch (e) { if (!session.tabs.size) this.sessions.delete(id); throw e }
      if (this.sessions.get(id) !== session) {
        await this.api.debugger.detach({ tabId }).catch(() => {})
        throw new Error('Autorização interrompida.')
      }
      this.owners.set(tabId, id)
      session.tabs.add(tabId)
      this.logs.set(tabId, { console: [], network: [] })
      try {
        await this.cdp(tabId, 'Page.enable')
        await this.cdp(tabId, 'Runtime.enable')
        await this.cdp(tabId, 'Network.enable')
      } catch (e) { await this.stop(id, false); throw e }
    }
    session.current = tabId
    try {
      await this.overlay(tabId, session.label, id)
      if (this.sessions.get(id) !== session) throw new Error('Autorização interrompida.')
      const permission = await this.permission(id, true)
      session.epoch = permission.epoch
      if (this.sessions.get(id) !== session) { await this.permission(id, false); throw new Error('Autorização interrompida.') }
    } catch (e) { await this.stop(id, false); throw e }
  }

  async stop(id, notify = true) {
    const session = this.sessions.get(id)
    this.sessions.delete(id) // revoga antes de aguardar qualquer operação assíncrona
    if (session) for (const tabId of session.tabs) {
      this.owners.delete(tabId)
      this.refs.delete(tabId)
      this.logs.delete(tabId)
      await this.api.scripting.executeScript({ target: { tabId }, func: () => document.getElementById('__ovseer_control__')?.remove() }).catch(() => {})
      await this.api.debugger.detach({ tabId }).catch(() => {})
    }
    if (notify) await this.permission(id, false)
  }

  async stopAll(notify = true) { for (const id of [...this.sessions.keys()]) await this.stop(id, notify) }

  cdp(tabId, method, params = {}) { return this.api.debugger.sendCommand({ tabId }, method, params) }

  async overlay(tabId, label, session) {
    await this.api.scripting.executeScript({ target: { tabId }, func: (label, session) => {
      document.getElementById('__ovseer_control__')?.remove()
      const host = document.createElement('div')
      host.id = '__ovseer_control__'
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block'
      const root = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent = ':host{color-scheme:dark}.frame{position:absolute;inset:0;border:3px solid #b779f5;box-sizing:border-box;pointer-events:none}.bar{position:absolute;top:0;left:50%;transform:translateX(-50%);max-width:85vw;display:flex;align-items:center;gap:12px;background:#39234f;color:#fff;border:1px solid #b779f5;border-radius:0 0 12px 12px;padding:10px 14px;font:13px system-ui;box-shadow:0 4px 18px #0005;pointer-events:auto}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button{background:#fff;color:#39234f;border:0;border-radius:6px;padding:5px 9px;font:600 12px system-ui;cursor:pointer}'
      const frame = document.createElement('div'); frame.className = 'frame'
      const bar = document.createElement('div'); bar.className = 'bar'
      const text = document.createElement('span'); text.className = 'label'; text.textContent = `Ovseer trabalhando · ${label}`
      const stop = document.createElement('button'); stop.textContent = 'Interromper'
      stop.addEventListener('click', (event) => { if (event.isTrusted) chrome.runtime.sendMessage({ type: 'stop', session }) })
      bar.append(text, stop); root.append(style, frame, bar); document.documentElement.append(host)
    }, args: [label, session] })
  }

  event(source, method, params) {
    const logs = this.logs.get(source.tabId)
    if (!logs) return
    if (method === 'Page.frameNavigated') this.refs.delete(source.tabId)
    if (method === 'Runtime.consoleAPICalled') logs.console.push({ type: params.type, text: params.args.map((a) => a.value ?? a.description ?? '').join(' ') })
    if (method === 'Runtime.exceptionThrown') logs.console.push({ type: 'error', text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text })
    if (method === 'Network.requestWillBeSent') logs.network.push({ id: params.requestId, method: params.request.method, url: params.request.url })
    if (method === 'Network.responseReceived') {
      const item = logs.network.findLast((r) => r.id === params.requestId)
      if (item) item.status = params.response.status
    }
    logs.console = logs.console.slice(-200); logs.network = logs.network.slice(-300)
  }

  async snapshot(tabId) {
    const { nodes } = await this.cdp(tabId, 'Accessibility.getFullAXTree')
    const refs = new Map()
    const generation = ++this.serial
    const lines = []
    let length = 0
    for (const node of nodes) {
      if (node.ignored) continue
      let ref = ''
      if (node.backendDOMNodeId) { ref = `e${generation}-${node.backendDOMNodeId}`; refs.set(ref, node.backendDOMNodeId) }
      const props = node.properties?.filter((p) => ['checked', 'selected', 'disabled', 'expanded', 'required'].includes(p.name)).map((p) => `${p.name}=${p.value.value}`).join(' ')
      lines.push(`${ref ? `[${ref}] ` : ''}${node.role?.value ?? ''} ${JSON.stringify(node.name?.value ?? '')}${node.value ? ` value=${JSON.stringify(node.value.value)}` : ''}${props ? ` (${props})` : ''}`)
      length += lines[lines.length - 1].length + 1
      if (length > 80_000) { lines.push('… captura truncada'); break }
    }
    this.refs.set(tabId, refs)
    const tab = await this.api.tabs.get(tabId)
    return `Aba ${tabId}: ${tab.title}\nURL: ${tab.url}\n${lines.join('\n')}`
  }

  async element(tabId, ref, functionDeclaration, args = []) {
    const backendNodeId = this.refs.get(tabId)?.get(ref)
    if (!backendNodeId) throw new Error('Referência expirada ou desconhecida. Execute browser_snapshot novamente.')
    const { object } = await this.cdp(tabId, 'DOM.resolveNode', { backendNodeId })
    try {
      const result = await this.cdp(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    } finally { await this.cdp(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}) }
  }

  async point(tabId, ref) {
    return this.element(tabId, ref, 'function() { this.scrollIntoView({block:"center",inline:"center"}); const r=this.getBoundingClientRect(); if(!r.width||!r.height) throw new Error("Elemento não visível."); return {x:r.x+r.width/2,y:r.y+r.height/2}; }')
  }

  async click(tabId, ref, button = 'left', doubleClick = false) {
    const point = await this.point(tabId, ref)
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    for (let count = 1; count <= (doubleClick ? 2 : 1); count++) {
      await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: count })
      await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: count })
    }
  }

  async key(tabId, input) {
    const parts = input.split('+'), name = parts.pop()
    let modifiers = 0
    for (const part of parts) modifiers |= { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[part] ?? 0
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 }
    const key = name === 'Space' ? ' ' : name
    const code = codes[name] ?? (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0)
    if (!code) throw new Error('Tecla não suportada.')
    const text = !modifiers && key.length === 1 ? key : name === 'Enter' ? '\r' : undefined
    await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, modifiers, ...(text ? { text } : {}) })
    await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers })
  }

  async execute(command) {
    const remaining = Math.min(30_000, command.deadline - Date.now())
    if (remaining <= 0) throw new Error('Comando expirado.')
    let timer
    try {
      return await Promise.race([
        this.perform(command),
        new Promise((_, reject) => { timer = setTimeout(() => {
          void this.stop(command.session).catch(() => {})
          reject(new Error('A página não respondeu a tempo. O controle foi interrompido; autorize novamente para continuar.'))
        }, remaining) })
      ])
    } finally { clearTimeout(timer) }
  }

  async perform(command) {
    if (Date.now() > command.deadline) throw new Error('Comando expirado.')
    const session = this.sessions.get(command.session)
    if (!session) throw new Error('Autorize esta conversa na extensão Ovseer.')
    if (command.epoch !== session.epoch) throw new Error('Comando de uma autorização anterior. Solicite novamente.')
    const a = command.args ?? {}, name = command.name
    const valid = () => {
      if (this.sessions.get(command.session) !== session) throw new Error('Controle interrompido pelo usuário.')
      if (command.epoch !== session.epoch || Date.now() > command.deadline) throw new Error('Comando expirado ou autorização revogada.')
    }
    if (name === 'browser_tabs') {
      if (a.action === 'list') return (await this.api.tabs.query({})).filter((t) => /^https?:/.test(t.url)).map((t) => ({ tabId: t.id, title: t.title, url: t.url, authorized: session.tabs.has(t.id), current: session.current === t.id }))
      if (a.action === 'new') {
        if (!a.url) throw new Error('Informe a URL HTTP(S) para criar uma aba.')
        const url = webUrl(a.url)
        const tab = await this.api.tabs.create({ url, active: true })
        valid()
        try { await this.approve(command.session, tab.id) } catch (e) { await this.api.tabs.remove(tab.id).catch(() => {}); throw e }
        return { tabId: tab.id, url }
      }
      if (!session.tabs.has(a.tabId)) throw new Error('Esta aba não foi autorizada. Peça ao usuário para autorizá-la na extensão Ovseer.')
      if (a.action === 'close') { await this.api.tabs.remove(a.tabId); return 'Aba fechada.' }
      if (a.action !== 'select') throw new Error('Ação de aba inválida.')
      session.current = a.tabId
      await this.api.tabs.update(a.tabId, { active: true })
      return this.snapshot(a.tabId)
    }
    const tabId = session.current
    if (!session.tabs.has(tabId) || this.owners.get(tabId) !== command.session) throw new Error('Selecione uma aba autorizada.')
    const tab = await this.api.tabs.get(tabId)
    webUrl(tab.url)
    valid()
    if (name === 'browser_snapshot') return this.snapshot(tabId)
    if (name === 'browser_navigate') { await this.cdp(tabId, 'Page.navigate', { url: webUrl(a.url) }); this.refs.delete(tabId); return 'Navegação iniciada. Execute browser_snapshot para ler a nova página.' }
    if (name === 'browser_navigate_back') {
      const history = await this.cdp(tabId, 'Page.getNavigationHistory')
      const entry = history.entries[history.currentIndex - 1]
      if (!entry) throw new Error('Não há página anterior.')
      webUrl(entry.url)
      await this.cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }); this.refs.delete(tabId)
      return 'Navegação iniciada. Execute browser_snapshot novamente.'
    }
    if (name === 'browser_click') await this.click(tabId, a.ref, a.button, a.doubleClick)
    else if (name === 'browser_hover') await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...await this.point(tabId, a.ref) })
    else if (name === 'browser_type') {
      await this.element(tabId, a.ref, 'function(){this.focus();if(this.select)this.select();else if(this.isContentEditable){const s=getSelection();s.selectAllChildren(this);}else throw new Error("Elemento não editável.");}')
      valid(); await this.cdp(tabId, 'Input.insertText', { text: a.text })
      if (a.submit) { valid(); await this.key(tabId, 'Enter') }
    } else if (name === 'browser_fill_form') {
      for (const field of a.fields) {
        valid()
        if (field.type === 'checkbox') {
          if (!['true', 'false'].includes(field.value)) throw new Error('Checkbox exige true ou false.')
          const checked = await this.element(tabId, field.ref, 'function(){return this.checked;}')
          if (checked !== (field.value === 'true')) { valid(); await this.click(tabId, field.ref) }
        } else if (field.type === 'combobox') await this.select(tabId, field.ref, [field.value])
        else {
          await this.element(tabId, field.ref, 'function(){this.focus();if(this.select)this.select();else throw new Error("Campo não editável.");}')
          valid(); await this.cdp(tabId, 'Input.insertText', { text: field.value })
        }
      }
    } else if (name === 'browser_select_option') await this.select(tabId, a.ref, a.values)
    else if (name === 'browser_press_key') await this.key(tabId, a.key)
    else if (name === 'browser_scroll') await this.cdp(tabId, 'Runtime.evaluate', { expression: `window.scrollBy(${Number(a.x) || 0},${Number(a.y) || 0})` })
    else if (name === 'browser_evaluate') {
      const result = await this.cdp(tabId, 'Runtime.evaluate', { expression: `(${a.function})()`, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value ?? result.result.description ?? null
    } else if (name === 'browser_take_screenshot') return (await this.cdp(tabId, 'Page.captureScreenshot', { format: 'png' })).data
    else if (name === 'browser_handle_dialog') { await this.cdp(tabId, 'Page.handleJavaScriptDialog', { accept: a.accept, promptText: a.promptText }); return 'Diálogo tratado.' }
    else if (name === 'browser_console_messages') return this.logs.get(tabId)?.console ?? []
    else if (name === 'browser_network_requests') return this.logs.get(tabId)?.network ?? []
    else if (name === 'browser_close') { await this.api.tabs.remove(tabId); return 'Aba fechada.' }
    else throw new Error('Ferramenta desconhecida.')
    valid()
    return 'Ação concluída. Execute browser_snapshot para conferir o resultado.'
  }

  async select(tabId, ref, values) {
    await this.element(tabId, ref, 'function(values){if(this.tagName!=="SELECT")throw new Error("Elemento não é select.");if(values.some(v=>!Array.from(this.options).some(o=>o.value===v)))throw new Error("Opção não encontrada.");for(const o of this.options)o.selected=values.includes(o.value);this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));}', [values])
  }
}
