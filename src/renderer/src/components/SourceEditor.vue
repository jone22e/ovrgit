<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting, type StreamParser } from '@codemirror/language'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { showMinimap } from '@replit/codemirror-minimap'
import { tags as t } from '@lezer/highlight'
import { closeSource, fileMap, openSource, pinSource, revealSource, saveSource, setShowDiff, state } from '../store'
import FileIcon from './FileIcon.vue'
import Icon from './Icon.vue'

/**
 * Editor no estilo do JetBrains: abas dos arquivos abertos, realce de sintaxe, guias de indentação,
 * margem direita, barra inferior com o caminho, linha:coluna, fim de linha, codificação e indentação.
 * Salva sozinho (logo depois de parar de digitar, ao sair do editor e ao trocar de aba).
 * Cada aba guarda o próprio desfazer, cursor e rolagem.
 * Markdown e SVG têm prévia (só código, dividido ou só prévia); imagens abrem direto na prévia.
 * Sem edição pendente, o arquivo acompanha o disco (um agente pode estar mexendo nele); se ele muda
 * no disco enquanto há edição pendente, o salvamento para e o editor pergunta o que fazer.
 */
const api = window.ovseer
const host = ref<HTMLElement>()
const tabsEl = ref<HTMLElement>()
const view = shallowRef<EditorView>()

interface Tab {
  state: EditorState
  /** Conteúdo como está no disco (com os fins de linha originais) */
  saved: string
  scroll: number
  eol: '\n' | '\r\n'
  indent: string
  lang: string
  /** .env*: o git ignora o arquivo */
  ignored?: boolean
}
const cache = new Map<string, Tab>()

