<script setup lang="ts">
import { computed, watch } from 'vue'
import { isPartial, setDiffMode, setShowDiff, state, toggleHunk } from '../store'
import Icon from './Icon.vue'

/**
 * Diff do arquivo: em linha ou lado a lado, com as palavras alteradas destacadas.
 * Cada trecho (hunk) pode ser incluído ou deixado de fora da próxima versão.
 */
type Kind = 'add' | 'del' | 'ctx'
interface Seg { text: string; changed: boolean }
interface Line { kind: Kind; old?: number; new?: number; segs: Seg[] }
interface Hunk { index: number; header: string; lines: Line[] }
interface SplitRow { left?: Line; right?: Line }

// ---------- leitura do diff ----------
const parsed = computed(() => {
  const hunks: Hunk[] = []
  const meta: string[] = []
  let cur: Hunk | null = null
  let o = 0
  let n = 0
  for (const raw of state.diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw)
    if (m) {
      o = Number(m[1])
      n = Number(m[2])
      cur = { index: hunks.length, header: m[3].trim(), lines: [] }
      hunks.push(cur)
      continue
    }
    if (!cur) {
      if (/^(diff --git|index |--- |\+\+\+ )/.test(raw)) continue
      if (raw.trim()) meta.push(raw)
      continue
    }
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('+')) cur.lines.push({ kind: 'add', new: n++, segs: [{ text: raw.slice(1), changed: false }] })
    else if (raw.startsWith('-')) cur.lines.push({ kind: 'del', old: o++, segs: [{ text: raw.slice(1), changed: false }] })
    else if (raw !== '' || cur.lines.length) cur.lines.push({ kind: 'ctx', old: o++, new: n++, segs: [{ text: raw.slice(1), changed: false }] })
  }
  // remove linhas de contexto vazias sobrando no fim de cada trecho
  for (const h of hunks) while (h.lines.length && h.lines.at(-1)!.kind === 'ctx' && !h.lines.at(-1)!.segs[0].text && h.lines.at(-1)!.new === undefined) h.lines.pop()
  for (const h of hunks) highlightWords(h.lines)
  return { hunks, meta }
})

// ---------- destaque de palavras ----------
const tokenize = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []

/** Diferença por palavras (LCS) entre a linha removida e a adicionada correspondente. */
function wordDiff(a: string, b: string): [Seg[], Seg[]] {
  const x = tokenize(a)
  const y = tokenize(b)
  if (x.length * y.length > 40000) return [[{ text: a, changed: true }], [{ text: b, changed: true }]]
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const left: Seg[] = []
  const right: Seg[] = []
  const push = (arr: Seg[], text: string, changed: boolean) => {
    const last = arr.at(-1)
    if (last && last.changed === changed) last.text += text
    else arr.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push(left, x[i], false)
      push(right, y[j], false)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push(left, x[i++], true)
    else push(right, y[j++], true)
  }
  while (i < x.length) push(left, x[i++], true)
  while (j < y.length) push(right, y[j++], true)
  // se quase tudo mudou, o destaque não ajuda: mostra a linha inteira normal
  const ratio = (segs: Seg[]) => segs.filter((s) => s.changed).reduce((t, s) => t + s.text.length, 0) / Math.max(1, segs.reduce((t, s) => t + s.text.length, 0))
  if (ratio(left) > 0.7 && ratio(right) > 0.7) return [[{ text: a, changed: false }], [{ text: b, changed: false }]]
  return [left, right]
}

function highlightWords(lines: Line[]) {
  let k = 0
  while (k < lines.length) {
    if (lines[k].kind !== 'del') {
      k++
      continue
    }
    const dels: Line[] = []
    while (k < lines.length && lines[k].kind === 'del') dels.push(lines[k++])
    const adds: Line[] = []
    while (k < lines.length && lines[k].kind === 'add') adds.push(lines[k++])
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const [l, r] = wordDiff(dels[p].segs[0].text, adds[p].segs[0].text)
      dels[p].segs = l
      adds[p].segs = r
    }
  }
}

