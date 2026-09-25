<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { alpha } from '@shared/themes'
import { api, setShowTerminal, state } from '../store'
import { currentTheme } from '../theme'
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
  const accent = v('--accent')
  return {
    background: v('--panel'),
    foreground: v('--text'),
    cursor: accent,
    cursorAccent: v('--panel'),
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? alpha(accent, 0.35) : 'rgba(127, 127, 127, 0.35)',
    ...(currentTheme().ansi ?? {})
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

const FALLBACK = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'
const fontFamily = () => {
  const name = (state.settings?.terminalFont ?? '').trim().replace(/["']/g, '')
  return name ? `"${name}", ${FALLBACK}` : FALLBACK
}
const fontSize = () => Math.min(Math.max(Number(state.settings?.terminalFontSize) || 14, 9), 28)
const fontWeight = () => ([400, 500, 600].includes(Number(state.settings?.terminalFontWeight)) ? Number(state.settings?.terminalFontWeight) : 500)
// negrito do terminal (ANSI bold) sempre um passo acima do peso normal
const fontWeightBold = () => Math.min(fontWeight() + 200, 700)

/** Garante a fonte carregada antes de medir as células (senão o xterm calcula com a fonte errada). */
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

onMounted(async () => {
  await loadFont()
  term = new Terminal({
    fontFamily: fontFamily(),
    fontSize: fontSize(),
    fontWeight: fontWeight(),
    fontWeightBold: fontWeightBold(),
    lineHeight: 1.15,
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
  // troca de tema (ou do claro/escuro do sistema no tema padrão)
  const onTheme = () => term && (term.options.theme = themeFromCss())
  window.addEventListener('ovrgit-theme', onTheme)
  offs.push(() => window.removeEventListener('ovrgit-theme', onTheme))
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
// fonte/tamanho alterados nas Configurações: aplica na hora
watch(
  () => [state.settings?.terminalFont, state.settings?.terminalFontSize, state.settings?.terminalFontWeight],
  async () => {
    if (!term) return
    await loadFont()
    term.options.fontFamily = fontFamily()
    term.options.fontSize = fontSize()
    term.options.fontWeight = fontWeight()
    term.options.fontWeightBold = fontWeightBold()
    refit()
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
/* suavização nativa do sistema (como Terminal/iTerm): o "antialiased" do resto do app afina demais o texto no Mac */
.host :deep(.xterm) { -webkit-font-smoothing: auto; -moz-osx-font-smoothing: auto; }
.host :deep(.xterm) { height: 100%; }
.host :deep(.xterm-viewport) { background: transparent !important; }
</style>
