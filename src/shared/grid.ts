import type { GridSize } from './types'

/** Limites do grid de posicionamento das janelas de agente e o padrão (6 colunas × 2 linhas). */
export const GRID_LIMITS: GridSize = { cols: 12, rows: 6 }
export const GRID_DEFAULT: GridSize = { cols: 6, rows: 2 }

/** Tamanho de grid válido: configuração ausente ou fora dos limites volta ao padrão. */
export function normalizeGrid(g: Partial<GridSize> | null | undefined): GridSize {
  const n = (v: unknown, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(1, Math.round(v))) : def)
  return { cols: n(g?.cols, GRID_LIMITS.cols, GRID_DEFAULT.cols), rows: n(g?.rows, GRID_LIMITS.rows, GRID_DEFAULT.rows) }
}

/** Menor janela de agente que ainda fica usável: nenhuma célula do grid fica menor que isso */
export const AGENT_MIN_WIN = { width: 360, height: 320 }

/** Maior grid que cabe numa tela: tantas colunas × linhas quanto couberem células do tamanho da janela mínima */
export function gridLimitsFor(area: { width: number; height: number }, min = AGENT_MIN_WIN): GridSize {
  const fit = (len: number, cell: number, hi: number) => Math.min(hi, Math.max(1, Math.floor(len / cell)))
  return { cols: fit(area.width, min.width, GRID_LIMITS.cols), rows: fit(area.height, min.height, GRID_LIMITS.rows) }
}

/** Grid válido encaixado no limite da tela: numa tela menor, menos colunas e linhas que o configurado */
export function fitGrid(g: Partial<GridSize> | null | undefined, area: { width: number; height: number }, min = AGENT_MIN_WIN): GridSize {
  return clampGrid(g, gridLimitsFor(area, min))
}

/** Grid válido que não passa do limite dado */
export function clampGrid(g: Partial<GridSize> | null | undefined, limits: GridSize): GridSize {
  const n = normalizeGrid(g)
  return { cols: Math.min(n.cols, limits.cols), rows: Math.min(n.rows, limits.rows) }
}
