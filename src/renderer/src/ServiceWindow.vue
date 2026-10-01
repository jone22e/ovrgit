<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { alpha } from '@shared/themes'
import type { Service, ServiceState, Settings } from '@shared/types'
import Icon from './components/Icon.vue'
import { applyTheme, currentTheme } from './theme'

/**
 * Janela secundária com o terminal de um serviço: mostra a saída acumulada e a ao vivo, aceita entrada
 * (para prompts) e tem os botões de parar/iniciar. Fechar a janela não para o serviço.
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

const FALLBACK = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'
const fontFamily = () => {
  const name = (settings?.terminalFont ?? '').trim().replace(/["']/g, '')
  return name ? `"${name}", ${FALLBACK}` : FALLBACK
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

const running = computed(() => st.value?.status === 'running')
const statusText = computed(() => {
  const s = st.value
  if (!s) return ''
  if (s.status === 'running') return `rodando · pid ${s.pid}`
  if (s.status === 'exited') return s.exitCode === null ? 'encerrado' : `saiu com código ${s.exitCode}`
  return 'parado'
})

async function attach() {
  if (!term || !fit) return
  fit.fit()
  const r = await api.serviceAttach(id, term.cols, term.rows)
  service.value = r.service
  st.value = r.state
  document.title = r.service ? `${r.service.name} · Serviço` : 'Serviço'
  term.reset()
  if (r.buffer) term.write(r.buffer)
}

async function start() {
  await api.serviceStart(id)
  // o processo novo: reata a saída (a janela antiga ficou presa ao processo anterior)
  await attach()
}
function stop() {
  api.serviceStop(id)
}

onMounted(async () => {
  settings = await api.getSettings().catch(() => null)
  applyTheme(settings?.theme)
  const fontSize = Math.min(Math.max(Number(settings?.terminalFontSize) || 14, 9), 28)
  term = new Terminal({
    fontFamily: fontFamily(),
    fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    convertEol: false,
    theme: themeFromCss()
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
  term.open(host.value!)
  term.onData((d) => api.serviceWrite(id, d))
  const ro = new ResizeObserver(() => {
    fit?.fit()
    if (term) api.serviceResize(id, term.cols, term.rows)
  })
  ro.observe(host.value!)
  offs.push(() => ro.disconnect())
  offs.push(api.onServiceData((sid, data) => sid === id && term?.write(data)))
  offs.push(
    api.onServicesChanged((states) => {
      const next = states.find((s) => s.id === id) ?? null
      // começou de novo por outra janela: reata para ver a saída do processo novo
      const restarted = next?.status === 'running' && st.value?.status !== 'running'
      st.value = next
      if (restarted) attach()
    })
  )
  offs.push(api.onSettingsChanged((s) => ((settings = s), applyTheme(s.theme), term && (term.options.theme = themeFromCss()))))
  await attach()
  term.focus()
})
onUnmounted(() => offs.forEach((f) => f()))
</script>

<template>
  <div class="svc">
    <header class="bar">
      <Icon name="play" :size="14" class="faint" />
      <div class="head-text">
        <span class="title ellipsis">{{ service?.name ?? 'Serviço' }}</span>
        <span class="sub ellipsis" :title="service?.command">{{ statusText }}<template v-if="service?.cwd"> · {{ service.cwd }}</template></span>
      </div>
      <span class="spacer" />
      <button v-if="running" type="button" class="small stop" title="Parar o serviço" @click="stop"><Icon name="stop" :size="12" /> Parar</button>
      <button v-else type="button" class="small primary" title="Iniciar o serviço" @click="start"><Icon name="play" :size="12" /> Iniciar</button>
    </header>
    <div ref="host" class="term" />
  </div>
</template>

<style scoped>
.svc { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
.bar {
  height: var(--titlebar); display: flex; align-items: center; gap: 10px; padding: 0 14px; flex: none;
  border-bottom: 1px solid var(--border); background: var(--panel); -webkit-app-region: drag;
}
:root[data-platform='darwin'] .bar { padding-left: 90px; }
:root[data-platform='win32'] .bar, :root[data-platform='linux'] .bar { padding-right: 146px; }
.bar button { -webkit-app-region: no-drag; }
.head-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.title { font-size: 13px; font-weight: 700; }
.sub { font-size: 11px; color: var(--muted); }
.spacer { flex: 1; }
.small { height: 26px; gap: 6px; font-size: 12px; }
.stop { color: var(--del); border-color: color-mix(in srgb, var(--del) 45%, var(--border)); }
.term { flex: 1; min-height: 0; position: relative; padding: 8px 4px 8px 10px; }
.term :deep(.xterm) { height: 100%; }
</style>
