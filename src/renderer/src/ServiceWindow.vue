<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { alpha } from '@shared/themes'
import type { Service, ServiceState, Settings } from '@shared/types'
import Icon from './components/Icon.vue'
import LogView from './components/LogView.vue'
import { applyTheme, currentTheme } from './theme'

/**
 * Janela secundária com a saída de um serviço. Dois jeitos de ver: o terminal (xterm, com entrada para prompts)
 * e o modo interativo, que lê cada linha (JSON ou texto) e mostra nível, hora, mensagem e campos, com filtro por
 * nível e busca. Fechar a janela não para o serviço.
 */
const api = window.ovseer
const id = new URLSearchParams(location.search).get('id') ?? ''
const service = ref<Service | null>(null)
const st = ref<ServiceState | null>(null)
const host = ref<HTMLElement>()
let term: Terminal | null = null
let fit: FitAddon | null = null
let settings: Settings | null = null
const offs: (() => void)[] = []
const now = ref(Date.now())

// ---------- aparência: a mesma fonte, tamanho e peso do terminal integrado ----------
const FALLBACK = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'
const fontFamily = () => {
  const name = (settings?.terminalFont ?? '').trim().replace(/["']/g, '')
  return name ? `"${name}", ${FALLBACK}` : FALLBACK
}
const fontSize = () => Math.min(Math.max(Number(settings?.terminalFontSize) || 14, 9), 28)
const fontWeight = () => ([400, 500, 600].includes(Number(settings?.terminalFontWeight)) ? Number(settings?.terminalFontWeight) : 500)
const fontWeightBold = () => Math.min(fontWeight() + 200, 700)
async function loadFont() {
  try {
    await Promise.all([
      document.fonts.load(`${fontWeight()} ${fontSize()}px ${fontFamily()}`),
      document.fonts.load(`${fontWeightBold()} ${fontSize()}px ${fontFamily()}`)
    ])
  } catch {
    /* fonte do sistema inexistente: usa a reserva */
  }
}
function applyFont() {
  if (!term) return
  term.options.fontFamily = fontFamily()
  term.options.fontSize = fontSize()
  term.options.fontWeight = fontWeight()
  term.options.fontWeightBold = fontWeightBold()
  fit?.fit()
  api.serviceResize(id, term.cols, term.rows)
}
function themeFromCss() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  const accent = v('--accent')
  return {
    background: v('--bg'),
    foreground: v('--text'),
    cursor: accent,
    cursorAccent: v('--bg'),
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? alpha(accent, 0.35) : 'rgba(127, 127, 127, 0.35)',
    ...(currentTheme().ansi ?? {})
  }
}

// ---------- estado ----------
const running = computed(() => st.value?.status === 'running')
const statusText = computed(() => {
  const s = st.value
  if (!s) return ''
  if (s.status === 'running') return 'rodando'
  if (s.status === 'exited') return s.exitCode === null ? 'encerrado' : s.exitCode === 0 ? 'encerrado' : `saiu com código ${s.exitCode}`
  return 'parado'
})
const uptime = computed(() => {
  const s = st.value
  if (!s?.startedAt || s.status !== 'running') return ''
  const sec = Math.max(0, Math.round((now.value - s.startedAt) / 1000))
  if (sec < 60) return `${sec} s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
})
const folder = computed(() => (service.value?.cwd ? service.value.cwd.replace(/^\/Users\/[^/]+/, '~') : ''))

// ---------- modo interativo: leitura amigável das linhas ----------
const view = ref<'term' | 'log'>((localStorage.getItem('ovseer.service.view') as 'term' | 'log') || 'term')
const logView = ref<InstanceType<typeof LogView>>()
/** Saída acumulada (sem cor), para o modo interativo começar com o histórico quando é ligado depois */
let history = ''
watch(view, (v) => {
  localStorage.setItem('ovseer.service.view', v)
  if (v === 'term') nextTick(() => (fit?.fit(), term?.focus()))
  else nextTick(() => logView.value?.reset(history))
})
function feed(data: string) {
  history = (history + data).slice(-400_000)
  logView.value?.feed(data)
}
function clearAll() {
  history = ''
  logView.value?.reset('')
  term?.clear()
}

// ---------- ligação com o serviço ----------
async function attach() {
  if (!term || !fit) return
  fit.fit()
  const r = await api.serviceAttach(id, term.cols, term.rows)
  service.value = r.service
  st.value = r.state
  document.title = r.service ? `${r.service.name} · Serviço` : 'Serviço'
  term.reset()
  history = ''
  logView.value?.reset('')
  if (r.buffer) {
    term.write(r.buffer)
    feed(r.buffer)
  }
}
async function start() {
  await api.serviceStart(id)
  await attach()
}
const stop = () => api.serviceStop(id)

onMounted(async () => {
  settings = await api.getSettings().catch(() => null)
  applyTheme(settings?.theme)
  await loadFont()
  term = new Terminal({
    fontFamily: fontFamily(),
    fontSize: fontSize(),
    fontWeight: fontWeight(),
    fontWeightBold: fontWeightBold(),
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    theme: themeFromCss()
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
  term.open(host.value!)
  term.onData((d) => api.serviceWrite(id, d))
  const ro = new ResizeObserver(() => {
    if (view.value !== 'term') return
    fit?.fit()
    if (term) api.serviceResize(id, term.cols, term.rows)
  })
  ro.observe(host.value!)
  offs.push(() => ro.disconnect())
  offs.push(
    api.onServiceData((sid, data) => {
      if (sid !== id) return
      term?.write(data)
      feed(data)
    })
  )
  offs.push(
    api.onServicesChanged((states) => {
      const next = states.find((s) => s.id === id) ?? null
      const restarted = next?.status === 'running' && st.value?.status !== 'running'
      st.value = next
      if (restarted) attach()
    })
  )
  offs.push(
    api.onSettingsChanged(async (s) => {
      settings = s
      applyTheme(s.theme)
      if (term) term.options.theme = themeFromCss()
      await loadFont()
      applyFont()
    })
  )
  const tick = setInterval(() => (now.value = Date.now()), 10_000)
  offs.push(() => clearInterval(tick))
  await attach()
  if (view.value === 'term') term.focus()
  else nextTick(() => logView.value?.reset(history))
})
onUnmounted(() => offs.forEach((f) => f()))
</script>

<template>
  <div class="svc">
    <header class="bar">
      <span class="tile" :class="st?.status"><Icon name="server" :size="15" /></span>
      <div class="head-text">
        <span class="title ellipsis">{{ service?.name ?? 'Serviço' }}</span>
        <span class="sub ellipsis" :title="service?.command">
          <span class="state" :class="st?.status"><i class="dot" />{{ statusText }}</span>
          <template v-if="uptime"> · há {{ uptime }}</template>
          <template v-if="st?.pid"> · pid {{ st.pid }}</template>
          <template v-if="folder"> · <Icon name="folder" :size="10" /> {{ folder }}</template>
        </span>
      </div>
      <span v-if="st?.ports?.length" class="ports">
        <button v-for="p in st.ports" :key="p" type="button" class="port" :title="`Abrir http://localhost:${p}`" @click="api.openExternal(`http://localhost:${p}`)">:{{ p }}</button>
      </span>
      <span class="spacer" />
      <div class="seg" role="group" aria-label="Modo de leitura">
        <button type="button" :class="{ on: view === 'term' }" title="Terminal: a saída como ela é, com entrada para prompts" @click="view = 'term'"><Icon name="terminal" :size="12" /> Terminal</button>
        <button type="button" :class="{ on: view === 'log' }" title="Modo interativo: cada linha lida (JSON e texto) com nível, hora e campos; filtro e busca" @click="view = 'log'"><Icon name="listChecks" :size="12" /> Interativo</button>
      </div>
      <button type="button" class="ghost icon head-btn" title="Limpar a tela" @click="clearAll"><Icon name="trash" :size="13" /></button>
      <button type="button" class="ghost icon head-btn" title="Acoplar: este terminal volta como aba do painel do Ovseer" @click="api.serviceReattach(id)"><Icon name="panelBottom" :size="13" /></button>
      <button v-if="running" type="button" class="small stop" title="Parar o serviço" @click="stop"><Icon name="stop" :size="12" /> Parar</button>
      <button v-else type="button" class="small primary" title="Iniciar o serviço" @click="start"><Icon name="play" :size="12" /> Iniciar</button>
    </header>

    <!-- o terminal fica montado mesmo escondido: guarda a saída e o cursor -->
    <div v-show="view === 'term'" ref="host" class="term" />

    <LogView v-if="view === 'log'" ref="logView" />
  </div>
</template>

<style scoped>
.svc { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
.bar {
  height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 14px; flex: none;
  border-bottom: 1px solid var(--border); background: var(--panel);
}
/* a janela tem a barra de título do sistema: o cabeçalho não precisa de margem para os botões dela */
.tile { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--panel-2); color: var(--muted); flex: none; }
.tile.running { color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); }
.tile.exited { color: var(--mod); background: color-mix(in srgb, var(--mod) 14%, transparent); }
.head-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; line-height: 1.2; }
.title { font-size: 13.5px; font-weight: 700; }
.sub { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 4px; }
.sub svg { vertical-align: -1px; }
.state { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.state .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.state.running { color: var(--add); }
.state.running .dot { background: var(--add); box-shadow: 0 0 0 3px color-mix(in srgb, var(--add) 25%, transparent); }
.state.exited { color: var(--mod); }
.state.exited .dot { background: var(--mod); }
.ports { display: inline-flex; gap: 4px; flex: none; }
.port {
  height: 24px; padding: 0 9px; border-radius: 999px; font-family: var(--mono); font-size: 12px; font-weight: 700;
  color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); border: 1px solid color-mix(in srgb, var(--add) 40%, transparent);
}
.port:hover { background: color-mix(in srgb, var(--add) 24%, transparent); }
.spacer { flex: 1; }
.seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--border); }
.seg button { height: 26px; padding: 0 10px; gap: 6px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 12px; font-weight: 600; }
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); }
.head-btn { width: 28px; height: 28px; border-radius: 8px; color: var(--muted); flex: none; }
.small { height: 28px; gap: 6px; font-size: 12px; flex: none; }
.stop { color: var(--del); border-color: color-mix(in srgb, var(--del) 45%, var(--border)); }
.term { flex: 1; min-height: 0; position: relative; padding: 8px 4px 8px 10px; }
.term :deep(.xterm) { height: 100%; }

/* modo interativo */
.log { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.log-bar { display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 12px; border-bottom: 1px solid var(--border); flex: none; }
.cnt { margin-left: 4px; padding: 0 5px; border-radius: 999px; font-family: var(--mono); font-size: 10px; }
.cnt.warn { background: color-mix(in srgb, var(--mod) 20%, transparent); color: var(--mod); }
.cnt.error { background: color-mix(in srgb, var(--del) 20%, transparent); color: var(--del); }
.search { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); width: min(320px, 40%); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; font-size: 12.5px; color: var(--text); }
.search input:focus { box-shadow: none; }
.log-list { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px 12px; font-size: 12.5px; }
.none { margin: 20px 0; text-align: center; }
.row { display: grid; grid-template-columns: 62px 44px minmax(0, 1fr) 44px; gap: 8px; align-items: start; padding: 4px 8px; border-radius: 6px; line-height: 1.45; }
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
.text { white-sp