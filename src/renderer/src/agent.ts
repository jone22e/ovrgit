import { createApp } from 'vue'
import AgentWindow from './AgentWindow.vue'
import './styles.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'

// Janela exclusiva de um agente de IA: só a conversa, sem o resto do Ovseer

/** Nunca deixa a janela em branco: mostra o erro e um botão para recarregar. */
function showFailure(msg: string, retryIn?: number) {
  const app = document.getElementById('app') ?? document.body
  app.innerHTML = ''
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;font:13.5px system-ui;color:#c9c4d4;text-align:center'
  const p = document.createElement('p')
  p.textContent = retryIn ? `${msg} Tentando de novo em ${Math.round(retryIn / 1000)} s…` : msg
  const btn = document.createElement('button')
  btn.textContent = 'Recarregar'
  btn.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid #444;background:#2a2a2a;color:inherit;cursor:pointer'
  btn.onclick = () => location.reload()
  box.append(p, btn)
  app.append(box)
}

window.addEventListener('error', (e) => showFailure(`A janela do agente encontrou um erro: ${e.message}`))
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string } | undefined
  console.error('Promessa sem tratamento na janela do agente:', r?.message ?? e.reason)
})

// a ponte com o processo principal (preload) pode faltar por instantes durante o desenvolvimento, enquanto o
// electron-vite regrava o bundle: em vez de ficar em branco, a página avisa e recarrega sozinha
if (!window.ovseer) {
  const tries = Number(sessionStorage.getItem('ovseer.agent.retries') ?? '0')
  if (tries < 5) {
    sessionStorage.setItem('ovseer.agent.retries', String(tries + 1))
    showFailure('A janela ainda não conseguiu falar com o Ovseer.', 800)
    setTimeout(() => location.reload(), 800)
  } else {
    showFailure('A janela não conseguiu falar com o Ovseer. Feche-a e abra o agente de novo.')
  }
} else {
  sessionStorage.removeItem('ovseer.agent.retries')
  document.documentElement.dataset.platform = window.ovseer.platform
  try {
    createApp(AgentWindow).mount('#app')
  } catch (e) {
    showFailure(`A janela do agente não conseguiu abrir: ${e instanceof Error ? e.message : String(e)}`)
  }
}
