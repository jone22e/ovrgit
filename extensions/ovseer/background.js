import { BrowserController } from './controller.js'

let connection = '', connected = false, error = '', loop, abort, generation = 0
const controller = new BrowserController(chrome, (session, approved) => post('/permission', { session, approved }))

async function post(route, body, signal) {
  const response = await fetch(connection + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20_000), credentials: 'omit', cache: 'no-store', redirect: 'error'
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Ovseer respondeu ${response.status}.`)
  return result
}

function badge() {
  const pending = controller.infos?.filter((s) => s.state === 'waiting').length ?? 0
  void chrome.action.setBadgeBackgroundColor({ color: '#7952b3' })
  void chrome.action.setBadgeText({ text: pending ? String(pending) : controller.sessions.size ? 'ON' : '' })
}

async function run() {
  const current = generation
  let first = true
  while (connection && current === generation) {
    try {
      abort = new AbortController()
      const data = await post('/poll', { immediate: first }, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]))
      if (current !== generation) return
      first = false; connected = true; error = ''
      // Uma chamada de API a cada ciclo também mantém o worker apto a receber conexões.
      await chrome.storage.session.set({ ovseerTabs: [...controller.owners.keys()] })
      await controller.sync(data.sessions)
      badge()
      for (const command of data.commands) {
        if (current !== generation) return
        try { await post('/result', { id: command.id, result: await controller.execute(command) }) }
        catch (e) { await post('/result', { id: command.id, error: String(e.message || e) }).catch(() => {}) }
      }
    } catch (e) {
      if (current !== generation) return
      connected = false; error = String(e.message || e)
      await controller.stopAll(false)
      badge()
      // O alarme retoma a conexão mesmo se o Chrome suspender o worker.
      return
    }
  }
}

async function start() {
  if (loop) return
  const current = generation
  loop = (async () => {
    if ((await chrome.storage.local.get('paused')).paused) return
    try {
      const response = await fetch(chrome.runtime.getURL('connection.json'), { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error('Conexão automática indisponível. Abra o Ovseer e recarregue a extensão da pasta indicada pelo aplicativo.')
      const data = await response.json()
      if (current !== generation) return
      const url = new URL(data.connection)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/extension\/[\w-]{32,}$/.test(url.pathname)) throw new Error('Conexão automática inválida. Recarregue a extensão da pasta indicada pelo Ovseer.')
      connection = url.href
      await run()
    } catch {
      connected = false
      error = 'Abra o Ovseer neste computador. Se acabou de atualizar, recarregue a extensão em chrome://extensions usando a pasta indicada pelo aplicativo.'
    }
  })()
  try { await loop } finally { loop = undefined }
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Origem inválida.')
  const ownPopup = sender.url === chrome.runtime.getURL('popup.html')
  if (sender.tab && !ownPopup) {
    if (message.type !== 'stop' || controller.owners.get(sender.tab.id) !== message.session) throw new Error('Ação inválida.')
    await controller.stop(message.session); badge(); return { ok: true }
  }
  if (!ownPopup) throw new Error('Origem inválida.')
  if (message.type === 'connect') {
    await controller.stopAll().catch(() => {})
    generation++; abort?.abort()
    if (loop) await loop
    connection = ''; connected = false; error = ''
    await chrome.storage.local.set({ paused: false })
    void start()
    return { ok: true }
  }
  if (message.type === 'disconnect') {
    await controller.stopAll().catch(() => {})
    generation++; abort?.abort()
    if (loop) await loop
    connection = ''; connected = false
    await chrome.storage.local.set({ paused: true }); badge()
    return { ok: true }
  }
  if (message.type === 'approve') {
    await controller.approve(message.session, Number(message.tabId))
    await chrome.storage.session.set({ ovseerTabs: [...controller.owners.keys()] })
    badge(); return { ok: true }
  }
  if (message.type === 'stop') { await controller.stop(message.session); badge(); return { ok: true } }
  if (message.type === 'state') {
    void start()
    return { paused: (await chrome.storage.local.get('paused')).paused === true, connected, error, sessions: (controller.infos ?? []).map((s) => ({ ...s, approved: controller.sessions.has(s.id), tabs: [...(controller.sessions.get(s.id)?.tabs ?? [])] })),
      tabs: (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url)).map((t) => ({ id: t.id, title: t.title, url: t.url, owner: controller.owners.get(t.id) })) }
  }
  throw new Error('Ação desconhecida.')
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, (e) => respond({ error: String(e.message || e) }))
  return true
})
chrome.debugger.onEvent.addListener((source, method, params) => controller.event(source, method, params))
chrome.debugger.onDetach.addListener((source) => {
  const id = controller.owners.get(source.tabId)
  if (id) void controller.stop(id).catch(() => {}).finally(badge)
})
chrome.tabs.onRemoved.addListener((tabId) => {
  const id = controller.owners.get(tabId), session = controller.sessions.get(id)
  controller.owners.delete(tabId); controller.refs.delete(tabId); controller.logs.delete(tabId)
  if (!session) return
  session.tabs.delete(tabId)
  if (!session.tabs.size) void controller.stop(id).catch(() => {}).finally(badge)
  else if (session.current === tabId) session.current = [...session.tabs][0]
})
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const id = controller.owners.get(tabId), session = controller.sessions.get(id)
  if (!session) return
  if (change.url) controller.refs.delete(tabId)
  if (change.url && !/^https?:/.test(tab.url)) { void controller.stop(id).catch(() => {}).finally(badge); return }
  if (change.status === 'complete') void controller.overlay(tabId, session.label, id).catch(() => {})
})
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'ovseer-reconnect') void start() })
chrome.runtime.onStartup.addListener(() => { void start() })
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('ovseer-reconnect', { periodInMinutes: 0.5 }); void start() })

// Nunca restaura permissões de controle após reiniciar o worker/perfil.
async function initialize() {
  // Migra a configuração antiga: a credencial agora vem apenas da pasta preparada pelo aplicativo.
  await chrome.storage.local.remove('connection')
  const { ovseerTabs = [] } = await chrome.storage.session.get('ovseerTabs')
  for (const tabId of ovseerTabs) {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => document.getElementById('__ovseer_control__')?.remove() }).catch(() => {})
    await chrome.debugger.detach({ tabId }).catch(() => {})
  }
  await chrome.storage.session.remove('ovseerTabs')
  await chrome.alarms.create('ovseer-reconnect', { periodInMinutes: 0.5 })
  void start()
}
void initialize()
