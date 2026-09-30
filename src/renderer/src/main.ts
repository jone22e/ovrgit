import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
// Source Code Pro embutida: fonte padrão do terminal, igual no Mac e no Windows
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'
import '@fontsource/source-code-pro/700.css'
// JetBrains Mono variável: o editor usa peso intermediário (450), como a fonte aparece na IDE
import '@fontsource-variable/jetbrains-mono/wght.css'
import '@fontsource-variable/jetbrains-mono/wght-italic.css'

document.documentElement.dataset.platform = window.ovseer.platform
const app = createApp(App)
// erro dentro de um componente: mostra na barra de erro em vez de sumir com o componente em silêncio
app.config.errorHandler = (err, _instance, info) => {
  console.error(err)
  import('./store').then(({ state }) => (state.error = `Erro na interface (${info}): ${String((err as Error)?.message ?? err)}`))
}
app.mount('#app')
