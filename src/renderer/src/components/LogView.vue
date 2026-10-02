<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { isReadyLine, parseLogLine, restartOf, type LogEntry, type LogLevel, type RestartInfo } from '@shared/logs'
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
/** Reinício do processo (watcher de desenvolvimento): gira até o serviço voltar a dar sinal */
interface Restart extends RestartInfo {
  startedAt: number
  /** Quando voltou; ausente enquanto reinicia */
  doneAt?: number
  /** Sem como medir quanto levou (veio do histórico, ou outro reinício começou por cima) */
  unmeasured?: boolean
  /** Não veio nenhuma saída depois do reinício: não dá para afirmar que voltou */
  silent?: boolean
}
type Row = LogEntry & { n: number; at: number; restart?: Restart }
const entries = ref<Row[]>([])
// reinício em andamento: fecha na linha de "voltou a atender", ou depois de um instante de silêncio após
// a primeira saída nova, ou quando outro reinício começa; sem nenhuma saída, desiste em 30 s
let openRestart: number | null = null
let quietTimer: ReturnType<typeof setTimeout> | undefined
let giveUpTimer: ReturnType<typeof setTimeout> | undefined
const QUIET_MS = 2500
const GIVE_UP_MS = 30_000
/** `batch`: linhas ainda não incluídas em `entries` (o reinício em aberto pode estar no lote que está chegando) */
function closeRestart(doneAt: number, unmeasured = false, batch: Row[] = []) {
  clearTimeout(quietTimer)
  clearTimeout(giveUpTimer)
  const row = openRestart === null ? undefined : (batch.find((e) => e.n === openRestart) ?? entries.value.find((e) => e.n === openRestart))
  openRestart = null
  if (row?.restart && !row.restart.doneAt) {
    row.restart.doneAt = doneAt
    if (unmeasured) row.restart.unmeasured = true
  }
}
/** Marca os reinícios nas linhas novas e acompanha o que está em andamento. `historical`: linhas antigas, sem hora de chegada real */
function trackRestarts(add: Row[], historical: boolean) {
  let sawOutput = false
  for (const e of add) {
    const r = e.json ? null : restartOf(e.message)
    if (r) {
      closeRestart(e.at, true, add)
      e.restart = { ...r, startedAt: e.at }
      openRestart = e.n
      sawOutput = false
    } else if (openRestart !== null) {
      if (isReadyLine(e.message)) closeRestart(e.at, historical, add)
      else sawOutput = true
    }
  }
  if (openRestart === null) return
  const n = openRestart
  const inBatch = add.find((x) => x.n === n)
  // histórico com saída depois do reinício: já voltou faz tempo
  if (historical && sawOutput) return closeRestart(inBatch?.at ?? Date.now(), true, add)
  if (sawOutput) {
    clearTimeout(quietTimer)
    const last = Date.now()
    quietTimer = setTimeout(() => openRestart === n && closeRestart(last), QUIET_MS)
  }
  if (inBatch) {
    clearTimeout(giveUpTimer)
    giveUpTimer = setTimeout(() => {
      if (openRestart !== n) return
      const row = entries.value.find((e) => e.n === n)
      if (row?.restart) row.restart.silent = true
      closeRestart(Date.now(), true)
    }, GIVE_UP_MS)
  }
}
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const took = (r: Restart) => {
  if (!r.doneAt || r.unmeasured) return ''
  const s = (r.doneAt - r.startedAt) / 1000
  return s < 0.05 ? '' : `em ${s < 10 ? s.toFixed(1).replace('.', ',') : Math.round(s)} s`
}
let seq = 0
let partial = ''
/** Alimenta as linhas a partir do texto bruto (pedaços podem cortar uma linha ao meio) */
function feed(data: string, historical = false) {
  const text = partial + data.replace(/\r\n?/g, '\n')
  const parts = text.split('\n')
  partial = parts.pop() ?? ''
  const at = Date.now()
  const add: Row[] = parts.filter((l) => l.trim()).map((l) => ({ ...parseLogLine(l), n: seq++, at }))
  if (!add.length) return
  trackRestarts(add, historical)
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
async function copyLine(e: Row) {
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
  closeRestart(Date.now(), true)
  if (history) feed(history, true)
  nextTick(scrollLog)
}
defineExpose({ feed: (data: string) => feed(data), reset })
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nextTick(scrollLog)
  timer = setInterval(prune, 30_000)
})
onUnmounted(() => {
  clearInterval(timer)
  clearTimeout(quietTimer)
  clearTimeout(giveUpTimer)
})
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
        <div v-for="e in shown" :key="e.n" class="row" :class="[e.level, { open: expanded.has(e.n), json: e.json, plain: e.level === 'none' && !e.time && !e.restart, restart: e.restart, back: e.restart?.doneAt && !e.restart.silent, quiet: e.restart?.silent }]" @click="e.json && toggle(e.n)">
          <!-- sem hora nem nível: a mensagem ocupa a linha inteira, como saída comum -->
          <span v-if="e.restart || !(e.level === 'none' && !e.time)" class="time mono">{{ e.time ?? '' }}</span>
          <!-- reinício do processo: gira até o serviço voltar; depois diz quanto levou -->
          <span v-if="e.restart" class="rs" :title="e.message">
            <span v-if="!e.restart.doneAt" class="rs-ring" />
            <Icon v-else-if="!e.restart.silent" name="check" :size="13" class="rs-ok" />
            <strong>{{ !e.restart.doneAt ? 'Reiniciando…' : e.restart.silent ? 'Reinício' : 'Reiniciado' }}</strong>
            <small v-if="e.restart.silent" class="faint">sem saída depois</small>
            <span v-if="e.restart.file" class="chip" :title="e.restart.file">{{ baseName(e.restart.file) }}</span>
            <small v-if="took(e.restart)" class="faint">{{ took(e.restart) }}</small>
            <small v-if="e.restart.tool" class="faint rs-tool">{{ e.restart.tool }}</small>
          </span>
          <span v-if="!e.restart && !(e.level === 'none' && !e.time)" class="lvl" :class="e.level">{{ LEVEL_LABEL[e.level] || '·' }}</span>
          <span v-if="!e.restart" class="msg">
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
/* aviso de lista vazia; restrito ao parágrafo: as linhas sem nível também têm a classe "none" */
p.none { margin: 20px 0; text-align: center; }
.row { display: grid; grid-template-columns: 62px 44px minmax(0, 1fr) 44px; gap: 8px; align-items: start; padding: 4px 8px; border-radius: 6px; line-height: 1.45; }
.row.plain .msg { grid-column: 1 / 4; }
.row.plain .text { color: var(--muted); }
/* reinício: faixa própria, com o arco girando (o mesmo das tarefas) enquanto o serviço não volta */
.row.restart { align-items: center; margin: 4px 0; background: color-mix(in srgb, var(--accent) 8%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
.row.restart.back { background: color-mix(in srgb, var(--add) 6%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--add) 18%, transparent); }
.row.restart.quiet { background: var(--panel); box-shadow: inset 0 0 0 1px var(--border); }
.row.restart.quiet .rs strong { color: var(--muted); }
.row.restart .time { padding-top: 0; }
.rs { grid-column: 2 / 4; display: flex; align-items: center; gap: 8px; min-width: 0; }
.rs strong { font-size: 12.5px; font-weight: 600; color: var(--accent); flex: none; }
.row.restart.back .rs strong { color: var(--add); }
.rs .chip { flex: 0 1 auto; min-width: 0; }
.rs small { font-size: 11.5px; flex: none; }
.rs-tool { margin-left: auto; font-family: var(--mono); }
.rs-ok { color: var(--add); flex: none; }
.rs-ring {
  width: 14px; height: 14px; border-radius: 50%; flex: none; box-sizing: border-box;
  border: 2.5px solid color-mix(in srgb, var(--faint) 30%, transparent); border-top-color: var(--accent); border-right-color: var(--accent);
  animation: rs-turn 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
@keyframes rs-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rs-ring { animation: none; } }
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
