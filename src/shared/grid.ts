import type { GridSize } from './types'

/** Limites do grid de posicionamento das janelas de agente e o padrão (6 colunas × 2 linhas). */
export const GRID_LIMITS: GridSize = { cols: 12, rows: 6 }
export const GRID_DEFAULT: GridSize = { cols: 6, rows: 2 }

/** Tamanho de grid válido: configuração ausente ou fora dos limites volta ao padrão. */
export function normalizeGrid(g: Partial<GridSize> | null | undefined): GridSize {
  const n = (v: unknown, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(1, Math.round(v))) : def)
  return { cols: n(g?.cols, GRID_LIMITS.cols, GRID_DEFAULT.cols), rows: n(g?.rows, GRID_LIMITS.rows, GRID_DEFAULT.rows) }
}
