import { createApp } from 'vue'
import DesignWindow from './DesignWindow.vue'
import './styles.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'

// Janela de design do Modo Arquiteto: a conversa com o agente de design e a tela do conceito
document.documentElement.dataset.platform = window.ovseer.platform
createApp(DesignWindow).mount('#app')
