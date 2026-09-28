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
    // duas páginas: o app principal e a janela exclusiva de cada agente de IA
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          agent: resolve('src/renderer/agent.html')
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
