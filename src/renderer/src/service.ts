import { createApp } from 'vue'
import ServiceWindow from './ServiceWindow.vue'
import './styles.css'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'

// Janela com o terminal de um serviço em segundo plano (menu Serviços → "Ver terminal")
document.documentElement.dataset.platform = window.ovseer.platform
createApp(ServiceWindow).mount('#app')
