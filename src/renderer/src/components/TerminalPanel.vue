<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, setShowTerminal, state } from '../store'
import Icon from './Icon.vue'

const host = ref<HTMLDivElement>()
const exited = ref(false)
let term: Terminal | null = null
let fit: FitAddon | null = null
let id: number | null = null
const offs: (() => void)[] = []

function themeFromCss() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--panel'),
    foreground: v('--text'),
    cursor: v('--accent'),
    cursorAccent: v('--panel'),
    selectionBackground: 'rgba(169, 116, 248, 0.35)'
  }
}

async function start() {
  if (!term || !fit) return
  exited.value = false
  fit.fit()
  id = await api.termCreate(term.cols, term.rows)
}

async function restart() {
  if (id !== null) await api.termKill(id)
  id = null
  term?.reset()
  await start()
}

function refit() {
  if (!fit || !term || !host.value?.offsetParent) return
  fit.fit()
  if (id !== null) api.termResize(id, term.cols, term.rows)
}

onMounted(async () => {
  term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: 12.5,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: false,
    scrollback: 5000,
    theme: themeFromCss()
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value!)
  term.onData((data) => {
    if (exited.value) {
      if (data === '\r') restart()
      return
    }
    if (id !== null) api.termWrite(id, data)
  })
  offs.push(
    api.onTermData((tid, data) => {
      if (tid === id) term?.write(data)
    }),
    api.onTermExit((tid) => {
      if (tid !== id) return
      id = null
      exited.value = true
      term?.write('\r\n\x1b[2m[processo encerrado — pressione Enter para abrir outro]\x1b[0m\r\n')
    })
  )
  const ro = new ResizeObserver(() => refit())
  ro.observe(host.value!)
  offs.push(() => ro.disconnect())
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => term && (term.options.theme = themeFromCss())
  mq.addEventListener('change', onScheme)
  offs.push(() => mq.removeEventListener('change', onScheme))
  await start()
  term.focus()
})

// ao trocar de projeto, o terminal reabre na pasta nova
watch(
  () => state.repo?.root,
  (root, prev) => {
    if (root && prev && root !== prev) restart()
  }
)
// foca ao reabrir o painel
watch(
  () => state.showTerminal,
  (on) => {
    if (on)
      requestAnimationFrame(() => {
        refit()
        term?.focus()
      })
  }
)

onUnmounted(() => {
  offs.forEach((off) => off())
  if (id !== null) api.termKill(id)
  term?.dispose()
})
</script>

<template>
  <section class="terminal">
    <header>
      <span class="title">Terminal</span>
      <span class="faint cwd ellipsis mono">{{ state.repo?.root }}</span>
      <span class="spacer" />
      <button class="ghost icon small" title="Reiniciar o terminal" @click="restart"><Icon name="refresh" :size="13" /></button>
      <button class="ghost icon small" title="Fechar o terminal (Ctrl+`)" @click="setShowTerminal(false)"><Icon name="x" :size="14" /></button>
    </header>
    <div ref="host" class="host" />
  </section>
</template>

<style scoped>
.terminal { display: flex; flex-direction: column; height: 100%; background: var(--panel); min-height: 0; }
header {
  display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 12px; flex: none;
  border-bottom: 1px solid var(--border);
}
.title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; color: var(--muted); }
.cwd { font-size: 11px; min-width: 0; }
.spacer { flex: 1; }
.icon.small { width: 26px; height: 24px; }
.host { flex: 1; min-height: 0; padding: 6px 0 0 10px; user-select: text; }
.host :deep(.xterm) { height: 100%; }
.host :deep(.xterm-viewport) { background: transparent !important; }
</style>
