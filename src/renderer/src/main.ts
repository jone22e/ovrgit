import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
// Source Code Pro embutida: fonte padrão do terminal, igual no Mac e no Windows
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'
import '@fontsource/source-code-pro/700.css'

document.documentElement.dataset.platform = window.ovrgit.platform
createApp(App).mount('#app')
