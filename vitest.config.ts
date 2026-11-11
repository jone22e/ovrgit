import { defineConfig } from 'vitest/config'

// Vários testes fazem git real (clone, commit, push); em paralelo, a preparação dos repositórios
// temporários pode passar dos 10 s permitidos para hooks e derrubar o make update.
export default defineConfig({
  test: { testTimeout: 20_000, maxWorkers: 1 }
})
