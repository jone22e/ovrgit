import { describe, expect, it } from 'vitest'
import { count } from '../src/shared/plural'

describe('count', () => {
  it('escolhe singular ou plural pelo número', () => {
    expect(count(1, 'versão salva', 'versões salvas')).toBe('1 versão salva')
    expect(count(8, 'versão salva', 'versões salvas')).toBe('8 versões salvas')
    expect(count(0, 'arquivo', 'arquivos')).toBe('0 arquivos')
  })
})
