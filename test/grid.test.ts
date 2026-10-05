import { describe, expect, it } from 'vitest'
import { tileArea } from '../src/shared/grid'

const area = (col: number, row: number, colSpan: number, rowSpan: number) => ({ col, colSpan, row, rowSpan })

describe('tileArea', () => {
  it('uma célula por janela quando a área tem exatamente esse tanto', () => {
    expect(tileArea(area(0, 0, 5, 1), 5)).toEqual([0, 1, 2, 3, 4].map((c) => area(c, 0, 1, 1)))
  })
  it('área maior que o número de janelas é ocupada inteira, lado a lado', () => {
    expect(tileArea(area(0, 0, 2, 2), 2)).toEqual([area(0, 0, 1, 2), area(1, 0, 1, 2)])
    expect(tileArea(area(1, 0, 5, 2), 2)).toEqual([area(1, 0, 3, 2), area(4, 0, 2, 2)])
    expect(tileArea(area(2, 1, 3, 1), 1)).toEqual([area(2, 1, 3, 1)])
  })
  it('mais janelas que colunas: faixas de cima para baixo', () => {
    expect(tileArea(area(0, 0, 2, 2), 3)).toEqual([area(0, 0, 1, 1), area(1, 0, 1, 1), area(0, 1, 2, 1)])
    expect(tileArea(area(0, 0, 3, 2), 5)).toEqual([area(0, 0, 1, 1), area(1, 0, 1, 1), area(2, 0, 1, 1), area(0, 1, 2, 1), area(2, 1, 1, 1)])
  })
  it('mais janelas que células: uma célula para cada uma das primeiras', () => {
    expect(tileArea(area(0, 0, 2, 1), 5)).toEqual([area(0, 0, 1, 1), area(1, 0, 1, 1)])
    expect(tileArea(area(0, 0, 2, 2), 0)).toEqual([])
  })
})
