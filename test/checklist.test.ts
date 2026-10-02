import { describe, expect, it } from 'vitest'
import { applyMarkers, doneMarkers, parseChecklist } from '../src/shared/checklist'

describe('parseChecklist', () => {
  it('lê a seção Checklist do plano', () => {
    const plan = `# Retorno manual\n\n## Passos\n- fazer X\n\n## Checklist\n- [ ] Criar a migração\n- [ ] Ajustar o serviço de boletos\n- [x] Já feito\n\n`
    expect(parseChecklist(plan)).toEqual([
      { text: 'Criar a migração', done: false },
      { text: 'Ajustar o serviço de boletos', done: false },
      { text: 'Já feito', done: true }
    ])
  })
  it('para na próxima seção e aceita listas numeradas', () => {
    const plan = `## Checklist\n1. [ ] Um\n2. [ ] Dois\n\n## Riscos\n- [ ] não é item`
    expect(parseChecklist(plan).map((i) => i.text)).toEqual(['Um', 'Dois'])
  })
  it('sem a seção, só vale uma lista de caixas', () => {
    expect(parseChecklist('Texto\n- [ ] a\n- [ ] b')).toHaveLength(2)
    expect(parseChecklist('Texto\n- [ ] a')).toEqual([])
    expect(parseChecklist('Sem nada')).toEqual([])
  })
})

describe('doneMarkers / applyMarkers', () => {
  it('reconhece os marcadores do agente', () => {
    const text = 'Começando.\n[ok] 1\nfeito o primeiro\n[OK] 2\n✅ 3\n[falhou] 4\n[x] etapa 5\n'
    expect(doneMarkers(text)).toEqual({ done: [1, 2, 3, 5], failed: [4] })
  })
  it('marca os itens e diz se mudou', () => {
    const items = [{ text: 'a', done: false }, { text: 'b', done: false }]
    expect(applyMarkers(items, 'bla\n[ok] 2')).toBe(true)
    expect(items[1].done).toBe(true)
    expect(applyMarkers(items, 'bla\n[ok] 2')).toBe(false)
    expect(applyMarkers(items, '[ok] 9')).toBe(false)
  })
})
