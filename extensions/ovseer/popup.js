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
  $('connect').hidden = !state.paused
  $('connect').textContent = 'Conectar ao Ovseer'
  $('connection-help').textContent = state.paused ? 'Você desconectou a extensão. Clique abaixo para retomar a conexão automática.' : 'Mantenha o Ovseer aberto neste computador. A extensão se conecta sozinha, sem código nem configuração.'
  if (!state.error || state.paused) $('error').textContent = ''
  if (state.error && !state.paused && !busy) $('error').textContent = state.error
  const next = JSON.stringify([state.connected, state.paused, state.sessions])
  if (signature === next) return
  signature = next
  const nodes = []
  for (const session of state.sessions) {
    const box = el('section', '', 'session')
    box.append(el('h2', session.label), el('div', session.state === 'stopped' ? 'Controle interrompido' : session.tabs.length ? `${session.tabs.length} aba(s) em uso` : 'Pronto para navegar', 'state'))
    const actions = el('div', '', 'actions')
    if (session.state === 'stopped') {
      const resume = el('button', 'Retomar')
      resume.disabled = !state.connected
      resume.onclick = () => action(() => send({ type: 'resume', session: session.id }))
      actions.append(resume)
    } else if (session.tabs.length) {
      const stop = el('button', 'Interromper', 'stop')
      stop.onclick = () => action(() => send({ type: 'stop', session: session.id }))
      actions.append(stop)
    }
    box.append(actions); nodes.push(box)
  }
  if (!nodes.length) nodes.push(el('p', 'Os agentes abrem e controlam suas abas automaticamente. Quando uma conversa usar o navegador, você poderá acompanhar e interromper por aqui.', 'empty'))
  $('sessions').replaceChildren(...nodes)
}
$('connect').onclick = () => action(() => send({ type: 'connect' }))
$('disconnect').onclick = () => action(() => send({ type: 'disconnect' }))
void refresh().catch((e) => { $('error').textContent = e.message })
setInterval(() => { if (!busy) void refresh().catch(() => {}) }, 1500)
