const $ = (id) => document.getElementById(id)
let busy = false, signature = ''
async function send(message) {
  const result = await chrome.runtime.sendMessage(message)
  if (result?.error) throw new Error(result.error)
  return result
}
async function action(fn) {
  busy = true; $('error').textContent = ''
  try { await fn(); signature = ''; await refresh() } catch (e) { $('error').textContent = e.message }
  finally { busy = false }
}
function el(tag, text, className) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}
async function refresh() {
  const state = await send({ type: 'state' })
  $('status').textContent = state.connected ? 'Conectado ao aplicativo' : state.paused ? 'Conexão pausada' : 'Aguardando o Ovseer'
  $('pairing').hidden = state.connected
  $('disconnect').hidden = !state.connected
  $('connect').textContent = state.paused ? 'Conectar ao Ovseer' : 'Tentar novamente'
  $('connection-help').textContent = state.paused ? 'Você desconectou a extensão. Clique abaixo para retomar a conexão automática.' : 'Mantenha o Ovseer aberto neste computador. A extensão se conecta sozinha, sem código nem configuração.'
  if (!state.error || state.paused) $('error').textContent = ''
  if (state.error && !state.paused && !busy) $('error').textContent = state.error
  const next = JSON.stringify([state.connected, state.paused, state.sessions, state.tabs])
  if (signature === next) return
  signature = next
  const nodes = []
  for (const session of state.sessions) {
    const box = el('section', '', 'session')
    box.append(el('h2', session.label), el('div', session.approved ? `${session.tabs.length} aba(s) autorizada(s)` : session.state === 'stopped' ? 'Controle interrompido' : 'Aguardando sua autorização', 'state'))
    const select = el('select'); select.setAttribute('aria-label', 'Aba para autorizar')
    for (const tab of state.tabs) {
      const option = el('option', `${tab.title || tab.url}${tab.owner && tab.owner !== session.id ? ' · outra conversa' : ''}`)
      option.value = tab.id; option.disabled = !!tab.owner && tab.owner !== session.id
      select.append(option)
    }
    const actions = el('div', '', 'actions')
    const allow = el('button', session.approved ? 'Autorizar outra aba' : 'Autorizar aba')
    allow.disabled = !state.connected || !state.tabs.some((t) => !t.owner || t.owner === session.id)
    allow.onclick = () => action(() => send({ type: 'approve', session: session.id, tabId: Number(select.value) }))
    actions.append(allow)
    if (session.approved) {
      const stop = el('button', 'Interromper', 'stop')
      stop.onclick = () => action(() => send({ type: 'stop', session: session.id }))
      actions.append(stop)
    }
    box.append(select, actions); nodes.push(box)
  }
  if (!nodes.length) nodes.push(el('p', 'Quando um agente pedir acesso ao navegador, a conversa aparecerá aqui para você escolher uma aba.', 'empty'))
  $('sessions').replaceChildren(...nodes)
}
$('connect').onclick = () => action(() => send({ type: 'connect' }))
$('disconnect').onclick = () => action(() => send({ type: 'disconnect' }))
void refresh().catch((e) => { $('error').textContent = e.message })
setInterval(() => { if (!busy) void refresh().catch(() => {}) }, 1500)
