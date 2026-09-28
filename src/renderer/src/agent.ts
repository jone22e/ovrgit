import { createApp } from 'vue'
import AgentWindow from './AgentWindow.vue'
import './styles.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'

// Janela exclusiva de um agente de IA: só a conversa, sem o resto do OvrGit
document.documentElement.dataset.platform = window.ovrgit.platform
createApp(AgentWindow).mount('#app')
