import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    server: { port: 15173 },
    // três páginas: o app principal, a janela exclusiva de cada agente de IA e a janela do terminal de um serviço
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          agent: resolve('src/renderer/agent.html'),
          service: resolve('src/renderer/service.html')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
