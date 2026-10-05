<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { alpha } from '@shared/themes'
import type { Snippet, SshConnection, TerminalSpec } from '@shared/types'
import { api, openTerminalTab, saveSettings, setShowTerminal, setTerminalMax, state } from '../store'
import { currentTheme } from '../theme'
import Icon from './Icon.vue'
import LogView from './LogView.vue'

/**
 * Terminal com abas. Cada aba é uma sessão: local (shell do sistema na pasta do projeto) ou SSH (conexão salva).
 * As instâncias do xterm ficam fora do estado reativo (são objetos pesados); o Vue só controla a lista de abas.
 */
interface Tab {
  uid: string
  title: string
  spec: TerminalSpec
  termId: number | null
  exited: boolean
  /** Pasta onde o terminal local abriu */
  cwd?: string
  /** Fixada: volta com o mesmo nome e na mesma pasta ao reabrir o painel ou o app */
  pinned?: boolean
  /** Modo interativo: a saída lida linha a linha (nível, hora, campos) em vez do terminal */
  log?: boolean
}
/** Aba como fica guardada entre uma abertura e outra */
interface SavedTab {
  spec: TerminalSpec
  pinned?: boolean
  title?: string
}
interface Session {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  el: HTMLDivElement
}

const tabs = reactive<Tab[]>([])
const active = ref<string | null>(null)
const sessions = new Map<string, Session>()
const hosts = new Map<string, HTMLDivElement>()
const menuOpen = ref(false)
const menuRoot = ref<HTMLElement>()
const body = ref<HTMLDivElement>()
const offs: (() => void)[] = []

const connections = computed(() => state.settings?.sshConnections ?? [])
const grouped = computed(() => {
  const map = new Map<string, SshConnection[]>()
  for (const c of connections.value) {
    const g = c.group?.trim() || ''
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(c)
  }
  // sem grupo primeiro, depois os grupos em ordem alfabética
  return [...map.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])))
})
const activeTab = computed(() => tabs.find((t) => t.uid === active.value) ?? null)

