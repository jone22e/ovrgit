import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

document.documentElement.dataset.platform = window.ovrgit.platform
createApp(App).mount('#app')