// ---------- lado a lado ----------
function splitRows(lines: Line[]): SplitRow[] {
  const rows: SplitRow[] = []
  let k = 0
  while (k < lines.length) {
    const l = lines[k]
    if (l.kind === 'ctx') {
      rows.push({ left: l, right: l })
      k++
      continue
    }
    const dels: Line[] = []
    while (k < lines.length && lines[k].kind === 'del') dels.push(lines[k++])
    const adds: Line[] = []
    while (k < lines.length && lines[k].kind === 'add') adds.push(lines[k++])
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) rows.push({ left: dels[p], right: adds[p] })
  }
  return rows
}

// ---------- trechos: incluir/excluir ----------
const file = computed(() => state.activeFile)
/** só dá para escolher trechos de arquivos modificados que estão marcados para salvar */
const canPick = computed(
  () => !!file.value && (file.value.kind === 'modified' || file.value.kind === 'typechange') && parsed.value.hunks.length > 0 && !state.repo?.operation
)
watch(
  () => [file.value?.path, parsed.value.hunks.length] as const,
  ([path, count]) => {
    if (!path) return
    // se o arquivo mudou e o número de trechos também, a seleção antiga não vale mais
    if (state.hunkCounts[path] !== undefined && state.hunkCounts[path] !== count) delete state.excludedHunks[path]
    state.hunkCounts[path] = count
  },
  { immediate: true }
)
const included = (i: number) => !!file.value && state.selected.has(file.value.path) && !(state.excludedHunks[file.value.path] ?? []).includes(i)

const stats = computed(() => {
  let add = 0
  let del = 0
  for (const h of parsed.value.hunks) for (const l of h.lines) l.kind === 'add' ? add++ : l.kind === 'del' ? del++ : 0
  return { add, del }
})
</script>

<template>
  <div class="diff">
    <div v-if="!file" class="placeholder faint">
      Clique num arquivo para ver o que mudou.
      <button class="ghost icon small close-empty" title="Fechar" @click="setShowDiff(false)"><Icon name="x" :size="14" /></button>
    </div>
    <template v-else>
      <header>
        <span class="mono ellipsis path">
          <template v-if="file.origPath"><span class="faint">{{ file.origPath }} → </span></template>{{ file.path }}
        </span>
        <span v-if="isPartial(file.path)" class="partial" title="Só os trechos marcados vão para a próxima versão">parcial</span>
        <span class="add">+{{ stats.add }}</span>
        <span class="del">−{{ stats.del }}</span>
        <div class="seg" role="group" aria-label="Modo do diff">
          <button :class="{ on: state.diffMode === 'unified' }" title="Em linha" @click="setDiffMode('unified')"><Icon name="list" :size="13" /></button>
          <button :class="{ on: state.diffMode === 'split' }" title="Lado a lado (antes | depois)" @click="setDiffMode('split')"><Icon name="columns" :size="13" /></button>
        </div>
        <button class="ghost icon small" title="Fechar" @click="setShowDiff(false)"><Icon name="x" :size="14" /></button>
      </header>

      <div v-if="state.diffLoading" class="placeholder"><span class="spinner" /></div>
      <div v-else-if="!parsed.hunks.length" class="placeholder faint">
        {{ file.kind === 'deleted' ? 'Arquivo removido.' : parsed.meta[0] ?? 'Sem diferenças de texto (arquivo binário ou só permissão).' }}
      </div>
      <div v-else class="code" :class="state.diffMode">
        <p v-if="canPick && parsed.hunks.length > 1" class="tip faint">
          Desmarque um trecho para deixá-lo fora da próxima versão. Ele continua aqui para você salvar depois.
        </p>
        <section v-for="h in parsed.hunks" :key="h.index" class="hunk" :class="{ off: canPick && !included(h.index) }">
          <div class="hunk-head">
            <label v-if="canPick" class="pick" :title="included(h.index) ? 'Deixar este trecho fora da próxima versão' : 'Incluir este trecho na próxima versão'">
              <input type="checkbox" :checked="included(h.index)" @change="toggleHunk(file.path, h.index)" />
              {{ included(h.index) ? 'Incluir na versão' : 'Fora da versão' }}
            </label>
            <span class="mono faint where">
              linha {{ h.lines.find((l) => l.new !== undefined)?.new ?? h.lines[0]?.old }}<template v-if="h.header"> · {{ h.header }}</template>
            </span>
          </div>

          <table v-if="state.diffMode === 'unified'">
            <tbody>
              <tr v-for="(l, i) in h.lines" :key="i" :class="l.kind">
                <td class="ln">{{ l.old ?? '' }}</td>
                <td class="ln">{{ l.new ?? '' }}</td>
                <td class="txt"><span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span><span v-for="(s, k) in l.segs" :key="k" :class="{ hl: s.changed }">{{ s.text }}</span></td>
              </tr>
            </tbody>
          </table>

          <table v-else class="split-table">
            <tbody>
              <tr v-for="(r, i) in splitRows(h.lines)" :key="i">
                <td class="ln">{{ r.left?.old ?? '' }}</td>
                <td class="txt half" :class="r.left ? (r.left.kind === 'ctx' ? 'ctx' : 'del') : 'empty'"><span v-for="(s, k) in r.left?.segs ?? []" :key="k" :class="{ hl: s.changed }">{{ s.text }}</span></td>
                <td class="ln">{{ r.right?.new ?? '' }}</td>
                <td class="txt half" :class="r.right ? (r.right.kind === 'ctx' ? 'ctx' : 'add') : 'empty'"><span v-for="(s, k) in r.right?.segs ?? []" :key="k" :class="{ hl: s.changed }">{{ s.text }}</span></td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--panel); position: relative; }
