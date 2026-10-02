<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onMounted, onUnmounted, ref } from 'vue'
import { alpha } from '@shared/themes'
import type { Settings, TerminalSpec } from '@shared/types'
import Icon from './components/Icon.vue'
import { applyTheme, currentTheme } from './theme'

/**
 * Terminal desacoplado: uma aba do painel em janela própria. A sessão (shell ou SSH) é a mesma; só a janela que a
 * mostra muda. "Acoplar" devolve a aba ao painel do app.
 */
const api = window.ovseer
const id = Number(new URLSearchParams(location.search).get('id') ?? 0)
const title = ref('Terminal')
const spec = ref<TerminalSpec | null>(null)
const cwd = ref('')
const exited = ref(false)
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
const fontSize = () => Math.min(Math.max(Number(settings?.terminalFontSize) || 14, 9), 28)
const fontWeight = () => ([400, 500, 600].includes(Number(settings?.terminalFontWeight)) ? Number(settings?.terminalFontWeight) : 500)
const fontWeightBold = () => Math.min(fontWeight() + 200, 700)
async function loadFont() {
  try {
    await Promise.all([document.fonts.load(`${fontWeight()} ${fontSize()}px ${fontFamily()}`), document.fonts.load(`${fontWeightBold()} ${fontSize()}px ${fontFamily()}`)])
  } catch {
    /* fonte do sistema inexistente: usa a reserva */
  }
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
const resize = () => {
  fit?.fit()
  if (term && !exited.value) api.termResize(id, term.cols, term.rows)
}
async function reattach() {
  const ok = await api.termReattach(id)
  if (!ok) window.close()
}

onMounted(async () => {
  settings = await api.getSettings().catch(() => null)
  applyTheme(settings?.theme)
  await loadFont()
  term = new Terminal({ fontFamily: fontFamily(), fontSize: fontSize(), fontWeight: fontWeight(), fontWeightBold: fontWeightBold(), lineHeight: 1.15, cursorBlink: true, scrollback: 10000, theme: themeFromCss() })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
  term.open(host.value!)
  term.onData((d) => !exited.value && api.termWrite(id, d))
  fit.fit()
  const r = await api.termAdopt(id, term.cols, term.rows)
  if (!r) {
    exited.value = true
    term.write('\x1b[2m[este terminal já foi encerrado]\x1b[0m\r\n')
  } else {
    title.value = r.meta.title || 'Terminal'
    spec.value = r.meta.spec
    cwd.value = r.meta.cwd ?? ''
    document.title = `${title.value} · Terminal`
    if (r.buffer) term.write(r.buffer)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host.value!)
  offs.push(() => ro.disconnect())
  offs.push(api.onTermData((tid, data) => tid === id && term?.write(data)))
  offs.push(
    api.onTermExit((tid) => {
      if (tid !== id) return
      exited.value = true
      term?.write('\r\n\x1b[2m[terminal encerrado]\x1b[0m\r\n')
    })
  )
  offs.push(
    api.onSettingsChanged(async (s) => {
      settings = s
      applyTheme(s.theme)
      if (!term) return
      term.options.theme = themeFromCss()
      await loadFont()
      term.options.fontFamily = fontFamily()
      term.options.fontSize = fontSize()
      term.options.fontWeight = fontWeight()
      term.options.fontWeightBold = fontWeightBold()
      resize()
    })
  )
  term.focus()
})
onUnmounted(() => offs.forEach((f) => f()))
</script>

<template>
  <div class="tw">
    <header class="bar">
      <span class="tile" :class="{ off: exited }"><Icon :name="spec?.kind === 'ssh' ? 'server' : 'terminal'" :size="15" /></span>
      <div class="head-text">
        <span class="title ellipsis">{{ title }}</span>
        <span class="sub ellipsis">{{ exited ? 'encerrado' : spec?.kind === 'ssh' ? 'SSH' : 'terminal' }}<template v-if="cwd"> · {{ cwd.replace(/^\/Users\/[^/]+/, '~') }}</template></span>
      </div>
      <span class="spacer" />
      <button v-if="!exited" type="button" class="small" title="Voltar com esta aba para o painel do Ovseer" @click="reattach"><Icon name="panelBottom" :size="12" /> Acoplar ao painel</button>
    </header>
    <div ref="host" class="term" />
  </div>
</template>

<style scoped>
.tw { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
.bar { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 14px; flex: none; border-bottom: 1px solid var(--border); background: var(--panel); }
/* a janela tem a barra de título do sistema: o cabeçalho não precisa de margem para os botões dela */
.tile { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); flex: none; }
.tile.off { background: var(--panel-2); color: var(--muted); }
.head-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; line-height: 1.2; }
.title { font-size: 13.5px; font-weight: 700; }
.sub { font-size: 11.5px; color: var(--muted); }
.spacer { flex: 1; }
.small { height: 28px; gap: 6px; font-size: 12px; flex: none; }
.term { flex: 1; min-height: 0; position: relative; padding: 8px 4px 8px 10px; }
.term :deep(.xterm) { height: 100%; }
</style>
