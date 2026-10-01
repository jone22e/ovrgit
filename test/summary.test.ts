import { describe, expect, it } from 'vitest'
import { summaryOf } from '../src/shared/summary'

describe('summaryOf', () => {
  it('pula a frase de abertura e a lista, e pega o parágrafo corrido', () => {
    const text = `Ao clicar em **Salvar**:

1. Aparecerá uma confirmação de conversão.
2. Confirmando, o sistema verifica se o mapa está vazio.

Se houver estoque, o salvamento será recusado e toda a operação será revertida.

39 s`
    expect(summaryOf(text)).toBe('Se houver estoque, o salvamento será recusado e toda a operação será revertida.')
  })
  it('sem parágrafo corrido, junta a lista', () => {
    expect(summaryOf('Resumo:\n\n- Corrigi o typecheck\n- Rodei os testes e passaram')).toBe('Corrigi o typecheck · Rodei os testes e passaram')
  })
  it('ignora títulos e limpa markdown', () => {
    expect(summaryOf('## Resultado\n\nConversão `segura` implementada, sem *perda* de dados.')).toBe('Conversão segura implementada, sem perda de dados.')
  })
  it('sem nada melhor, devolve o primeiro trecho', () => {
    expect(summaryOf('Pronto.')).toBe('Pronto.')
    expect(summaryOf('')).toBe('')
  })
})