header {
  display: flex; align-items: center; gap: 10px; flex: none; box-sizing: border-box;
  height: var(--pane-header); padding: 0 8px 0 14px; border-bottom: 1px solid var(--border);
}
.path { flex: 1; font-size: 12px; min-width: 0; }
.add { color: var(--add); font-family: var(--mono); font-size: 12px; }
.del { color: var(--del); font-family: var(--mono); font-size: 12px; }
.partial { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--mod); border: 1px solid color-mix(in srgb, var(--mod) 45%, transparent); padding: 1px 7px; border-radius: 999px; }
.seg { display: flex; padding: 2px; gap: 2px; background: var(--panel-2); border-radius: 8px; }
.seg button { height: 22px; width: 26px; padding: 0; border: 0; background: transparent; color: var(--muted); border-radius: 6px; }
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.icon.small { width: 26px; height: 26px; }
.placeholder { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
.close-empty { position: absolute; top: 8px; right: 8px; }
.code { flex: 1; overflow: auto; user-select: text; padding-bottom: 16px; }
.tip { margin: 10px 14px 0; font-size: 12px; }
.hunk { margin: 10px 10px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.hunk.off { opacity: 0.5; }
.hunk-head { display: flex; align-items: center; gap: 12px; padding: 5px 10px; background: var(--hunk-bg); color: var(--hunk); font-size: 12px; }
.pick { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; user-select: none; color: var(--text); }
.hunk.off .pick { color: var(--muted); }
.where { font-size: 11.5px; }
table { border-collapse: collapse; font-family: var(--mono); font-size: 12px; line-height: 20px; width: 100%; table-layout: auto; }
.split-table { table-layout: fixed; }
.split-table .ln { width: 44px; }
td { padding: 0; vertical-align: top; }
.ln { width: 1%; min-width: 40px; padding: 0 8px; text-align: right; color: var(--faint); user-select: none; white-space: nowrap; background: var(--panel); }
.txt { white-space: pre-wrap; word-break: break-all; padding-right: 16px; }
.unified .txt { white-space: pre; word-break: normal; }
.sign { display: inline-block; width: 18px; text-align: center; color: var(--faint); user-select: none; }
tr.add .txt, tr.add .ln, .txt.add { background: var(--add-bg); }
tr.add .sign { color: var(--add); }
tr.del .txt, tr.del .ln, .txt.del { background: var(--del-bg); }
tr.del .sign { color: var(--del); }
.txt.half { padding-left: 8px; }
.txt.empty { background: repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--border) 45%, transparent) 6px 7px); }
.hl { border-radius: 3px; }
tr.add .hl, .txt.add .hl { background: color-mix(in srgb, var(--add) 32%, transparent); }
tr.del .hl, .txt.del .hl { background: color-mix(in srgb, var(--del) 32%, transparent); }
</style>
