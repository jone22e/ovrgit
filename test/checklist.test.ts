import { describe, expect, it } from 'vitest'
import { applyMarkers, checklistReminder, doneMarkers, parseChecklist, type ChecklistItem } from '../src/shared/checklist'

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
    expect(doneMarkers(text)).toEqual({ done: [1, 2, 3, 5], failed: [4], skipped: [], notes: {} })
  })
  it('marca os itens e diz se mudou', () => {
    const items = [{ text: 'a', done: false }, { text: 'b', done: false }]
    expect(applyMarkers(items, 'bla\n[ok] 2')).toBe(true)
    expect(items[1].done).toBe(true)
    expect(applyMarkers(items, 'bla\n[ok] 2')).toBe(false)
    expect(applyMarkers(items, '[ok] 9')).toBe(false)
  })
  it('dispensado encerra o item com o motivo; falhou só anota; ok depois limpa', () => {
    const items: ChecklistItem[] = [{ text: 'a', done: false }, { text: 'b', done: false }, { text: 'c', done: false }]
    expect(applyMarkers(items, '[pulado] 2 — a migration já estava aplicada\n[falhou] 3: sem acesso ao banco')).toBe(true)
    expect(items[1]).toEqual({ text: 'b', done: true, state: 'skipped', note: 'a migration já estava aplicada' })
    expect(items[2]).toEqual({ text: 'c', done: false, state: 'failed', note: 'sem acesso ao banco' })
    expect(applyMarkers(items, '[ok] 3')).toBe(true)
    expect(items[2]).toEqual({ text: 'c', done: true })
    expect(doneMarkers('[dispensado] item 4\n[n/a] 5').skipped).toEqual([4, 5])
  })
})

describe('checklistReminder', () => {
  it('lista só os itens em aberto, com o número', () => {
    const items: ChecklistItem[] = [{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: false, state: 'failed' }]
    const r = checklistReminder(items)
    expect(r).toContain('2. b')
    expect(r).toContain('3. c (falhou antes)')
    expect(r).not.toContain('1. a')
    expect(r).toContain('[pulado] N')
  })
  it('vazio quando não falta nada', () => {
    expect(checklistReminder([{ text: 'a', done: true }])).toBe('')
  })
})