// ---------- .env: valores ocultos por padrão ----------
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/
const isEnv = computed(() => ENV_FILE.test(path.value ?? ''))
/** Arquivos .env em que o usuário pediu para ver os valores (volta a ocultar ao reabrir o app) */
const revealed = reactive(new Set<string>())
const valuesShown = computed(() => !!path.value && revealed.has(path.value))
class DotsWidget extends WidgetType {
  toDOM() {
    const el = document.createElement('span')
    el.className = 'env-dots'
    el.textContent = '••••••••••••'
    return el
  }
  ignoreEvent() {
    return false
  }
}
const ENV_LINE = /^(\s*(?:export\s+)?[\w.-]+\s*=)(.+)$/
/** Troca o valor de cada CHAVE=valor por pontos; comentários e linhas vazias ficam como estão */
function maskValues(view: EditorView): DecorationSet {
  const marks: ReturnType<typeof Decoration.replace>[] = []
  const ranges: { from: number; to: number }[] = []
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      const m = ENV_LINE.exec(line.text)
      if (m && m[2].trim()) {
        ranges.push({ from: line.from + m[1].length, to: line.to })
        marks.push(Decoration.replace({ widget: new DotsWidget() }))
      }
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges.map((r, i) => marks[i].range(r.from, r.to)))
}
const envMaskPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = maskValues(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = maskValues(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)
/** Com os valores ocultos o arquivo não é editável: mostre-os para editar */
const envMasked: Extension = [envMaskPlugin, EditorState.readOnly.of(true), EditorView.editable.of(false)]
const envMask = new Compartment()
function toggleValues() {
  const p = path.value
  if (!p) return
  if (revealed.has(p)) revealed.delete(p)
  else revealed.add(p)
  const shown = revealed.has(p)
  view.value?.dispatch({ effects: envMask.reconfigure(shown ? [] : envMasked) })
  const tab = cache.get(p)
  if (tab && view.value) tab.state = view.value.state
  if (shown) view.value?.focus()
}

const path = computed(() => state.sourcePath)
const reason = ref('')
const loading = ref(false)
const saving = ref(false)
const cursor = ref({ line: 1, col: 1, sel: 0 })
/** Informações da aba ativa para a barra inferior */
const info = ref<{ eol: string; indent: string; lang: string } | null>(null)
const conflict = computed(() => !!path.value && !!state.sourceConflicts[path.value])

// ---------- prévia: Markdown, SVG e imagens ----------
const RASTER = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i
type Kind = 'code' | 'md' | 'svg' | 'image'
type Layout = 'code' | 'split' | 'preview'
const kindOf = (p: string): Kind => (RASTER.test(p) ? 'image' : /\.svg$/i.test(p) ? 'svg' : /\.(md|markdown)$/i.test(p) ? 'md' : 'code')
const kind = computed<Kind>(() => kindOf(path.value ?? ''))
function readLayout(key: string, fallback: Layout): Layout {
  try {
    const v = localStorage.getItem(key)
    return v === 'code' || v === 'split' || v === 'preview' ? v : fallback
  } catch {
    return fallback
  }
}
/** Modo escolhido por tipo (lembrado); padrão como no JetBrains: Markdown dividido, SVG só a imagem */
const layouts = reactive({ md: readLayout('ovseer.layout.md', 'split'), svg: readLayout('ovseer.layout.svg', 'preview') })
const layout = computed<Layout>(() => (kind.value === 'code' ? 'code' : kind.value === 'image' ? 'preview' : layouts[kind.value]))
function setLayout(v: Layout) {
  if (kind.value !== 'md' && kind.value !== 'svg') return
  layouts[kind.value] = v
  try {
    localStorage.setItem(`ovseer.layout.${kind.value}`, v)
  } catch {
    /* só nesta sessão */
  }
  nextTick(() => view.value?.requestMeasure())
}
const LAYOUTS: { id: Layout; icon: 'pencil' | 'columns' | 'monitor'; title: string }[] = [
  { id: 'code', icon: 'pencil', title: 'Só o código' },
  { id: 'split', icon: 'columns', title: 'Código e prévia' },
  { id: 'preview', icon: 'monitor', title: 'Só a prévia' }
]

/** Texto que a prévia mostra: acompanha a edição (com um pequeno atraso para não pesar) */
const previewText = ref('')
let previewTimer: ReturnType<typeof setTimeout> | undefined
function updatePreview(text: string, now = false) {
  clearTimeout(previewTimer)
  if (now) previewText.value = text
  else previewTimer = setTimeout(() => (previewText.value = text), 150)
}

/** Caminho relativo ao arquivo aberto → caminho no projeto ("/x" é a partir da raiz) */
function resolveRel(href: string): string {
  const clean = decodeURI(href.split(/[?#]/)[0])
  const base = clean.startsWith('/') ? [] : (path.value ?? '').split('/').slice(0, -1)
  for (const part of clean.replace(/^\/+/, '').split('/')) {
    if (part === '..') base.pop()
    else if (part && part !== '.') base.push(part)
  }
  return base.join('/')
}
/** Imagens do projeto já lidas (data URL), para o Markdown não reler a cada tecla */
const imageUrls = new Map<string, string>()
const mdHtml = computed(() => {
  if (kind.value !== 'md') return ''
  const frag = DOMPurify.sanitize(marked.parse(previewText.value, { async: false, gfm: true }), { RETURN_DOM_FRAGMENT: true })
  // imagens com caminho do projeto: carregadas daqui (o app não tem o arquivo por URL)
  frag.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (/^(https?:|data:)/i.test(src) || !src) return
    const rel = resolveRel(src)
    img.setAttribute('data-local', rel)
    const url = imageUrls.get(rel)
    if (url) img.setAttribute('src', url)
    else img.removeAttribute('src')
  })
  const div = document.createElement('div')
  div.append(frag)
  return div.innerHTML
})
const previewEl = ref<HTMLElement>()
watch(mdHtml, () =>
  nextTick(() => {
    previewEl.value?.querySelectorAll<HTMLImageElement>('img[data-local]:not([src])').forEach((img) => {
      const rel = img.dataset.local!
      api.readSourceImage(rel).then(
        (r) => {
          imageUrls.set(rel, r.dataUrl)
          img.src = r.dataUrl
        },
        () => img.setAttribute('alt', `${img.alt || rel} (imagem não encontrada)`)
      )
    })
  })
)
/** Links da prévia: externos no navegador, arquivos do projeto no editor, âncoras rolam até o título */
function onPreviewClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') ?? ''
  if (/^https?:/i.test(href)) api.openExternal(href)
  else if (href.startsWith('#')) {
    const slug = decodeURIComponent(href.slice(1)).toLowerCase()
    const h = [...(previewEl.value?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? [])].find(
      (el) => el.textContent?.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') === slug
    )
    h?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } else {
    const rel = resolveRel(href)
    if (state.sourceList.includes(rel)) openSource(rel)
  }
}
/** No modo dividido, a prévia acompanha a rolagem do código (proporcional) */
function syncScroll() {
  const sc = view.value?.scrollDOM
  const pv = previewEl.value ?? svgEl.value
  if (!sc || !pv || layout.value !== 'split') return
  const max = sc.scrollHeight - sc.clientHeight
  pv.scrollTop = max > 0 ? (sc.scrollTop / max) * (pv.scrollHeight - pv.clientHeight) : 0
}
const svgEl = ref<HTMLElement>()
const svgUrl = computed(() => (kind.value === 'svg' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewText.value)}` : ''))

/** Imagem aberta: data URL, tamanho e dimensões; `real` mostra em 100% (senão cabe no painel) */
const image = ref<{ dataUrl: string; bytes: number; w: number; h: number } | null>(null)
const zoomReal = ref(false)
function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (image.value) image.value = { ...image.value, w: img.naturalWidth, h: img.naturalHeight }
}
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

// ---------- linguagem pela extensão ----------
const legacy = async (load: () => Promise<unknown>): Promise<Extension> => StreamLanguage.define((await load()) as StreamParser<unknown>)
function languageOf(p: string): { name: string; load: () => Promise<Extension> } {
  const file = p.slice(p.lastIndexOf('/') + 1).toLowerCase()
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : ''
  if (file === 'dockerfile' || file.endsWith('.dockerfile')) return { name: 'Dockerfile', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile) }
  if (file === 'makefile') return { name: 'Makefile', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell) }
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return { name: 'TypeScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: ext === 'tsx' }) }
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return { name: 'JavaScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: ext === 'jsx' }) }
    case 'json': case 'jsonc': case 'json5':
      return { name: 'JSON', load: async () => (await import('@codemirror/lang-json')).json() }
    case 'css': case 'scss': case 'less':
      return { name: ext.toUpperCase(), load: async () => (await import('@codemirror/lang-css')).css() }
    case 'html': case 'htm':
      return { name: 'HTML', load: async () => (await import('@codemirror/lang-html')).html() }
    case 'vue':
      return { name: 'Vue', load: async () => (await import('@codemirror/lang-vue')).vue() }
    case 'md': case 'markdown':
      return { name: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() }
    case 'py':
      return { name: 'Python', load: async () => (await import('@codemirror/lang-python')).python() }
    case 'yml': case 'yaml':
      return { name: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() }
    case 'xml': case 'svg': case 'plist': case 'xsd': case 'xsl':
      return { name: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() }
    case 'sql':
      return { name: 'SQL', load: async () => (await import('@codemirror/lang-sql')).sql() }
    case 'php':
      return { name: 'PHP', load: async () => (await import('@codemirror/lang-php')).php() }
    case 'java':
      return { name: 'Java', load: async () => (await import('@codemirror/lang-java')).java() }
    case 'rs':
      return { name: 'Rust', load: async () => (await import('@codemirror/lang-rust')).rust() }
    case 'go':
      return { name: 'Go', load: async () => (await import('@codemirror/lang-go')).go() }
    case 'sh': case 'bash': case 'zsh':
      return { name: 'Shell', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell) }
    case 'toml':
      return { name: 'TOML', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml) }
    default:
      return { name: 'Texto', load: async () => [] }
  }
}

/** Indentação usada no arquivo: tab ou 2/4 espaços */
function detectIndent(text: string): string {
  let tabs = 0
  let two = 0
  let spaced = 0
  for (const line of text.split('\n', 2000)) {
    if (line.startsWith('\t')) tabs++
    else {
      const n = /^ +/.exec(line)?.[0].length ?? 0
      if (n) {
        spaced++
        if (n % 4 !== 0 && n % 2 === 0) two++
      }
    }
  }
  if (tabs > spaced) return '\t'
  return two > 0 || !spaced ? '  ' : '    '
}

// ---------- aparência (JetBrains: IntelliJ Light / Dark) ----------
const c = (light: string, dark: string) => `light-dark(${light}, ${dark})`
const chrome = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--panel)', color: c('#080808', '#bcbec4') },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', var(--mono)", fontSize: '13px', lineHeight: '1.7',
    // como na IDE: traço um pouco mais cheio que o regular e ligaduras desligadas (padrão da IDE)
    fontWeight: '450', fontVariantLigatures: 'none', fontFeatureSettings: '"liga" 0, "calt" 0'
  },
  '.cm-content': {
    caretColor: c('#000', '#ced0d6'), paddingBottom: '40vh',
    // margem direita em 120 colunas, como no JetBrains
    backgroundImage: `linear-gradient(to right, transparent calc(6px + 120ch), ${c('#e9eaee', '#393b40')} calc(6px + 120ch), ${c('#e9eaee', '#393b40')} calc(7px + 120ch), transparent calc(7px + 120ch))`
  },
  '.cm-line': { paddingLeft: '6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: c('#000', '#ced0d6'), borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: c('#aeb3c2', '#4b5059'), border: 'none', paddingLeft: '8px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '32px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: c('#767a8a', '#a1a3ab') },
  '.cm-activeLine': { backgroundColor: c('#f5f8fe', '#26282e') },
  '.cm-foldGutter .cm-gutterElement': { color: c('#aeb3c2', '#6f737a'), padding: '0 4px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: `${c('#a6d2ff', '#214283')} !important`
  },
  '.cm-selectionMatch': { backgroundColor: c('#edebfc', '#3b3d41') },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: c('#93d9d9', '#43454a'), outline: 'none' },
  '.cm-nonmatchingBracket': { color: c('#e45649', '#f75464') },
  '.cm-foldPlaceholder': { backgroundColor: c('#e9eaee', '#393b40'), border: 'none', color: 'var(--muted)', padding: '0 4px' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-search': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: c('#f2e6a4', '#114957'), outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c('#f5d76e', '#2a6b7a') },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: c('#d5e1ff', '#2e436e'), color: 'var(--text)' }
})
const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.bool, t.null, t.self], color: c('#0033b3', '#cf8e6d') },
  { tag: [t.string, t.special(t.string), t.inserted, t.character], color: c('#067d17', '#6aab73') },
  { tag: [t.regexp, t.escape], color: c('#0037a6', '#cf8e6d') },
  { tag: [t.number, t.unit], color: c('#1750eb', '#2aacb8') },
  { tag: [t.comment, t.lineComment, t.blockComment], color: c('#8c8c8c', '#7a7e85') },
  { tag: t.docComment, color: c('#8c8c8c', '#5f826b'), fontStyle: 'italic' },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.definition(t.propertyName))], color: c('#00627a', '#56a8f5') },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c('#00627a', '#57aaf7') },
  { tag: [t.propertyName, t.special(t.propertyName)], color: c('#871094', '#c77dbb') },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: c('#871094', '#c77dbb'), fontStyle: 'italic' },
  { tag: [t.meta, t.annotation, t.macroName], color: c('#9e880d', '#b3ae60') },
  { tag: [t.typeName, t.className, t.namespace], color: c('#000000', '#bcbec4') },
  { tag: [t.tagName, t.angleBracket], color: c('#0033b3', '#d5b778') },
  { tag: t.attributeName, color: c('#174ad4', '#bababa') },
  { tag: [t.heading], color: c('#0033b3', '#cf8e6d'), fontWeight: '700' },
  { tag: [t.link, t.url], color: c('#287bde', '#548af7'), textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: [t.deleted, t.invalid], color: c('#e45649', '#f75464') }
])
const guides = indentationMarkers({
  highlightActiveBlock: true,
  markerType: 'codeOnly',
  // o plugin escolhe entre `light` e `dark` por uma marcação de tema escuro que este editor não usa:
  // as duas recebem a cor que segue o color-scheme do app (tons discretos do JetBrains)
  colors: {
    light: c('#ebecf0', '#313438'), dark: c('#ebecf0', '#313438'),
    activeLight: c('#c9ccd6', '#4b4e54'), activeDark: c('#c9ccd6', '#4b4e54')
  }
})

// ---------- salvamento automático ----------
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleSave(p: string) {
  clearTimeout(timers.get(p))
  timers.set(p, setTimeout(() => saveNow(p), 800))
}
async function saveNow(p: string | null) {
  if (!p) return
  clearTimeout(timers.get(p))
  timers.delete(p)
  if (!(p in state.sourceDrafts) || state.sourceConflicts[p]) return
  saving.value = true
  const text = state.sourceDrafts[p]
  if (await saveSource(p)) {
    const tab = cache.get(p)
    if (tab) tab.saved = text
  }
  saving.value = false
}

/** Miniatura do arquivo na direita do editor, como no VS Code: mostra onde se está e rola ao clicar ou arrastar */
const minimap = showMinimap.compute(['doc'], () => ({
  create: () => ({ dom: document.createElement('div') }),
  displayText: 'blocks',
  showOverlay: 'always'
}))

function extensions(lang: Extension, eol: string, indent: string, file = ''): Extension[] {
  return [
    // .env*: começa com os valores ocultos (a não ser que o usuário já tenha pedido para ver)
    envMask.of(ENV_FILE.test(file) && !revealed.has(file) ? envMasked : []),
    basicSetup,
    EditorState.lineSeparator.of(eol),
    indentUnit.of(indent),
    EditorState.tabSize.of(indent === '\t' ? 4 : indent.length),
    keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => (saveNow(path.value), true) }]),
    lang,
    chrome,
    syntaxHighlighting(syntax),
    guides,
    minimap,
    EditorView.domEventHandlers({ blur: () => void saveNow(path.value) }),
    EditorView.updateListener.of((u) => {
      const p = path.value
      const tab = p ? cache.get(p) : undefined
      if (u.selectionSet || u.docChanged) updateCursor(u.state)
      if (!u.docChanged || !p || !tab) return
      tab.state = u.state
      const text = u.state.sliceDoc()
      if (kindOf(p) !== 'code') updatePreview(text)
      if (text === tab.saved) delete state.sourceDrafts[p]
      else {
        state.sourceDrafts[p] = text
        pinSource(p) // editou: a aba temporária vira fixa
        scheduleSave(p)
      }
    })
  ]
}

function updateCursor(st: EditorState) {
  const head = st.selection.main.head
  const line = st.doc.lineAt(head)
  cursor.value = { line: line.number, col: head - line.from + 1, sel: st.selection.ranges.reduce((n, r) => n + r.to - r.from, 0) }
}

// ---------- abrir / trocar de aba ----------
let seq = 0
async function show(p: string | null, prev?: string | null) {
  const my = ++seq
  // a aba que sai guarda o estado e salva o que estiver pendente
  if (prev && view.value && cache.has(prev)) {
    const tab = cache.get(prev)!
    tab.state = view.value.state
    tab.scroll = view.value.scrollDOM.scrollTop
    saveNow(prev)
  }
  if (!p) return
  reason.value = ''
  zoomReal.value = false
  // imagem: não passa pelo editor, só a prévia
  if (RASTER.test(p)) {
    info.value = null
    image.value = null
    loading.value = true
    try {
      const r = await api.readSourceImage(p)
      if (my !== seq) return
      image.value = { ...r, w: 0, h: 0 }
    } catch (e) {
      if (my !== seq) return
      reason.value = /ENOENT/.test(String(e)) ? 'O arquivo não existe mais no disco.' : String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    } finally {
      if (my === seq) loading.value = false
    }
    scrollTabIntoView()
    return
  }
  image.value = null
  let tab = cache.get(p)
  if (!tab) {
    loading.value = true
    try {
      const lang = languageOf(p)
      const [f, ext] = await Promise.all([api.readSource(p), lang.load()])
      if (my !== seq) return
      if (f.content === null) {
        reason.value = f.reason ?? 'Não foi possível abrir o arquivo.'
        return
      }
      const eol = f.content.includes('\r\n') ? '\r\n' : '\n'
      const indent = detectIndent(f.content)
      if (f.mtimeMs !== undefined) state.sourceMtimes[p] = f.mtimeMs
      const doc = state.sourceDrafts[p] ?? f.content
      tab = { state: EditorState.create({ doc, extensions: extensions(ext, eol, indent, p) }), saved: f.content, scroll: 0, eol, indent, lang: lang.name, ignored: f.ignored }
      cache.set(p, tab)
    } catch (e) {
      if (my !== seq) return
      reason.value = /ENOENT/.test(String(e)) ? 'O arquivo não existe mais no disco.' : String((e as Error)?.message ?? e)
      return
    } finally {
      if (my === seq) loading.value = false
    }
  }
  await nextTick()
  if (my !== seq || !host.value) return
  // o painel pode ter sido recriado (fechado e aberto de novo): o editor vai junto
  if (view.value && view.value.dom.parentElement !== host.value) {
    view.value.destroy()
    view.value = undefined
  }
  if (view.value) view.value.setState(tab.state)
  else {
    view.value = new EditorView({ state: tab.state, parent: host.value })
    view.value.scrollDOM.addEventListener('scroll', syncScroll, { passive: true })
  }
  updatePreview(tab.state.sliceDoc(), true)
  info.value = { eol: tab.eol === '\r\n' ? 'CRLF' : 'LF', indent: tab.indent === '\t' ? 'Tab' : `${tab.indent.length} espaços`, lang: tab.lang }
  updateCursor(tab.state)
  const top = tab.scroll
  requestAnimationFrame(() => view.value && (view.value.scrollDOM.scrollTop = top))
  if (layout.value !== 'preview') view.value.focus()
  scrollTabIntoView()
  syncFromDisk()
}

watch(path, (p, prev) => show(p, prev))
onMounted(() => show(path.value))

// abas fechadas: esquece o estado delas
watch(
  () => [...state.sourceTabs],
  (tabs) => {
    for (const p of [...cache.keys()]) if (!tabs.includes(p)) cache.delete(p)
  }
)

/** Acompanha o disco: relê quando o app atualiza o status ou a janela volta ao foco */
async function syncFromDisk() {
  const p = path.value
  const tab = p ? cache.get(p) : undefined
  if (!p || !tab || !view.value || saving.value) return
  let f
  try {
    f = await api.readSource(p)
  } catch {
    return
  }
  if (p !== path.value || f.content === null || f.content === tab.saved) return
  if (p in state.sourceDrafts) {
    // editando e o arquivo mudou por fora: não sobrescreve nada, pergunta
    if (f.content !== state.sourceDrafts[p]) state.sourceConflicts[p] = true
    return
  }
  tab.saved = f.content
  if (f.mtimeMs !== undefined) state.sourceMtimes[p] = f.mtimeMs
  // troca o conteúdo mantendo cursor e rolagem; fora do desfazer, para não voltar à versão antiga sem querer
  view.value.dispatch({
    changes: { from: 0, to: view.value.state.doc.length, insert: f.content },
    selection: { anchor: Math.min(view.value.state.selection.main.head, f.content.length) },
    annotations: Transaction.addToHistory.of(false)
  })
}
watch(() => state.repo, syncFromDisk)
window.addEventListener('focus', syncFromDisk)
const flush = () => saveNow(path.value)
window.addEventListener('blur', flush)
onUnmounted(() => {
  flush()
  window.removeEventListener('focus', syncFromDisk)
  window.removeEventListener('blur', flush)
  view.value?.destroy()
})

// ---------- conflito ----------
/** Joga fora a edição e fica com o que está no disco */
function useDisk() {
  const p = path.value
  if (!p) return
  delete state.sourceDrafts[p]
  delete state.sourceConflicts[p]
  syncFromDisk()
}
/** Sobrescreve o disco com a edição */
async function keepMine() {
  const p = path.value
  if (!p) return
  saving.value = true
  const text = state.sourceDrafts[p]
  if (await saveSource(p, true)) {
    const tab = cache.get(p)
    if (tab && text !== undefined) tab.saved = text
  }
  saving.value = false
}

// ---------- abas ----------
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
/** Nomes repetidos entre as abas ganham a pasta, como no JetBrains */
const tabs = computed(() => {
  const count = new Map<string, number>()
  for (const p of state.sourceTabs) count.set(nameOf(p), (count.get(nameOf(p)) ?? 0) + 1)
  return state.sourceTabs.map((p) => {
    const parts = p.split('/')
    return { path: p, name: nameOf(p), hint: (count.get(nameOf(p)) ?? 0) > 1 ? parts[parts.length - 2] ?? '' : '', change: fileMap.value.get(p)?.kind }
  })
})
function onTabMouse(e: MouseEvent, p: string) {
  if (e.button === 1) {
    e.preventDefault()
    closeSource(p)
  }
}
function scrollTabIntoView() {
  nextTick(() => tabsEl.value?.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
}
/** Roda do mouse rola as abas na horizontal */
function onTabsWheel(e: WheelEvent) {
  if (!tabsEl.value || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  tabsEl.value.scrollLeft += e.deltaY
}

// ---------- barra inferior ----------
const crumbs = computed(() => {
  const p = path.value
  if (!p) return []
  const parts = p.split('/')
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/'), file: i === parts.length - 1 }))
})
const project = computed(() => state.repo?.root.split(/[\\/]/).pop() ?? '')
</script>

<template>
  <div class="editor">
    <div class="tabs-bar">
      <div ref="tabsEl" class="tabs" @wheel.passive="onTabsWheel">
        <div
          v-for="t in tabs"
          :key="t.path"
          class="tab"
          :class="{ on: t.path === path, preview: t.path === state.sourcePreview }"
          :title="t.path === state.sourcePreview ? `${t.path} · aba temporária (duplo clique para manter)` : t.path"
          @click="openSource(t.path)"
          @dblclick="pinSource(t.path)"
          @mousedown="onTabMouse($event, t.path)"
        >
          <FileIcon :path="t.path" :size="15" />
          <span class="tname" :class="t.change">{{ t.name }}</span>
          <span v-if="t.hint" class="hint">{{ t.hint }}</span>
          <span v-if="state.sourceConflicts[t.path]" class="warn" title="Mudou no disco enquanto você editava">!</span>
          <button class="ghost x" title="Fechar (clique do meio também fecha)" @click.stop="closeSource(t.path)"><Icon name="x" :size="11" /></button>
        </div>
      </div>
      <div v-if="kind === 'md' || kind === 'svg'" class="seg layouts" role="group" aria-label="Modo de exibição">
        <button v-for="l in LAYOUTS" :key="l.id" :class="{ on: layout === l.id }" :title="l.title" @click="setLayout(l.id)">
          <Icon :name="l.icon" :size="13" />
        </button>
      </div>
      <button class="ghost icon small close-pane" title="Fechar o painel" @click="setShowDiff(false)"><Icon name="x" :size="14" /></button>
    </div>

    <div v-if="conflict" class="conflict">
      <Icon name="alert" :size="14" />
      <span>O arquivo foi alterado fora do editor enquanto você editava. O salvamento automático está pausado.</span>
      <button class="small" @click="useDisk">Usar a versão do disco</button>
      <button class="small" :disabled="saving" @click="keepMine">Manter a minha</button>
    </div>

    <!-- .env: aviso sobre o git e o botão que mostra/oculta os valores -->
    <div v-if="isEnv && path && !loading && !reason" class="env-bar">
      <Icon name="lock" :size="13" />
      <span v-if="cache.get(path)?.ignored" class="env-tag ok">ignorado pelo git</span>
      <span v-else class="env-tag warn" title="Este arquivo pode ir para o servidor num commit. Se ele tem segredos, coloque-o no .gitignore.">não está no .gitignore</span>
      <span class="env-note faint">{{ valuesShown ? 'Valores visíveis. Oculte para proteger a tela.' : 'Os valores estão ocultos. Mostre-os para ver ou editar.' }}</span>
      <button class="small" @click="toggleValues">{{ valuesShown ? 'Ocultar valores' : 'Mostrar valores' }}</button>
    </div>

    <div v-if="!path" class="placeholder faint">Clique num arquivo para abrir.</div>
    <div v-else-if="loading" class="placeholder"><span class="spinner" /></div>
    <div v-else-if="reason" class="placeholder faint">{{ reason }}</div>
    <div v-show="path && !loading && !reason" class="body" :class="layout">
      <div v-show="kind !== 'image' && layout !== 'preview'" ref="host" class="cm-host" />
      <div v-if="kind === 'md' && layout !== 'code'" ref="previewEl" class="md-preview" @click="onPreviewClick" v-html="mdHtml" />
      <div v-if="kind === 'svg' && layout !== 'code'" ref="svgEl" class="img-preview"><img :src="svgUrl" alt="" /></div>
      <div v-if="kind === 'image' && image" class="img-preview" :class="{ real: zoomReal }" :title="zoomReal ? 'Clique para caber no painel' : 'Clique para ver em 100%'" @click="zoomReal = !zoomReal">
        <img :src="image.dataUrl" alt="" @load="onImageLoad" />
      </div>
    </div>

    <footer v-if="path" class="status">
      <nav class="crumbs">
        <span class="crumb root">{{ project }}</span>
        <template v-for="c in crumbs" :key="c.path">
          <Icon name="chevron" :size="10" class="sep" />
          <button v-if="!c.file" class="crumb" :title="`Mostrar ${c.path} na árvore`" @click="revealSource(c.path, true)">{{ c.name }}</button>
          <span v-else class="crumb file"><FileIcon :path="c.path" :size="13" /> {{ c.name }}</span>
        </template>
      </nav>
      <span v-if="saving" class="st faint">Salvando…</span>
      <template v-if="kind === 'image' && image">
        <span v-if="image.w" class="st" title="Dimensões">{{ image.w }} × {{ image.h }}</span>
        <span class="st" title="Tamanho do arquivo">{{ fmtBytes(image.bytes) }}</span>
        <button class="crumb st" :title="zoomReal ? 'Caber no painel' : 'Ver em 100%'" @click="zoomReal = !zoomReal">{{ zoomReal ? '100%' : 'Ajustar' }}</button>
      </template>
      <template v-if="info && !reason">
        <span class="st" title="Linha:coluna">{{ cursor.line }}:{{ cursor.col }}<template v-if="cursor.sel"> ({{ cursor.sel }} car.)</template></span>
        <span class="st" title="Fim de linha">{{ info.eol }}</span>
        <span class="st" title="Codificação">UTF-8</span>
        <span class="st" title="Indentação">{{ info.indent }}</span>
        <span class="st">{{ info.lang }}</span>
      </template>
    </footer>
  </div>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--panel); position: relative; }

.tabs-bar { display: flex; align-items: stretch; flex: none; height: var(--pane-header); border-bottom: 1px solid var(--border); }
.tabs { flex: 1; display: flex; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; min-width: 0; }
.tabs::-webkit-scrollbar { display: none; }
.tab {
  position: relative; display: flex; align-items: center; gap: 6px; flex: none; padding: 0 6px 0 12px;
  font-size: 13px; color: var(--muted); cursor: pointer; user-select: none; white-space: nowrap;
}
.tab:hover { background: var(--hover); }
.tab.on { color: var(--text); }
.tab.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--accent); }
.tname.modified, .tname.typechange { color: #5c8fd6; }
.tname.added, .tname.untracked { color: var(--add); }
.tname.conflict { color: var(--del); }
.tab.preview .tname { font-style: italic; }
.hint { font-size: 11.5px; color: var(--faint); }
.warn { color: var(--del); font-weight: 700; }
.x { width: 18px; height: 18px; padding: 0; border-radius: 4px; opacity: 0; color: var(--muted); }
.tab:hover .x, .tab.on .x { opacity: 1; }
.x:hover { background: var(--hover); color: var(--text); }
.close-pane { width: 26px; height: 26px; align-self: center; margin: 0 8px 0 4px; flex: none; }

.conflict {
  display: flex; align-items: center; gap: 10px; flex: none; padding: 8px 14px; font-size: 12.5px;
  background: color-mix(in srgb, var(--mod) 14%, var(--panel)); border-bottom: 1px solid var(--border); color: var(--text);
}
.conflict span { flex: 1; min-width: 0; }
.env-bar {
  display: flex; align-items: center; gap: 8px; flex: none; padding: 6px 14px; font-size: 12.5px; color: var(--muted);
  border-bottom: 1px solid var(--border); background: var(--panel-2);
}
.env-tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.env-tag.ok { color: var(--mod); background: color-mix(in srgb, var(--mod) 16%, transparent); }
.env-tag.warn { color: var(--del); background: color-mix(in srgb, var(--del) 14%, transparent); }
.env-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-bar .small { height: 26px; padding: 0 10px; font-size: 12px; flex: none; }
.cm-host :deep(.env-dots) { color: var(--faint); letter-spacing: 1px; }
.conflict .small { height: 26px; padding: 0 10px; font-size: 12px; flex: none; }

.placeholder { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
.body { flex: 1; min-height: 0; display: flex; }
.cm-host { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.body.split > .cm-host { border-right: 1px solid var(--border); }
/* miniatura: separada do código por uma linha, com a área visível marcada (por cima do estilo da extensão) */
.cm-host :deep(.cm-minimap-gutter) { background: var(--panel); border-left: 1px solid var(--border); }
.cm-host :deep(.cm-minimap-overlay-container .cm-minimap-overlay) { background: var(--text); opacity: 0.08; }
.cm-host :deep(.cm-minimap-overlay-container:hover .cm-minimap-overlay) { opacity: 0.14; }
.layouts { display: flex; align-self: center; padding: 2px; gap: 2px; background: var(--panel-2); border-radius: 7px; flex: none; margin-left: 6px; }
.layouts button { width: 26px; height: 22px; padding: 0; border: 0; background: transparent; color: var(--muted); border-radius: 5px; }
.layouts button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }

/* imagens: sobre xadrez, para ver a transparência */
.img-preview {
  flex: 1; min-width: 0; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-in;
  background: repeating-conic-gradient(color-mix(in srgb, var(--border) 55%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
}
.img-preview img { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; }
.img-preview.real { cursor: zoom-out; align-items: flex-start; justify-content: flex-start; }
.img-preview.real img { max-width: none; max-height: none; }
.body.split .img-preview, .body.split .md-preview { flex: 1; }

/* Markdown, no estilo do GitHub */
.md-preview { flex: 1; min-width: 0; overflow: auto; padding: 20px 32px 60px; font-size: 14px; line-height: 1.65; color: var(--text); user-select: text; }
.md-preview :deep(> :first-child) { margin-top: 0; }
.md-preview :deep(h1), .md-preview :deep(h2) { padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
.md-preview :deep(h1) { font-size: 1.9em; margin: 0.8em 0 0.5em; }
.md-preview :deep(h2) { font-size: 1.45em; margin: 1.2em 0 0.5em; }
.md-preview :deep(h3) { font-size: 1.2em; margin: 1.1em 0 0.4em; }
.md-preview :deep(h4), .md-preview :deep(h5), .md-preview :deep(h6) { font-size: 1em; margin: 1em 0 0.4em; }
.md-preview :deep(p), .md-preview :deep(ul), .md-preview :deep(ol), .md-preview :deep(blockquote), .md-preview :deep(table), .md-preview :deep(pre) { margin: 0 0 1em; }
.md-preview :deep(ul), .md-preview :deep(ol) { padding-left: 2em; }
.md-preview :deep(li + li) { margin-top: 0.25em; }
.md-preview :deep(a) { color: var(--accent); text-decoration: none; }
.md-preview :deep(a:hover) { text-decoration: underline; }
.md-preview :deep(code) { font-family: 'JetBrains Mono Variable', var(--mono); font-size: 0.86em; padding: 0.15em 0.4em; border-radius: 5px; background: var(--panel-2); }
.md-preview :deep(pre) { padding: 12px 14px; border-radius: 8px; background: var(--panel-2); overflow: auto; line-height: 1.5; }
.md-preview :deep(pre code) { padding: 0; background: none; font-size: 12.5px; }
.md-preview :deep(blockquote) { padding: 0 1em; color: var(--muted); border-left: 3px solid var(--border); }
.md-preview :deep(table) { border-collapse: collapse; display: block; overflow: auto; }
.md-preview :deep(th), .md-preview :deep(td) { padding: 6px 12px; border: 1px solid var(--border); }
.md-preview :deep(th) { background: var(--panel-2); font-weight: 600; }
.md-preview :deep(img) { max-width: 100%; border-radius: 4px; }
.md-preview :deep(hr) { border: 0; height: 1px; background: var(--border); margin: 1.6em 0; }
.md-preview :deep(input[type='checkbox']) { margin-right: 6px; }

.status {
  display: flex; align-items: center; gap: 2px; flex: none; height: 26px; padding: 0 8px; font-size: 12px; color: var(--muted);
  border-top: 1px solid var(--border); white-space: nowrap;
}
.crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; overflow: hidden; }
.crumb { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 4px; border: 0; background: none; color: var(--muted); font-size: 12px; border-radius: 4px; }
button.crumb:hover { background: var(--hover); color: var(--text); }
.crumb.file { color: var(--text); }
.sep { color: var(--faint); flex: none; }
.st { padding: 0 7px; font-variant-numeric: tabular-nums; }
</style>