// ---------- aparência ----------
const FALLBACK = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'
const fontFamily = () => {
  const name = (state.settings?.terminalFont ?? '').trim().replace(/["']/g, '')
  return name ? `"${name}", ${FALLBACK}` : FALLBACK
}
const fontSize = () => Math.min(Math.max(Number(state.settings?.terminalFontSize) || 14, 9), 28)
const fontWeight = () => ([400, 500, 600].includes(Number(state.settings?.terminalFontWeight)) ? Number(state.settings?.terminalFontWeight) : 500)
const fontWeightBold = () => Math.min(fontWeight() + 200, 700)

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

// ---------- abas ----------
function titleFor(spec: TerminalSpec) {
  if (spec.kind === 'ssh') return connections.value.find((c) => c.id === spec.connectionId)?.name ?? 'SSH'
  if (spec.kind === 'service') return state.settings?.services.find((x) => x.id === spec.serviceId)?.name ?? 'Serviço'
  return state.repo?.name ?? 'Terminal'
}
const isService = (t: Tab | null | undefined) => t?.spec.kind === 'service'
const serviceIdOf = (t: Tab) => (t.spec.kind === 'service' ? t.spec.serviceId : null)

async function openTab(spec: TerminalSpec, opts: { connect?: boolean; pinned?: boolean; title?: string } = {}) {
  // serviço: uma aba só por serviço
  if (spec.kind === 'service') {
    const dup = tabs.find((t) => serviceIdOf(t) === spec.serviceId)
    if (dup) {
      active.value = dup.uid
      focusActive()
      return
    }
  }
  const cwd = spec.kind === 'local' ? (spec.cwd ?? state.repo?.root) : undefined
  const tab: Tab = { uid: crypto.randomUUID(), title: opts.title || titleFor(spec), spec, termId: null, exited: false, cwd, pinned: opts.pinned }
  tabs.push(tab)
  active.value = tab.uid
  await nextTick()
  const el = hosts.get(tab.uid)
  if (!el) return
  await loadFont()
  const term = new Terminal({
    fontFamily: fontFamily(),
    fontSize: fontSize(),
    fontWeight: fontWeight(),
    fontWeightBold: fontWeightBold(),
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: themeFromCss()
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  // links clicáveis (abrem no navegador)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
  term.open(el)
  sessions.set(tab.uid, { term, fit, search, el })
  // atalhos: ⌘/Ctrl+K limpa a tela; ⌘/Ctrl+F busca
  term.attachCustomKeyEventHandler((e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey && e.shiftKey
    if (e.type !== 'keydown' || !mod) return true
    if (e.key.toLowerCase() === 'k') {
      term.clear()
      return false
    }
    if (e.key.toLowerCase() === 'f') {
      openSearch()
      return false
    }
    return true
  })
  term.onData((data) => {
    const t = tabs.find((x) => x.uid === tab.uid)
    if (!t) return
    const sid = serviceIdOf(t)
    if (sid) {
      if (t.exited) {
        if (data === '\r') api.serviceStart(sid).catch(() => undefined)
        return
      }
      return api.serviceWrite(sid, data)
    }
    if (t.exited) {
      if (data === '\r') restart(t)
      return
    }
    if (t.termId !== null) api.termWrite(t.termId, data)
  })
  if (spec.kind === 'service') await attachServiceTab(tab)
  else if (opts.connect === false) {
    // aba restaurada: não conecta sozinha (evita pedir senha ao abrir o app)
    tab.exited = true
    term.write(`\x1b[2m[${tab.spec.kind === 'ssh' ? 'desconectado' : 'terminal fechado'} — pressione Enter para ${tab.spec.kind === 'ssh' ? 'conectar' : 'abrir'}]\x1b[0m\r\n`)
  } else await start(tab)
  term.focus()
}

const isMac = window.ovseer.platform === 'darwin'

// ---------- busca ----------
const searching = ref(false)
const searchText = ref('')
const searchInput = ref<HTMLInputElement>()
async function openSearch() {
  searching.value = true
  await nextTick()
  searchInput.value?.select()
}
function findNext(back = false) {
  const s = active.value ? sessions.get(active.value) : null
  if (!s || !searchText.value) return
  const opts = { decorations: { activeMatchColorOverviewRuler: '#a974f8', matchOverviewRuler: '#888' } }
  if (back) s.search.findPrevious(searchText.value, opts)
  else s.search.findNext(searchText.value, opts)
}
function closeSearch() {
  searching.value = false
  const s = active.value ? sessions.get(active.value) : null
  s?.search.clearDecorations()
  s?.term.focus()
}

// ---------- comandos salvos ----------
const snipOpen = ref(false)
const snipRoot = ref<HTMLElement>()
const snipForm = ref(false)
const snipName = ref('')
const snipCmd = ref('')
const snipOnlyHere = ref(false)
const activeConnId = computed(() => (activeTab.value?.spec.kind === 'ssh' ? activeTab.value.spec.connectionId : null))
const snippets = computed(() => {
  const all = state.settings?.snippets ?? []
  // os desta conexão primeiro, depois os gerais
  return [...all.filter((s) => s.connectionId && s.connectionId === activeConnId.value), ...all.filter((s) => !s.connectionId)]
})
function runSnippet(sn: Snippet) {
  snipOpen.value = false
  const tab = activeTab.value
  if (!tab || tab.termId === null) return
  api.termWrite(tab.termId, `${sn.command}\r`)
  sessions.get(tab.uid)?.term.focus()
}
async function saveSnippet() {
  if (!snipName.value.trim() || !snipCmd.value.trim()) return
  const sn: Snippet = {
    id: crypto.randomUUID(),
    name: snipName.value.trim(),
    command: snipCmd.value.trim(),
    connectionId: snipOnlyHere.value ? activeConnId.value : null
  }
  await saveSettings({ snippets: [...(state.settings?.snippets ?? []).map((x) => ({ ...x })), sn] })
  snipForm.value = false
  snipName.value = ''
  snipCmd.value = ''
}
async function removeSnippet(id: string) {
  await saveSettings({ snippets: (state.settings?.snippets ?? []).filter((x) => x.id !== id).map((x) => ({ ...x })) })
}

/** Aba de serviço: mostra o que já passou e passa a receber a saída ao vivo; parado, deixa o aviso para iniciar */
async function attachServiceTab(tab: Tab) {
  const sid = serviceIdOf(tab)
  const s = sessions.get(tab.uid)
  if (!sid || !s) return
  s.fit.fit()
  const r = await api.serviceAttach(sid, s.term.cols, s.term.rows)
  if (r.service) tab.title = r.service.name
  s.term.reset()
  if (r.buffer) s.term.write(r.buffer)
  tab.exited = r.state?.status !== 'running'
  if (tab.exited) s.term.write(`\x1b[2m[serviço ${r.state?.status === 'exited' ? 'encerrado' : 'parado'} — pressione Enter para iniciar]\x1b[0m\r\n`)
}

async function start(tab: Tab) {
  const s = sessions.get(tab.uid)
  if (!s) return
  tab.exited = false
  s.fit.fit()
  if (tab.spec.kind === 'ssh') {
    const conn = connections.value.find((c) => c.id === (tab.spec as { connectionId: string }).connectionId)
    s.term.write(`\x1b[2mConectando a ${conn ? `${conn.user ? `${conn.user}@` : ''}${conn.host}` : 'servidor'}…\x1b[0m\r\n`)
  }
  try {
    tab.termId = await api.termCreate(s.term.cols, s.term.rows, { ...tab.spec })
    // comando inicial (ex.: login de um CLI): entra assim que o shell abrir
    if (tab.spec.kind === 'local' && tab.spec.command) {
      const cmd = tab.spec.command
      const id = tab.termId
      setTimeout(() => api.termWrite(id, `${cmd}\r`), 400)
    }
  } catch (e) {
    tab.exited = true
    const msg = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    s.term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n\x1b[2m[pressione Enter para tentar de novo]\x1b[0m\r\n`)
  }
}

async function restart(tab: Tab) {
  if (tab.termId !== null) await api.termKill(tab.termId)
  tab.termId = null
  sessions.get(tab.uid)?.term.reset()
  await start(tab)
}

async function closeTab(uid: string) {
  const i = tabs.findIndex((t) => t.uid === uid)
  if (i < 0) return
  const tab = tabs[i]
  // fixada: fechar encerra o terminal, mas a aba volta quando o painel ou o app reabrir
  if (tab.pinned) closedPinned.push(toSaved(tab))
  if (tab.termId !== null && !isService(tab)) api.termKill(tab.termId)
  sessions.get(uid)?.term.dispose()
  sessions.delete(uid)
  hosts.delete(uid)
  tabs.splice(i, 1)
  if (active.value === uid) active.value = tabs[Math.min(i, tabs.length - 1)]?.uid ?? null
  if (!tabs.length) setShowTerminal(false)
  else focusActive()
}

// ---------- modo interativo (leitura linha a linha) ----------
const logView = ref<InstanceType<typeof LogView>>()
/** Texto do terminal da aba (sem cores), para o modo interativo começar com o histórico */
function termText(tab: Tab): string {
  const s = sessions.get(tab.uid)
  if (!s) return ''
  const buf = s.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n')
}
function toggleLog(tab: Tab) {
  tab.log = !tab.log
  if (tab.log) nextTick(() => logView.value?.reset(termText(tab)))
  else focusActive()
}
/** Limpa a tela da aba: o terminal e, no modo interativo, as linhas lidas (o processo segue rodando) */
function clearTab(tab: Tab) {
  sessions.get(tab.uid)?.term.clear()
  if (tab.log) logView.value?.reset('')
  else focusActive()
}
/** Saída nova da aba ativa em modo interativo também vai para a leitura */
function feedLog(uid: string, data: string) {
  const tab = tabs.find((t) => t.uid === uid)
  if (tab?.log && active.value === uid) logView.value?.feed(data)
}

// ---------- desacoplar / acoplar ----------
/** A aba vai para uma janela própria: o processo principal troca o dono da sessão; aqui a aba sai sem matar nada */
async function detach(tab: Tab) {
  const sid = serviceIdOf(tab)
  if (sid) await api.serviceOpenWindow(sid)
  else if (tab.termId !== null) await api.termDetach(tab.termId, { title: tab.title, spec: { ...tab.spec }, cwd: tab.cwd })
  else return
  const i = tabs.findIndex((t) => t.uid === tab.uid)
  sessions.get(tab.uid)?.term.dispose()
  sessions.delete(tab.uid)
  hosts.delete(tab.uid)
  if (i >= 0) tabs.splice(i, 1)
  if (active.value === tab.uid) active.value = tabs[Math.min(i, tabs.length - 1)]?.uid ?? null
  if (!tabs.length) setShowTerminal(false)
  else focusActive()
}
/** Uma janela desacoplada pediu para voltar: cria a aba sobre a sessão que já existe e adota a saída */
async function adopt(id: number, meta: { title: string; spec: TerminalSpec; cwd?: string }) {
  setShowTerminal(true)
  const tab: Tab = { uid: crypto.randomUUID(), title: meta.title || titleFor(meta.spec), spec: meta.spec, termId: id, exited: false, cwd: meta.cwd }
  tabs.push(tab)
  active.value = tab.uid
  await nextTick()
  const el = hosts.get(tab.uid)
  if (!el) return
  await loadFont()
  const term = new Terminal({ fontFamily: fontFamily(), fontSize: fontSize(), fontWeight: fontWeight(), fontWeightBold: fontWeightBold(), lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: themeFromCss() })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
  term.open(el)
  sessions.set(tab.uid, { term, fit, search, el })
  term.onData((data) => {
    const t = tabs.find((x) => x.uid === tab.uid)
    if (!t) return
    if (t.exited) {
      if (data === '\r') restart(t)
      return
    }
    if (t.termId !== null) api.termWrite(t.termId, data)
  })
  fit.fit()
  const r = await api.termAdopt(id, term.cols, term.rows)
  if (r?.buffer) term.write(r.buffer)
  if (!r) {
    tab.termId = null
    tab.exited = true
    term.write('\x1b[2m[terminal encerrado — pressione Enter para abrir outro]\x1b[0m\r\n')
  }
  term.focus()
}

// ---------- fixar ----------
/** Fixadas que foram fechadas: voltam quando o painel reabre sem abas e quando o app abre */
const closedPinned = reactive<SavedTab[]>([])
function toSaved(t: Tab): SavedTab {
  if (t.spec.kind === 'ssh') return { spec: { ...t.spec } }
  return t.pinned ? { spec: { kind: 'local', cwd: t.cwd }, pinned: true, title: t.title } : { spec: { kind: 'local' } }
}
/** Só o terminal local é fixado: a aba SSH já volta na própria conexão */
function togglePin(tab: Tab) {
  if (tab.spec.kind !== 'local') return
  tab.pinned = !tab.pinned
  // a pasta passa a fazer parte da aba: reiniciar (ou reabrir) cai nela, não na do projeto aberto
  tab.spec = tab.pinned ? { ...tab.spec, cwd: tab.cwd } : { kind: 'local', command: tab.spec.command }
}
async function reopenPinned() {
  const list = closedPinned.splice(0, closedPinned.length)
  for (const s of list) await openTab(s.spec, { pinned: true, title: s.title })
}

function selectTab(uid: string) {
  active.value = uid
  focusActive()
}

function focusActive() {
  requestAnimationFrame(() => {
    refit()
    if (active.value) sessions.get(active.value)?.term.focus()
  })
}

function refit() {
  const tab = activeTab.value
  const s = tab && sessions.get(tab.uid)
  if (!s || !s.el.offsetParent) return
  s.fit.fit()
  const sid = serviceIdOf(tab!)
  if (sid) api.serviceResize(sid, s.term.cols, s.term.rows)
  else if (tab!.termId !== null) api.termResize(tab!.termId, s.term.cols, s.term.rows)
}

function setHost(uid: string, el: unknown) {
  if (el instanceof HTMLDivElement) hosts.set(uid, el)
}

// ---------- arrastar abas para reordenar ----------
const dragUid = ref<string | null>(null)
const dropTarget = ref<{ uid: string; before: boolean } | null>(null)

function onDragStart(e: DragEvent, uid: string) {
  dragUid.value = uid
  e.dataTransfer?.setData('text/plain', uid)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, uid: string) {
  if (!dragUid.value || uid === dragUid.value) {
    dropTarget.value = null
    return
  }
  // metade esquerda da aba: cai antes; metade direita: depois
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropTarget.value = { uid, before: e.clientX < r.left + r.width / 2 }
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onDrop() {
  const from = tabs.findIndex((t) => t.uid === dragUid.value)
  const target = dropTarget.value
  if (from >= 0 && target) {
    const [moved] = tabs.splice(from, 1)
    let to = tabs.findIndex((t) => t.uid === target.uid)
    if (!target.before) to += 1
    tabs.splice(to, 0, moved)
  }
  onDragEnd()
}

function onDragEnd() {
  dragUid.value = null
  dropTarget.value = null
}

// ---------- menu de conexões ----------
function connect(c: SshConnection) {
  menuOpen.value = false
  openTab({ kind: 'ssh', connectionId: c.id })
}
function editConnection(c: SshConnection) {
  menuOpen.value = false
  state.sshEdit = { ...c }
}
function newConnection() {
  menuOpen.value = false
  state.sshEdit = 'new'
}
const onDoc = (e: MouseEvent) => {
  if (menuOpen.value && menuRoot.value && !menuRoot.value.contains(e.target as Node)) menuOpen.value = false
}

// ---------- ciclo de vida ----------
onMounted(async () => {
  offs.push(api.onTermAttach((id, meta) => void adopt(id, meta)))
  offs.push(api.onServiceAttachPanel((id) => openTerminalTab({ kind: 'service', serviceId: id })))
  offs.push(
    api.onServiceData((sid, data) => {
      const tab = tabs.find((t) => serviceIdOf(t) === sid)
      if (!tab) return
      sessions.get(tab.uid)?.term.write(data)
      feedLog(tab.uid, data)
    }),
    api.onServicesChanged((states) => {
      for (const tab of tabs) {
        const sid = serviceIdOf(tab)
        if (!sid) continue
        const st = states.find((x) => x.id === sid)
        const running = st?.status === 'running'
        // começou de novo: reata para ver a saída do processo novo
        if (running && tab.exited) attachServiceTab(tab)
        else if (!running && !tab.exited) tab.exited = true
      }
    })
  )
  offs.push(
    api.onTermData((id, data) => {
      const tab = tabs.find((t) => t.termId === id)
      if (!tab) return
      sessions.get(tab.uid)?.term.write(data)
      feedLog(tab.uid, data)
    }),
    api.onTermExit((id) => {
      const tab = tabs.find((t) => t.termId === id)
      if (!tab) return
      tab.termId = null
      tab.exited = true
      const msg = tab.spec.kind === 'ssh' ? 'conexão encerrada — pressione Enter para reconectar' : 'processo encerrado — pressione Enter para abrir outro'
      sessions.get(tab.uid)?.term.write(`\r\n\x1b[2m[${msg}]\x1b[0m\r\n`)
    })
  )
  const ro = new ResizeObserver(() => refit())
  if (body.value) ro.observe(body.value)
  offs.push(() => ro.disconnect())
  const onTheme = () => sessions.forEach((s) => (s.term.options.theme = themeFromCss()))
  window.addEventListener('ovseer-theme', onTheme)
  offs.push(() => window.removeEventListener('ovseer-theme', onTheme))
  document.addEventListener('mousedown', onDoc)
  offs.push(() => document.removeEventListener('mousedown', onDoc))

  document.addEventListener('mousedown', onSnipDoc)
  offs.push(() => document.removeEventListener('mousedown', onSnipDoc))

  // reabre as abas da última vez (as SSH ficam esperando um Enter para conectar)
  const saved = readSavedTabs()
  for (const [i, s] of saved.entries()) await openTab(s.spec, { pinned: s.pinned, title: s.title, connect: s.spec.kind === 'local' && (!!s.pinned || i === saved.length - 1) })
  if (state.terminalRequest) {
    const spec = state.terminalRequest
    state.terminalRequest = null
    await openTab(spec)
  } else if (!saved.length) await openTab({ kind: 'local' })
})

const TABS_KEY = 'ovseer.terminalTabs'
function readSavedTabs(): SavedTab[] {
  try {
    // formato antigo: a lista guardava só o tipo de cada aba
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]') as (SavedTab | TerminalSpec)[]
    const list = raw.map((x): SavedTab => ('spec' in x ? x : { spec: x }))
    return list
      .filter((s) => s.spec?.kind === 'local' || (s.spec?.kind === 'ssh' && connections.value.some((c) => c.id === (s.spec as { connectionId: string }).connectionId)))
      .slice(0, 12)
  } catch {
    return []
  }
}
watch(
  () => JSON.stringify([...tabs.filter((t) => !isService(t)).map(toSaved), ...closedPinned]),
  (json) => {
    try {
      localStorage.setItem(TABS_KEY, json)
    } catch {
      /* só nesta sessão */
    }
  }
)

const onSnipDoc = (e: MouseEvent) => {
  if (snipOpen.value && snipRoot.value && !snipRoot.value.contains(e.target as Node)) {
    snipOpen.value = false
    snipForm.value = false
  }
}

// pedidos de abrir aba vindos de fora (ex.: "Salvar e conectar" no formulário SSH)
watch(
  () => state.terminalRequest,
  (spec) => {
    if (!spec) return
    state.terminalRequest = null
    openTab(spec)
  }
)

// reabrir o painel sem abas cria um terminal local; com abas, foca a ativa
watch(
  () => state.showTerminal,
  (on) => {
    if (!on) return
    if (!tabs.length && !state.terminalRequest) closedPinned.length ? reopenPinned() : openTab({ kind: 'local' })
    else focusActive()
  }
)

// maximizar/restaurar muda o tamanho: reajusta e mantém o foco
watch(() => state.terminalMax, () => focusActive())

// fonte/tamanho/peso alterados nas Configurações: aplica em todas as abas
watch(
  () => [state.settings?.terminalFont, state.settings?.terminalFontSize, state.settings?.terminalFontWeight],
  async () => {
    await loadFont()
    sessions.forEach((s) => {
      s.term.options.fontFamily = fontFamily()
      s.term.options.fontSize = fontSize()
      s.term.options.fontWeight = fontWeight()
      s.term.options.fontWeightBold = fontWeightBold()
    })
    refit()
  }
)

// conexão renomeada: atualiza o título das abas dela
watch(connections, () => {
  for (const t of tabs) if (t.spec.kind === 'ssh') t.title = titleFor(t.spec)
})

onUnmounted(() => {
  offs.forEach((off) => off())
  for (const t of tabs) if (t.termId !== null) api.termKill(t.termId)
  sessions.forEach((s) => s.term.dispose())
})

</script>

<template>
  <section class="terminal">
    <header>
      <div class="tabs" role="tablist">
        <div
          v-for="t in tabs"
          :key="t.uid"
          class="tab"
          :class="{
            on: t.uid === active,
            dead: t.exited,
            dragging: t.uid === dragUid,
            'drop-before': dropTarget?.uid === t.uid && dropTarget.before,
            'drop-after': dropTarget?.uid === t.uid && !dropTarget.before
          }"
          draggable="true"
          @dragstart="onDragStart($event, t.uid)"
          @dragover.prevent="onDragOver($event, t.uid)"
          @drop.prevent="onDrop"
          @dragend="onDragEnd"
          role="tab"
          :title="t.spec.kind === 'service' ? `Serviço · ${t.title}` : t.spec.kind === 'ssh' ? `SSH · ${t.title}` : t.pinned ? `Terminal fixado · ${t.cwd ?? t.title}` : `Terminal local · ${t.title}`"
          @click="selectTab(t.uid)"
          @mousedown.middle.prevent="closeTab(t.uid)"
        >
          <!-- ativa: × à esquerda e ícone do tipo numa caixinha à direita; inativa: ícone à esquerda (vira × no hover) -->
          <!-- ícone e × no mesmo espaço fixo: trocar um pelo outro não muda a largura da aba -->
          <span class="slot">
            <Icon :name="t.pinned ? 'pin' : t.spec.kind === 'ssh' ? 'server' : t.spec.kind === 'service' ? 'play' : 'terminal'" :size="13" class="lead" :class="{ pinned: t.pinned, live: t.spec.kind === 'service' && !t.exited }" />
            <button class="ghost close" title="Fechar aba" @click.stop="closeTab(t.uid)"><Icon name="x" :size="11" /></button>
          </span>
          <span class="name ellipsis">{{ t.title }}</span>
          <span class="kind-box" :class="{ live: t.spec.kind === 'service' && !t.exited }"><Icon :name="t.spec.kind === 'ssh' ? 'server' : t.spec.kind === 'service' ? 'play' : 'terminal'" :size="12" /></span>
        </div>
      </div>
      <button class="ghost icon small" title="Novo terminal local" @click="openTab({ kind: 'local' })"><Icon name="plus" :size="14" /></button>
      <div ref="menuRoot" class="ssh-menu">
        <button class="ghost icon small" :class="{ on: menuOpen }" title="Conexões SSH" @click="menuOpen = !menuOpen">
          <Icon name="server" :size="14" />
        </button>
        <div v-if="menuOpen" class="pop">
          <p v-if="!connections.length" class="faint empty">Nenhuma conexão salva.</p>
          <div class="conn-list">
            <template v-for="[g, list] in grouped" :key="g">
              <h6 v-if="g">{{ g }}</h6>
              <div v-for="c in list" :key="c.id" class="conn" @click="connect(c)">
                <Icon name="server" :size="14" class="faint" />
                <span class="c-text">
                  <strong class="ellipsis">{{ c.name }}</strong>
                  <small class="faint mono ellipsis">{{ c.user ? `${c.user}@` : '' }}{{ c.host }}{{ c.port !== 22 ? `:${c.port}` : '' }}</small>
                </span>
                <button class="ghost edit" title="Editar" @click.stop="editConnection(c)"><Icon name="settings" :size="13" /></button>
              </div>
            </template>
          </div>
          <div class="add-row">
            <button class="ghost add" @click="newConnection"><Icon name="plus" :size="13" /> Nova conexão SSH…</button>
            <button class="ghost add imp" title="Trazer conexões do ~/.ssh/config ou de uma planilha" @click="(menuOpen = false), (state.showSshImport = true)">
              Importar…
            </button>
          </div>
        </div>
      </div>
      <div ref="snipRoot" class="snip-menu">
        <button
          class="ghost icon small"
          :class="{ on: snipOpen }"
          :disabled="!activeTab"
          title="Comandos salvos: execute com um clique na aba atual"
          @click="snipOpen = !snipOpen"
        >
          <Icon name="zap" :size="14" />
        </button>
        <div v-if="snipOpen" class="pop snip-pop">
          <p v-if="!snippets.length && !snipForm" class="faint empty">Nenhum comando salvo ainda.</p>
          <div v-for="sn in snippets" :key="sn.id" class="conn" :title="sn.command" @click="runSnippet(sn)">
            <Icon name="zap" :size="13" class="faint" />
            <span class="c-text">
              <strong class="ellipsis">{{ sn.name }}</strong>
              <small class="faint mono ellipsis">{{ sn.command }}</small>
            </span>
            <span v-if="sn.connectionId" class="tag">desta conexão</span>
            <button class="ghost edit" title="Remover" @click.stop="removeSnippet(sn.id)"><Icon name="x" :size="12" /></button>
          </div>
          <form v-if="snipForm" class="snip-form" @submit.prevent="saveSnippet">
            <input v-model="snipName" type="text" placeholder="Nome (ex.: Atualizar o servidor)" />
            <input v-model="snipCmd" type="text" class="mono" placeholder="Comando (ex.: sudo make update)" spellcheck="false" />
            <label v-if="activeConnId" class="only"><input v-model="snipOnlyHere" type="checkbox" /> Só nesta conexão</label>
            <div class="snip-acts">
              <button type="button" class="small ghost" @click="snipForm = false">Cancelar</button>
              <button type="submit" class="small primary" :disabled="!snipName.trim() || !snipCmd.trim()">Salvar</button>
            </div>
          </form>
          <button v-else class="ghost add" @click="snipForm = true"><Icon name="plus" :size="13" /> Novo comando…</button>
        </div>
      </div>
      <form v-if="searching" class="search" @submit.prevent="findNext()">
        <Icon name="search" :size="13" class="faint" />
        <input ref="searchInput" v-model="searchText" type="text" placeholder="Buscar no terminal" spellcheck="false" @keydown.esc="closeSearch" @input="findNext()" />
        <button type="button" class="ghost icon tiny" title="Anterior" @click="findNext(true)"><Icon name="up" :size="12" /></button>
        <button type="submit" class="ghost icon tiny" title="Próximo (Enter)"><Icon name="down" :size="12" /></button>
        <button type="button" class="ghost icon tiny" title="Fechar (Esc)" @click="closeSearch"><Icon name="x" :size="12" /></button>
      </form>
      <button v-else class="ghost icon small" :disabled="!activeTab" :title="`Buscar no terminal (${isMac ? '⌘F' : 'Ctrl+Shift+F'})`" @click="openSearch">
        <Icon name="search" :size="13" />
      </button>
      <span class="spacer" />
      <button
        v-if="activeTab?.spec.kind === 'local'"
        class="ghost icon small"
        :class="{ pinned: activeTab.pinned }"
        :title="activeTab.pinned ? 'Soltar esta aba' : 'Fixar esta aba: ela volta nesta pasta ao reabrir o terminal ou o app'"
        @click="togglePin(activeTab)"
      >
        <Icon name="pin" :size="13" />
      </button>
      <button v-if="activeTab" class="ghost icon small" :title="`Limpar a tela${isMac ? ' (⌘K no terminal)' : ''}`" @click="clearTab(activeTab)"><Icon name="trash" :size="13" /></button>
      <button v-if="activeTab" class="ghost icon small" :class="{ on: activeTab.log }" :title="activeTab.log ? 'Voltar ao terminal' : 'Modo interativo: a saída lida linha a linha (nível, hora, campos), com filtro e busca'" @click="toggleLog(activeTab)"><Icon name="listChecks" :size="13" /></button>
      <template v-if="activeTab && isService(activeTab)">
        <button v-if="!activeTab.exited" class="ghost icon small stop" title="Parar o serviço" @click="api.serviceStop(serviceIdOf(activeTab)!)"><Icon name="stop" :size="13" /></button>
        <button v-else class="ghost icon small play" title="Iniciar o serviço" @click="api.serviceStart(serviceIdOf(activeTab)!)"><Icon name="play" :size="13" /></button>
        <button class="ghost icon small" title="Desacoplar: o terminal do serviço vai para uma janela própria" @click="detach(activeTab)"><Icon name="external" :size="13" /></button>
      </template>
      <template v-else>
        <button v-if="activeTab && activeTab.termId !== null && !activeTab.exited" class="ghost icon small" title="Desacoplar: esta aba vai para uma janela própria (a sessão continua a mesma)" @click="detach(activeTab)"><Icon name="external" :size="13" /></button>
        <button v-if="activeTab" class="ghost icon small" title="Reiniciar esta aba" @click="restart(activeTab)"><Icon name="refresh" :size="13" /></button>
      </template>
      <button
        class="ghost icon small"
        :title="state.terminalMax ? 'Restaurar o tamanho do terminal' : 'Maximizar o terminal'"
        @click="setTerminalMax(!state.terminalMax)"
      >
        <Icon :name="state.terminalMax ? 'minimize' : 'maximize'" :size="13" />
      </button>
      <button class="ghost icon small" title="Fechar o terminal (Ctrl+`)" @click="setShowTerminal(false)"><Icon name="x" :size="14" /></button>
    </header>
    <div ref="body" class="body">
      <div v-for="t in tabs" v-show="t.uid === active && !t.log" :key="t.uid" :ref="(el) => setHost(t.uid, el)" class="host" />
      <LogView v-if="activeTab?.log" :key="activeTab.uid" ref="logView" class="log-host" />
    </div>
  </section>
</template>

<style scoped>
.terminal { display: flex; flex-direction: column; height: 100%; background: var(--panel); min-height: 0; }
header {
  display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 6px; flex: none;
  border-bottom: 1px solid var(--border); min-width: 0;
}
.tabs { display: flex; align-items: center; gap: 6px; height: 100%; min-width: 0; overflow-x: auto; scrollbar-width: none; padding: 0 2px; }
.tabs::-webkit-scrollbar { display: none; }
/* abas em pílula (estilo Termius) */
.tab {
  display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px; flex: 0 1 auto;
  min-width: 96px; max-width: 200px; border-radius: 9px; cursor: pointer;
  font-size: 12.5px; color: var(--faint); background: var(--panel-2); border: 1px solid transparent;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.tab:hover { color: var(--muted); }
.tab.on {
  color: var(--text); background: color-mix(in srgb, var(--hover) 70%, var(--panel-2));
  border-color: var(--border); padding-right: 4px; flex-shrink: 0; font-weight: 600;
}
.tab .name { flex: 1; min-width: 0; }
.tab.dragging { opacity: 0.4; }
/* indicador de onde a aba vai cair */
.tab.drop-before { box-shadow: -3px 0 0 -1px var(--accent); }
.tab.drop-after { box-shadow: 3px 0 0 -1px var(--accent); }
.slot { position: relative; width: 18px; height: 18px; flex: none; display: grid; place-items: center; }
.slot .lead { opacity: 0.8; }
.tab.dead .slot .lead, .tab.dead .kind-box { opacity: 0.4; }
.close {
  position: absolute; inset: 0; width: 18px; height: 18px; padding: 0; border-radius: 5px; color: inherit;
  opacity: 0; pointer-events: none;
}
.close:hover { background: var(--panel) !important; }
/* inativa: o × aparece sobre o ícone ao passar o mouse; ativa: × sempre visível */
.tab:not(.on):hover .close, .tab.on .close { opacity: 1; pointer-events: auto; }
.tab:not(.on):hover .lead, .tab.on .lead { opacity: 0; }
.kind-box { display: none; }
.tab.on .kind-box {
  display: inline-grid; place-items: center; width: 22px; height: 20px; border-radius: 6px; flex: none;
  border: 1px solid var(--border); color: var(--muted); margin-left: 2px;
}
.icon.small { width: 26px; height: 24px; flex: none; }
.icon.small.on { background: var(--hover); }
.icon.small.pinned, .slot .lead.pinned { color: var(--accent); }
.spacer { flex: 1; }
.ssh-menu { position: relative; flex: none; }
.pop {
  position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 30; width: 300px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.empty { margin: 8px 10px; font-size: 12px; }
.conn { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
.conn:hover { background: var(--hover); }
.c-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.c-text strong { font-size: 12.5px; }
.c-text small { font-size: 11px; }
.edit { width: 24px; height: 24px; padding: 0; opacity: 0; }
.conn:hover .edit { opacity: 1; }
.add { width: 100%; justify-content: flex-start; height: 30px; margin-top: 4px; border-top: 1px solid var(--border); border-radius: 0 0 7px 7px; font-size: 12.5px; }
.add-row { display: flex; }
.add-row .add.imp { width: auto; flex: none; color: var(--accent); }
.conn-list { max-height: 320px; overflow: auto; }
h6 { margin: 8px 8px 2px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.snip-menu { position: relative; flex: none; }
.snip-pop { width: 340px; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--panel-2); color: var(--muted); flex: none; }
.snip-form { display: flex; flex-direction: column; gap: 6px; padding: 8px 4px 2px; border-top: 1px solid var(--border); margin-top: 4px; }
.snip-form input[type='text'] { height: 30px; font-size: 12.5px; }
.only { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.snip-acts { display: flex; justify-content: flex-end; gap: 6px; }
.search { display: flex; align-items: center; gap: 4px; padding: 0 4px 0 8px; height: 28px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); flex: none; }
.search input { border: 0; background: transparent; width: 170px; height: 26px; padding: 0 4px; font-size: 12.5px; }
.search input:focus { box-shadow: none; }
.search:focus-within { border-color: var(--accent); }
.tiny { width: 22px; height: 22px; padding: 0; }
.body { flex: 1; min-height: 0; position: relative; }
/* margem via inset (e não padding): o FitAddon mede a altura do host, então as linhas já cabem na área útil */
.host { position: absolute; inset: 6px 0 10px 10px; user-select: text; }
.host :deep(.xterm) { height: 100%; -webkit-font-smoothing: auto; -moz-osx-font-smoothing: auto; }
.host :deep(.xterm-viewport) { background: transparent !important; }
/* modo interativo ocupa o lugar do terminal */
.log-host { position: absolute; inset: 0; display: flex; flex-direction: column; }
.small.on { color: var(--accent); background: var(--accent-soft); }
/* aba de serviço rodando: ícone verde */
.lead.live, .kind-box.live { color: var(--add); }
.small.stop { color: var(--del); }
.small.play { color: var(--add); }
</style>
