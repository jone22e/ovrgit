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
    // páginas: o app principal, a janela de cada agente de IA, a do terminal de um serviço e a de um terminal desacoplado
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          agent: resolve('src/renderer/agent.html'),
          service: resolve('src/renderer/service.html'),
          terminal: resolve('src/renderer/terminal.html'),
          design: resolve('src/renderer/design.html')
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
