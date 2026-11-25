const webUrl = (value) => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Somente páginas HTTP e HTTPS são permitidas.')
  return url.href
}
const pageUrl = (value) => value === 'about:blank' ? value : webUrl(value)

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
    this.stopped = new Set()
  }

  async sync(infos) {
    for (const id of this.sessions.keys()) if (!infos.some((s) => s.id === id)) await this.stop(id, false)
    for (const id of this.stopped) if (!infos.some((s) => s.id === id)) this.stopped.delete(id)
    this.infos = infos
    for (const info of infos) {
      const session = this.sessions.get(info.id)
      if (info.state === 'stopped') this.stopped.add(info.id)
      if (session && (info.state === 'stopped' || session.epoch !== info.epoch)) await this.stop(info.id, false)
      else if (session) session.label = info.label
    }
  }

  session(id) {
    const info = this.infos?.find((s) => s.id === id)
    if (!info) throw new Error('Conversa encerrada. Atualize a extensão.')
    if (info.state === 'stopped' || this.stopped.has(id)) throw new Error('Controle interrompido. Clique em Retomar na extensão para continuar.')
    let session = this.sessions.get(id)
    if (!session) {
      session = { label: info.label, epoch: info.epoch, tabs: new Set(), current: null }
      this.sessions.set(id, session)
    }
    return session
  }

  async resume(id) {
    if (!this.infos?.some((s) => s.id === id)) throw new Error('Conversa encerrada.')
    const permission = await this.permission(id, true)
    const info = this.infos?.find((s) => s.id === id)
    if (info) { info.state = 'approved'; info.epoch = permission.epoch; this.stopped.delete(id) }
  }

  async attachTab(id, tabId) {
    const session = this.session(id)
    const tab = await this.api.tabs.get(tabId)
    pageUrl(tab.url)
    const owner = this.owners.get(tabId)
    if (owner && owner !== id) throw new Error('Esta aba já está sendo usada por outra conversa.')
    if (!owner) {
      try { await this.api.debugger.attach({ tabId }, '1.3') }
      catch (e) { if (!session.tabs.size) this.sessions.delete(id); throw e }
      if (this.sessions.get(id) !== session) {
        await this.api.debugger.detach({ tabId }).catch(() => {})
        throw new Error('Controle interrompido.')
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
      if (tab.url !== 'about:blank') await this.overlay(tabId, session.label, id)
      if (this.sessions.get(id) !== session) throw new Error('Controle interrompido.')
    } catch (e) { await this.stop(id, false); throw e }
  }

  async stop(id, notify = true) {
    if (notify) {
      this.stopped.add(id)
      const info = this.infos?.find((s) => s.id === id)
      if (info) info.state = 'stopped'
    }
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

  removed(tabId) {
    const session = this.sessions.get(this.owners.get(tabId))
    this.owners.delete(tabId); this.refs.delete(tabId); this.logs.delete(tabId)
    if (session) {
      session.tabs.delete(tabId)
      if (session.current === tabId) session.current = [...session.tabs][0] ?? null
    }
  }

  cdp(tabId, method, params = {}) { return this.api.debugger.sendCommand({ tabId }, method, params) }

  async overlay(tabId, label, session) {
    await this.api.scripting.executeScript({ target: { tabId }, func: (label, session) => {
      document.getElementById('__ovseer_control__')?.remove()
      const host = document.createElement('div')
      host.id = '__ovseer_control__'
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block'
      const root = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent = ':host{color-scheme:dark}.frame{position:absolute;inset:0;border:3px solid #b779f5;box-sizing:border-box;pointer-events:none}.bar{position:absolute;top:0;left:50%;transform:translateX(-50%);max-width:85vw;display:flex;align-items:center;gap:12px;background:#39234f;color:#fff;border:1px solid #b779f5;border-radius:0 0 12px 12px;padding:10px 14px;font:13px system-ui;box-shadow:0 4px 18px #0005;pointer-events:auto}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button{background:#fff;color:#39234f;border:0;border-radius:6px;padding:5px 9px;font:600 12px system-ui;cursor:pointer}.pointer{position:absolute;top:0;left:0;width:26px;height:32px;overflow:visible;pointer-events:none;visibility:var(--ovseer-pointer-visibility,hidden);transform:translate(var(--ovseer-pointer-x,0px),var(--ovseer-pointer-y,0px));filter:drop-shadow(0 2px 3px #0008)}'
      const frame = document.createElement('div'); frame.className = 'frame'
      const bar = document.createElement('div'); bar.className = 'bar'
      const text = document.createElement('span'); text.className = 'label'; text.textContent = `Ovseer trabalhando · ${label}`
      const stop = document.createElement('button'); stop.textContent = 'Interromper'
      stop.addEventListener('click', (event) => { if (event.isTrusted) chrome.runtime.sendMessage({ type: 'stop', session }) })
      const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      pointer.setAttribute('class', 'pointer'); pointer.setAttribute('viewBox', '-2 -2 26 32'); pointer.setAttribute('aria-hidden', 'true')
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      arrow.setAttribute('d', 'M0 0 L0 22 L6 16 L11 27 L16 25 L11 14 L21 14 Z')
      arrow.setAttribute('fill', '#b779f5'); arrow.setAttribute('stroke', '#fff'); arrow.setAttribute('stroke-width', '2'); arrow.setAttribute('stroke-linejoin', 'round')
      pointer.append(arrow)
      bar.append(text, stop); root.append(style, frame, bar, pointer); document.documentElement.append(host)
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
    await this.movePointer(tabId, point)
    for (let count = 1; count <= (doubleClick ? 2 : 1); count++) {
      await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: count })
      await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: count })
    }
  }

  async movePointer(tabId, point) {
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await this.api.scripting.executeScript({ target: { tabId }, func: ({ x, y }) => {
      const host = document.getElementById('__ovseer_control__')
      if (!host) return
      host.style.setProperty('--ovseer-pointer-x', `${x - 2}px`)
      host.style.setProperty('--ovseer-pointer-y', `${y - 2}px`)
      host.style.setProperty('--ovseer-pointer-visibility', 'visible')
    }, args: [point] }).catch(() => {}) // O indicador visual não deve impedir a ação na página.
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
          reject(new Error('A página não respondeu a tempo. O controle foi interrompido; clique em Retomar na extensão para continuar.'))
        }, remaining) })
      ])
    } finally { clearTimeout(timer) }
  }

  async perform(command) {
    if (Date.now() > command.deadline) throw new Error('Comando expirado.')
    const session = this.session(command.session)
    if (command.epoch !== session.epoch) throw new Error('Comando de uma autorização anterior. Solicite novamente.')
    const a = command.args ?? {}, name = command.name
    const valid = () => {
      if (this.sessions.get(command.session) !== session) throw new Error('Controle interrompido pelo usuário.')
      if (command.epoch !== session.epoch || Date.now() > command.deadline) throw new Error('Comando expirado ou autorização revogada.')
    }
    if (name === 'browser_tabs') {
      if (a.action === 'list') return (await this.api.tabs.query({})).filter((t) => t.url === 'about:blank' || /^https?:/.test(t.url)).map((t) => ({ tabId: t.id, title: t.title, url: t.url, owned: session.tabs.has(t.id), inUseByOtherConversation: this.owners.has(t.id) && this.owners.get(t.id) !== command.session, current: session.current === t.id }))
      if (a.action === 'new') {
        return this.openTab(command.session, a.url ? webUrl(a.url) : 'about:blank', valid)
      }
      if (!Number.isInteger(a.tabId)) throw new Error('Informe o tabId real retornado por browser_tabs.')
      if (this.owners.has(a.tabId) && this.owners.get(a.tabId) !== command.session) throw new Error('Esta aba já está sendo usada por outra conversa.')
      if (!session.tabs.has(a.tabId)) {
        if (a.action !== 'select') throw new Error('Selecione a aba antes de fechá-la.')
        await this.attachTab(command.session, a.tabId)
        valid()
      }
      if (a.action === 'close') { await this.api.tabs.remove(a.tabId); this.removed(a.tabId); return 'Aba fechada.' }
      if (a.action !== 'select') throw new Error('Ação de aba inválida.')
      session.current = a.tabId
      await this.api.tabs.update(a.tabId, { active: true })
      return this.snapshot(a.tabId)
    }
    if (name === 'browser_navigate' && !session.tabs.size) {
      await this.openTab(command.session, webUrl(a.url), valid)
      return this.snapshot(session.current)
    }
    const tabId = session.current
    if (!session.tabs.has(tabId) || this.owners.get(tabId) !== command.session) throw new Error('Abra uma aba com browser_navigate ou browser_tabs (action new).')
    const tab = await this.api.tabs.get(tabId)
    pageUrl(tab.url)
    valid()
    if (name === 'browser_snapshot') return this.snapshot(tabId)
    if (name === 'browser_navigate') { await this.navigate(tabId, webUrl(a.url), valid); return this.snapshot(tabId) }
    if (name === 'browser_navigate_back') {
      const history = await this.cdp(tabId, 'Page.getNavigationHistory')
      const entry = history.entries[history.currentIndex - 1]
      if (!entry) throw new Error('Não há página anterior.')
      webUrl(entry.url)
      await this.cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }); this.refs.delete(tabId)
      return 'Navegação iniciada. Execute browser_snapshot novamente.'
    }
    if (name === 'browser_click') await this.click(tabId, a.ref, a.button, a.doubleClick)
    else if (name === 'browser_hover') await this.movePointer(tabId, await this.point(tabId, a.ref))
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
    else if (name === 'browser_close') { await this.api.tabs.remove(tabId); this.removed(tabId); return 'Aba fechada.' }
    else throw new Error('Ferramenta desconhecida.')
    valid()
    return 'Ação concluída. Execute browser_snapshot para conferir o resultado.'
  }

  async openTab(id, url, valid) {
    const tab = await this.api.tabs.create({ url: 'about:blank', active: true })
    try {
      valid()
      await this.attachTab(id, tab.id)
      valid()
      if (url !== 'about:blank') await this.navigate(tab.id, url, valid)
      valid()
      return { tabId: tab.id, url }
    } catch (e) { this.removed(tab.id); await this.api.tabs.remove(tab.id).catch(() => {}); throw e }
  }

  async navigate(tabId, url, valid) {
    const navigation = await this.cdp(tabId, 'Page.navigate', { url })
    if (navigation.errorText) throw new Error(navigation.errorText)
    this.refs.delete(tabId)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      valid()
      try {
        const result = await this.cdp(tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
        if (result.result?.value !== 'loading') break
      } catch { valid() }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    valid()
    const session = this.sessions.get(this.owners.get(tabId))
    if (session) await this.overlay(tabId, session.label, this.owners.get(tabId))
  }

  async select(tabId, ref, values) {
    await this.element(tabId, ref, 'function(values){if(this.tagName!=="SELECT")throw new Error("Elemento não é select.");if(values.some(v=>!Array.from(this.options).some(o=>o.value===v)))throw new Error("Opção não encontrada.");for(const o of this.options)o.selected=values.includes(o.value);this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));}', [values])
  }
}
