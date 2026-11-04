import { defineConfig } from 'vitest/config'

// Vários testes fazem git real (clone, commit, push) e, com a suíte inteira em paralelo numa máquina ocupada,
// passam dos 5 s padrão; 20 s ainda pega um teste travado sem derrubar o make update por lentidão.
export default defineConfig({
  test: { testTimeout: 20_000 }
})
