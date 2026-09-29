<script setup lang="ts">
import { computed, ref } from 'vue'
import { GRID_LIMITS, normalizeGrid } from '@shared/grid'
import type { GridCell, GridPlacement, GridSize } from '@shared/types'
import Icon from './Icon.vue'

/**
 * Grid de posicionamento da janela (no espírito do FlexiGrid/Moom, sem depender dele): a área útil da tela
 * vira colunas × linhas; o usuário arrasta pelas células para escolher a região e, ao soltar, a janela vai
 * para lá. Um clique escolhe uma célula só.
 */
/** Tamanho do grid (colunas × linhas): quem abre o menu carrega e guarda; aqui só exibe e altera */
const size = defineModel<GridSize>({ required: true })
const emit = defineEmits<{ place: [p: GridPlacement] }>()
/** Células já cobertas por janelas de agente: as de outro agente ficam trancadas, as desta janela só marcadas */
const props = withDefaults(defineProps<{ cells?: GridCell[] }>(), { cells: () => [] })
const cellAtIndex = (i: number) => props.cells.find((c) => c.col === i % size.value.cols && c.row === Math.floor(i / size.value.cols))
const locked = (i: number) => !!cellAtIndex(i) && !cellAtIndex(i)!.own
/** A área em escolha passa por cima de uma célula de outro agente */
const blocked = computed(() => Array.from({ length: size.value.cols * size.value.rows }, (_, i) => i).some((i) => selected(i) && locked(i)))

type Size = GridSize
function set(k: keyof Size, v: number) {
  size.value = normalizeGrid({ ...size.value, [k]: v })
}
const canDec = (k: keyof Size) => size.value[k] > 1
const canInc = (k: keyof Size) => size.value[k] < GRID_LIMITS[k]

/** O desenho segue a proporção da tela onde a janela está, para a área escolhida bater com o que se vê */
const aspect = computed(() => `${Math.max(1, window.screen.availWidth)} / ${Math.max(1, window.screen.availHeight)}`)

// ---------- seleção por arraste ----------
interface Cell {
  col: number
  row: number
}
const grid = ref<HTMLElement>()
const anchor = ref<Cell | null>(null)
const cursor = ref<Cell | null>(null)
function cellAt(e: PointerEvent): Cell {
  const r = grid.value?.getBoundingClientRect()
  if (!r || !r.width || !r.height) return { col: 0, row: 0 }
  const { cols, rows } = size.value
  return {
    col: Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols))),
    row: Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows)))
  }
}
function down(e: PointerEvent) {
  if (e.button !== 0) return
  grid.value?.setPointerCapture(e.pointerId)
  anchor.value = cursor.value = cellAt(e)
}
function move(e: PointerEvent) {
  if (anchor.value) cursor.value = cellAt(e)
}
function up(e: PointerEvent) {
  const a = anchor.value
  if (!a) return
  const b = cellAt(e)
  const taken = blocked.value
  anchor.value = cursor.value = null
  if (taken) return
  emit('place', {
    cols: size.value.cols,
    rows: size.value.rows,
    col: Math.min(a.col, b.col),
    colSpan: Math.abs(a.col - b.col) + 1,
    row: Math.min(a.row, b.row),
    rowSpan: Math.abs(a.row - b.row) + 1
  })
}
function cancel() {
  anchor.value = cursor.value = null
}
function selected(i: number): boolean {
  const a = anchor.value
  const b = cursor.value
  if (!a || !b) return false
  const col = i % size.value.cols
  const row = Math.floor(i / size.value.cols)
  return col >= Math.min(a.col, b.col) && col <= Math.max(a.col, b.col) && row >= Math.min(a.row, b.row) && row <= Math.max(a.row, b.row)
}
const hint = computed(() => {
  const a = anchor.value
  const b = cursor.value
  if (!a || !b) return 'Arraste pelas células para escolher a área. Solte para aplicar.'
  const w = Math.abs(a.col - b.col) + 1
  const h = Math.abs(a.row - b.row) + 1
  if (blocked.value) return 'Área ocupada por outro agente: escolha células livres.'
  return `${w} × ${h} ${w * h === 1 ? 'célula' : 'células'}: solte para mover a janela.`
})
</script>

<template>
  <div class="wgrid">
    <div class="wgrid-head">
      <strong>Posição da janela</strong>
      <span class="faint">na tela onde ela está</span>
    </div>
    <div class="wgrid-size">
      <span v-for="k in (['cols', 'rows'] as const)" :key="k" class="stepper">
        <span class="lbl">{{ k === 'cols' ? 'Colunas' : 'Linhas' }}</span>
        <b class="mono">{{ size[k] }}</b>
        <span class="arrows">
          <button type="button" class="ghost" title="Mais" :disabled="!canInc(k)" @click="set(k, size[k] + 1)"><Icon name="chevron" :size="11" class="up" /></button>
          <button type="button" class="ghost" title="Menos" :disabled="!canDec(k)" @click="set(k, size[k] - 1)"><Icon name="chevron" :size="11" class="down" /></button>
        </span>
      </span>
    </div>
    <p class="wgrid-hint" :class="{ live: anchor, bad: blocked }">{{ hint }}</p>
    <div
      ref="grid"
      class="cells"
      :style="{ aspectRatio: aspect, gridTemplateColumns: `repeat(${size.cols}, 1fr)`, gridTemplateRows: `repeat(${size.rows}, 1fr)` }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="cancel"
    >
      <span
        v-for="i in size.cols * size.rows"
        :key="i"
        class="cell"
        :class="{ sel: selected(i - 1), locked: locked(i - 1), own: cellAtIndex(i - 1)?.own, bad: blocked && selected(i - 1) }"
      >
        <Icon v-if="locked(i - 1)" name="lock" :size="11" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.wgrid { display: flex; flex-direction: column; gap: 10px; padding: 4px 6px 6px; user-select: none; }
.wgrid-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 13px; }
.wgrid-head .faint { font-size: 11px; }
.wgrid-size { display: flex; gap: 18px; }
.stepper { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
.stepper .lbl { color: var(--muted); }
.stepper b { font-size: 12.5px; min-width: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.arrows { display: inline-flex; flex-direction: column; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel-2); }
.arrows button { width: 22px; height: 14px; padding: 0; border-radius: 0; color: var(--muted); display: grid; place-items: center; }
.arrows .up { transform: rotate(-90deg); }
.arrows .down { transform: rotate(90deg); }
.arrows button:first-child { border-bottom: 1px solid var(--border); }
.arrows button:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.arrows button:disabled { opacity: 0.35; }
.wgrid-hint { margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.4; min-height: 16px; }
.wgrid-hint.live { color: var(--accent); }
.cells { display: grid; gap: 4px; width: 100%; cursor: crosshair; touch-action: none; }
.cell { border-radius: 5px; background: var(--panel-2); border: 1px solid var(--border); pointer-events: none; transition: background 0.06s; }
.cell { display: grid; place-items: center; color: var(--faint); }
/* esta janela: contorno; outro agente: cadeado */
.cell.own { border-color: var(--accent); background: var(--accent-soft); }
.cell.locked { background: color-mix(in srgb, var(--faint) 18%, var(--panel-2)); }
.cell.sel { background: var(--accent); border-color: var(--accent); color: #fff; }
.cell.sel.bad { background: var(--del); border-color: var(--del); }
.wgrid-hint.bad { color: var(--del); }
</style>
