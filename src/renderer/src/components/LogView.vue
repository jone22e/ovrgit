<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { parseLogLine, type LogEntry, type LogLevel } from '@shared/logs'
import Icon from './Icon.vue'

/**
 * Modo interativo de leitura de saída: cada linha (JSON ou texto) vira um registro com hora, nível, mensagem e
 * campos; filtro por nível, contadores, busca, cópia e acompanhamento do fim. Quem usa alimenta com `feed` e
 * zera (ou recomeça de um histórico) com `reset`.
 */
const MAX_LINES = 4000
/** Por quanto tempo uma linha fica na lista (um terminal aberto o dia todo não acumula tudo); 0 = sempre */
const KEEP_KEY = 'logKeepMin'
const keepOptions = [
  { min: 5, label: '5 min' },
  { min: 15, label: '15 min' },
  { min: 60, label: '1 hora' },
  { min: 0, label: 'Tudo' }
]
const keepMin = ref(Number(localStorage.getItem(KEEP_KEY) ?? 15) || 0)
function setKeep(min: number) {
  keepMin.value = min
  localStorage.setItem(KEEP_KEY, String(min))
  prune()
}
/** Descarta as linhas mais velhas que o prazo escolhido */
function prune() {
  if (!keepMin.value) return
  const limit = Date.now() - keepMin.value * 60_000
  const first = entries.value.findIndex((e) => e.at >= limit)
  if (first === -1) entries.value = []
  else if (first > 0) entries.value.splice(0, first)
}
const entries = ref<(LogEntry & { n: number; at: number })[]>([])
let seq = 0
let partial = ''
/** Alimenta as linhas a partir do texto bruto (pedaços podem cortar uma linha ao meio) */
function feed(data: string) {
  const text = partial + data.replace(/\r\n?/g, '\n')
  const parts = text.split('\n')
  partial = parts.pop() ?? ''
  const at = Date.now()
  const add = parts.filter((l) => l.trim()).map((l) => ({ ...parseLogLine(l), n: seq++, at }))
  if (!add.length) return
  entries.value.push(...add)
  if (entries.value.length > MAX_LINES) entries.value.splice(0, entries.value.length - MAX_LINES)
  prune()
  if (follow.value) nextTick(scrollLog)
}
const levels: { id: LogLevel | 'all'; label: string; icon: 'list' | 'info' | 'circleAlert' | 'circleX' }[] = [
  { id: 'all', label: 'Tudo', icon: 'list' },
  { id: 'info', label: 'Info e acima', icon: 'info' },
  { id: 'warn', label: 'Avisos e erros', icon: 'circleAlert' },
  { id: 'error', label: 'Só erros', icon: 'circleX' }
]
const minLevel = ref<LogLevel | 'all'>('all')
const RANK: Record<LogLevel, number> = { none: 1, trace: 0, debug: 0, info: 1, warn: 2, error: 3, fatal: 3 }
const MIN: Record<string, number> = { all: -1, info: 1, warn: 2, error: 3 }
const query = ref('')
const plain = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const shown = computed(() => {
  const min = MIN[minLevel.value]
  const words = plain(query.value).split(/\s+/).filter(Boolean)
  return entries.value.filter((e) => RANK[e.level] >= min && (!words.length || words.every((w) => plain(e.raw).includes(w))))
})
const counts = computed(() => {
  const c = { warn: 0, error: 0 }
  for (const e of entries.value) {
    if (e.level === 'warn') c.warn++
    else if (e.level === 'error' || e.level === 'fatal') c.error++
  }
  return c
})
const expanded = ref(new Set<number>())
const toggle = (n: number) => (expanded.value.has(n) ? expanded.value.delete(n) : expanded.value.add(n))
const logEl = ref<HTMLElement>()
const follow = ref(true)
function scrollLog() {
  const el = logEl.value
  if (el) el.scrollTop = el.scrollHeight
}
function onLogScroll() {
  const el = logEl.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 60 ? `${s.slice(0, 57)}…` : s
}
const LEVEL_LABEL: Record<LogLevel, string> = { trace: 'trace', debug: 'debug', info: 'info', warn: 'warn', error: 'error', fatal: 'fatal', none: '' }
const copied = ref<number | null>(null)
/** Copia a linha original (o JSON inteiro ou o texto) */
async function copyLine(e: LogEntry & { n: number; at: number }) {
  try {
    await navigator.clipboard.writeText(e.raw)
    copied.value = e.n
    setTimeout(() => copied.value === e.n && (copied.value = null), 1200)
  } catch {
    /* sem área de transferência */
  }
}
/** Recomeça (opcionalmente a partir de um histórico já acumulado) */
function reset(history = '') {
  entries.value = []
  partial = ''
  expanded.value.clear()
  if (history) feed(history)
  nextTick(scrollLog)
}
defineExpose({ feed, reset })
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nextTick(scrollLog)
  timer = setInterval(prune, 30_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="log">
      <div class="log-bar">
        <div class="seg" role="group" aria-label="Nível">
          <button v-for="l in levels" :key="l.id" type="button" :class="[l.id, { on: minLevel === l.id }]" :title="l.label" :aria-label="l.label" @click="minLevel = l.id">
            <Icon :name="l.icon" :size="14" />
            <b v-if="l.id === 'warn' && counts.warn" class="cnt warn">{{ counts.warn > 999 ? '999+' : counts.warn }}</b>
            <b v-if="l.id === 'error' && counts.error" class="cnt error">{{ counts.error > 999 ? '999+' : counts.error }}</b>
          </button>
        </div>
        <label class="search">
          <Icon name="search" :size="13" class="faint" />
          <input v-model="query" type="text" placeholder="Buscar nas linhas" spellcheck="false" />
        </label>
        <span class="spacer" />
        <label class="keep" title="Linhas mais velhas que isso são descartadas">
          <Icon name="history" :size="12" class="faint" />
          <select :value="keepMin" @change="setKeep(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="o in keepOptions" :key="o.min" :value="o.min">{{ o.label }}</option>
          </select>
        </label>
        <small class="faint">{{ shown.length === entries.length ? `${entries.length} linhas` : `${shown.length} de ${entries.length} linhas` }}</small>
        <button v-if="!follow" type="button" class="small" title="Voltar a acompanhar o fim" @click="(follow = true), scrollLog()"><Icon name="down" :size="12" /> Seguir</button>
      </div>
      <div ref="logEl" class="log-list" @scroll="onLogScroll">
        <p v-if="!shown.length" class="faint none">{{ entries.length ? 'Nenhuma linha com esse filtro.' : 'Sem saída ainda.' }}</p>
        <div v-for="e in shown" :key="e.n" class="row" :class="[e.level, { open: expanded.has(e.n), json: e.json, plain: e.level === 'none' && !e.time }]" @click="e.json && toggle(e.n)">
          <!-- sem hora nem nível: a mensagem ocupa a linha inteira, como saída comum -->
          <span v-if="!(e.level === 'none' && !e.time)" class="time mono">{{ e.time ?? '' }}</span>
          <span v-if="!(e.level === 'none' && !e.time)" class="lvl" :class="e.level">{{ LEVEL_LABEL[e.level] || '·' }}</span>
          <span class="msg">
            <span class="text">{{ e.message }}</span>
            <span v-if="e.fields && !expanded.has(e.n)" class="chips">
              <span v-for="(v, k) in e.fields" :key="k" class="chip" :title="pretty(v)"><b>{{ k }}</b>{{ short(v) }}</span>
            </span>
            <pre v-if="e.fields && expanded.has(e.n)" class="mono detail">{{ pretty(e.fields) }}</pre>
          </span>
          <span class="row-acts" @click.stop>
            <button type="button" class="ghost icon copy" :class="{ done: copied === e.n }" :title="copied === e.n ? 'Copiado' : 'Copiar a linha'" @click="copyLine(e)"><Icon :name="copied === e.n ? 'check' : 'clipboard'" :size="11" /></button>
            <Icon v-if="e.json" name="chevron" :size="11" class="chev" />
          </span>
        </div>
      </div>
  </div>
</template>

<style scoped>
/* modo interativo */
.log { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.log-bar { display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 12px; border-bottom: 1px solid var(--border); flex: none; }
/* grupo de ícones: um botão por nível, o escolhido com fundo; o contador de avisos/erros é uma etiqueta pequena */
.seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--border); }
.seg button { position: relative; width: 32px; height: 26px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--muted); display: grid; place-items: center; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); }
.seg button.warn.on { color: var(--mod); }
.seg button.error.on { color: var(--del); }
.cnt { position: absolute; top: -6px; right: -6px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; display: inline-grid; place-items: center; font-family: var(--mono); font-size: 9.5px; font-weight: 700; border: 2px solid var(--bg); line-height: 1; }
.cnt.warn { background: color-mix(in srgb, var(--mod) 20%, transparent); color: var(--mod); }
.cnt.error { background: color-mix(in srgb, var(--del) 20%, transparent); color: var(--del); }
.search { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); width: min(320px, 40%); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; font-size: 12.5px; color: var(--text); }
.search input:focus { box-shadow: none; }
.keep { display: inline-flex; align-items: center; gap: 4px; }
.keep select { height: 24px; padding: 0 4px; border: 0; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
.keep select:hover { color: var(--text); }
.log-list { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px 12px; font-size: 12.5px; }
.none { margin: 20px 0; text-align: center; }
.row { display: grid; grid-template-columns: 62px 44px minmax(0, 1fr) 44px; gap: 8px; align-items: start; padding: 4px 8px; border-radius: 6px; line-height: 1.45; }
.row.plain .msg { grid-column: 1 / 4; }
.row.plain .text { color: var(--muted); }
.row-acts { display: inline-flex; align-items: center; justify-content: flex-end; gap: 2px; }
/* copiar: discreto, só ao passar o mouse na linha */
.copy { width: 22px; height: 22px; border-radius: 6px; color: var(--faint); opacity: 0; transition: opacity 0.1s; }
.row:hover .copy, .copy.done { opacity: 1; }
.copy:hover { color: var(--text); }
.copy.done { color: var(--add); }
.row.json { cursor: pointer; }
.row:hover { background: var(--hover); }
.row.open { background: var(--panel); }
.row.warn { background: color-mix(in srgb, var(--mod) 6%, transparent); }
.row.error, .row.fatal { background: color-mix(in srgb, var(--del) 7%, transparent); }
.time { color: var(--faint); font-size: 11.5px; padding-top: 1px; }
.lvl { font-family: var(--mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase; padding-top: 2px; color: var(--faint); }
.lvl.info { color: var(--accent); }
.lvl.warn { color: var(--mod); }
.lvl.error, .lvl.fatal { color: var(--del); }
.lvl.debug, .lvl.trace { color: var(--faint); }
.msg { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.row.warn .text { color: color-mix(in srgb, var(--mod) 70%, var(--text)); }
.row.error .text, .row.fatal .text { color: color-mix(in srgb, var(--del) 70%, var(--text)); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { display: inline-flex; gap: 4px; align-items: baseline; max-width: 100%; padding: 1px 7px; border-radius: 6px; background: var(--panel-2); font-family: var(--mono); font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip b { color: var(--text); font-weight: 600; }
.detail { margin: 2px 0 4px; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.chev { color: var(--faint); transform: rotate(90deg); transition: transform 0.15s; }
.row.open .chev { transform: rotate(-90deg); }
</style>
