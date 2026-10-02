import { createApp } from 'vue'
import TerminalWindow from './TerminalWindow.vue'
import './styles.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'

// Janela própria de uma aba do terminal desacoplada do painel ("Desacoplar" na barra de abas)
document.documentElement.dataset.platform = window.ovseer.platform
createApp(TerminalWindow).mount('#app')
