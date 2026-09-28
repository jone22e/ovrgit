import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
// Source Code Pro embutida: fonte padrão do terminal, igual no Mac e no Windows
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'
import '@fontsource/source-code-pro/700.css'

document.documentElement.dataset.platform = window.ovrgit.platform
const app = createApp(App)
// erro dentro de um componente: mostra na barra de erro em vez de sumir com o componente em silêncio
app.config.errorHandler = (err, _instance, info) => {
  console.error(err)
  import('./store').then(({ state }) => (state.error = `Erro na interface (${info}): ${String((err as Error)?.message ?? err)}`))
}
app.mount('#app')
