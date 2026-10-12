<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { featureGraph, type FeatureEdge, type FeatureNode, type MapArea, type ProjectMap } from '@shared/codeGraph'
import { PROVIDER_LABEL } from '@shared/models'
import type { MapEvent } from '@shared/types'
import { readAgentPrefs } from '../agentPrefs'
import { api, openSource, setPane, state, toast } from '../store'
import Icon from './Icon.vue'

/**
 * Mapa funcional do projeto, num gráfico de forças como o do Obsidian: as áreas do sistema são os núcleos e as
 * funcionalidades (em linguagem de quem usa) ficam em volta, na cor da área. Traços cheios são ligações apontadas
 * pela IA; pontilhados, deduzidas dos imports entre os arquivos. Clique seleciona e mostra os detalhes (descrição,
 * arquivos, ligações); duplo clique abre o primeiro arquivo; arrastar move; a roda dá zoom. O mapa é gerado pela IA
 * (botão "Mapear projeto com IA") e fica guardado por projeto.
 */
interface GNode extends SimulationNodeDatum {
  id: string
  r: number
  ai: number
  label: string
  n: FeatureNode
  x: number
  y: number
}
interface GLink extends SimulationLinkDatum<GNode> {
  source: GNode
  target: GNode
  kind: FeatureEdge['kind']
  why?: string
  weight?: number
}

const root = computed(() => state.repo?.root ?? null)
const map = shallowRef<ProjectMap | null>(null)
const loading = ref(false)
const mapping = ref(false)
const status = ref('')
/** Andamento do mapeamento com IA: lotes feitos do total (null: ainda preparando) */
const progress = ref<{ done: number; total: number } | null>(null)
const percent = computed(() => (progress.value ? Math.round((progress.value.done / Math.max(1, progress.value.total)) * 100) : 0))
const error = ref<string | null>(null)
const search = ref('')
const hidden = ref(new Set<string>())
const selectedId = ref<string | null>(null)
const hoverId = ref<string | null>(null)
const tip = ref({ x: 0, y: 0 })
const prefs = readAgentPrefs()
const aiLabel = computed(() => PROVIDER_LABEL[prefs.provider])

const graph = computed(() => (map.value ? featureGraph(map.value) : null))
const hasMap = computed(() => !!map.value?.features)
const areas = computed<(MapArea & { count: number; color: string })[]>(() => {
  if (!graph.value) return []
  const counts = new Map<string, number>()
  for (const n of graph.value.nodes) if (n.kind === 'feature') counts.set(n.area, (counts.get(n.area) ?? 0) + 1)
  return graph.value.areas.map((a, i) => ({ ...a, count: counts.get(a.id) ?? 0, color: colorOf(i) }))
})
const areaIndex = computed(() => new Map(areas.value.map((a, i) => [a.id, i])))
const featureCount = computed(() => graph.value?.nodes.filter((n) => n.kind === 'feature').length ?? 0)
const linkCount = computed(() => graph.value?.edges.filter((e) => e.kind !== 'area').length ?? 0)
/** Arquivos alterados no projeto aberto: as funcionalidades que os têm ganham um anel */
const changed = computed(() => new Set((state.repo?.files ?? []).map((f) => f.path)))
const touched = (n: FeatureNode) => n.files.some((p) => changed.value.has(p))

// ---------- cores (ângulo de ouro: áreas vizinhas com matizes bem diferentes; claras no escuro, escuras no claro) ----------
const theme = ref({ bg: '#1e1e1e', text: '#ddd', accent: '#bd93f9', mod: '#e0a030', border: '#444', dark: true })
function readTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (k: string) => css.getPropertyValue(k).trim()
  const bg = v('--bg') || '#1e1e1e'
  theme.value = { bg, text: v('--text') || '#ddd', accent: v('--accent') || '#bd93f9', mod: v('--mod') || '#e0a030', border: v('--border') || '#444', dark: isDark(bg) }
  render()
}
function isDark(color: string): boolean {
  const m = color.match(/^#([0-9a-f]{6})$/i)
  if (!m) return true
  const n = parseInt(m[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 140
}
const colorOf = (i: number) => `hsl(${(i * 137.508 + 20) % 360} ${theme.value.dark ? 62 : 55}% ${theme.value.dark ? 64 : 42}%)`

// ---------- carregar e mapear ----------
async function load() {
  const r = root.value
  map.value = null
  selectedId.value = null
  hoverId.value = null
  error.value = null
  hidden.value = new Set()
  if (!r) return
  loading.value = true
  try {
    map.value = await api.mapGet(r)
    // mapeamento em curso (a aba foi aberta no meio): a barra já aparece no ponto em que está
    const running = await api.mapRunning(r)
    mapping.value = !!running
    progress.value = running?.type === 'progress' ? { done: running.done, total: running.total } : null
    status.value = running ? (running.type === 'done' ? '' : running.text) : ''
  } catch (e) {
    error.value = clean(e)
  } finally {
    loading.value = false
  }
}
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** Levanta os imports de novo: as ligações deduzidas acompanham o código atual (o mapa da IA fica) */
async function rescan() {
  const r = root.value
  if (!r || loading.value) return
  loading.value = true
  try {
    map.value = await api.mapScan(r)
    toast('Ligações atualizadas pelos imports.')
  } catch (e) {
    error.value = clean(e)
  } finally {
    loading.value = false
  }
}
async function mapWithAi() {
  const r = root.value
  if (!r || mapping.value) return
  error.value = null
  mapping.value = true
  progress.value = null
  status.value = 'Começando…'
  try {
    await api.mapAi(r, { provider: prefs.provider, model: prefs.model[prefs.provider], effort: prefs.effort[prefs.provider] })
  } catch (e) {
    mapping.value = false
    error.value = clean(e)
  }
}
const cancelAi = () => root.value && api.mapCancel(root.value).catch(() => undefined)
function onMapEvent(r: string, ev: MapEvent) {
  if (r !== root.value) return
  if (ev.type === 'status') status.value = ev.text
  else if (ev.type === 'progress') {
    progress.value = { done: ev.done, total: ev.total }
    status.value = ev.text
  } else {
    mapping.value = false
    status.value = ''
    progress.value = null
    if (ev.ok && ev.map) {
      map.value = ev.map
      toast('Mapa pronto.')
    } else error.value = ev.error ?? 'O mapeamento falhou.'
  }
}
const aiWhen = computed(() => {
  const at = map.value?.features?.at
  return at ? new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
})

// ---------- simulação ----------
const canvas = ref<HTMLCanvasElement>()
const wrap = ref<HTMLElement>()
let sim: Simulation<GNode, GLink> | null = null
let nodes: GNode[] = []
let links: GLink[] = []
const byId = new Map<string, GNode>()
let view = { x: 0, y: 0, k: 1 }
let size = { w: 0, h: 0 }
let raf = 0
let fitPending = false
let ticks = 0
/** Posição de cada nó na ordem de ligações (0 = mais ligado): quem ganha rótulo com pouco zoom */
const rank = new Map<string, number>()
const posKey = () => `ovseer.map.pos:${root.value}`
function savedPositions(): Record<string, [number, number]> {
  try {
    return JSON.parse(localStorage.getItem(posKey()) ?? '{}')
  } catch {
    return {}
  }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
function savePositions() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const out: Record<string, [number, number]> = {}
    for (const n of nodes) out[n.id] = [Math.round(n.x), Math.round(n.y)]
    try {
      localStorage.setItem(posKey(), JSON.stringify(out))
    } catch {
      /* sem espaço */
    }
  }, 500)
}

function rebuild() {
  sim?.stop()
  sim = null
  const g = graph.value
  if (!g || !g.nodes.length) {
    nodes = []
    links = []
    byId.clear()
    render()
    return
  }
  const saved = savedPositions()
  const hadSaved = Object.keys(saved).length > 0
  const ai = areaIndex.value
  const visible = g.nodes.filter((n) => !hidden.value.has(n.area))
  const spread = Math.sqrt(visible.length) * 30 + 80
  const next = new Map<string, GNode>()
  for (const n of visible) {
    const prev = byId.get(n.id)
    const p = saved[n.id]
    const angle = Math.random() * Math.PI * 2
    const dist = Math.random() * spread
    const node: GNode = prev ?? { id: n.id, r: 0, ai: 0, label: '', n, x: p ? p[0] : Math.cos(angle) * dist, y: p ? p[1] : Math.sin(angle) * dist }
    node.n = n
    // áreas são os núcleos: maiores, crescendo com o número de funcionalidades; funcionalidades, pelas ligações
    node.r = n.kind === 'area' ? Math.min(26, 11 + Math.sqrt(g.nodes.filter((x) => x.area === n.area).length) * 1.6) : Math.min(14, 4 + Math.sqrt(n.degree) * 1.8)
    node.ai = ai.get(n.area) ?? 0
    node.label = n.name
    next.set(n.id, node)
  }
  byId.clear()
  for (const [k, v] of next) byId.set(k, v)
  nodes = [...next.values()]
  links = g.edges.flatMap((e) => {
    const a = next.get(e.from)
    const b = next.get(e.to)
    return a && b ? [{ source: a, target: b, kind: e.kind, why: e.why, weight: e.weight }] : []
  })
  const ring = Math.sqrt(nodes.length) * 34 + 160
  sim = forceSimulation<GNode, GLink>(nodes)
    // funcionalidades em volta da sua área (mola curta e forte); ligações entre funcionalidades puxam de leve;
    // repulsão forte para os rótulos não se amontoarem
    .force('link', forceLink<GNode, GLink>(links).distance((l) => (l.kind === 'area' ? 70 + l.source.r : 160)).strength((l) => (l.kind === 'area' ? 0.6 : l.kind === 'ai' ? 0.12 : 0.04)))
    .force('charge', forceManyBody<GNode>().strength((n) => (n.n.kind === 'area' ? -900 : -220)).distanceMax(900))
    .force('center', forceCenter(0, 0).strength(0.03))
    .force('collide', forceCollide<GNode>((n) => n.r + (n.n.kind === 'area' ? 26 : 16)).iterations(2))
    // nós sem ligação: ficam num anel em volta, como no Obsidian
    .force('ring', forceRadial<GNode>(ring, 0, 0).strength((n) => (n.n.kind === 'feature' && !n.n.degree && hidden.value.has(n.n.area) ? 0.3 : 0)))
    .alpha(hadSaved ? 0.25 : 1)
    .alphaDecay(hadSaved ? 0.06 : 0.025)
    .on('tick', () => {
      if (fitPending && ++ticks % 20 === 0) fit(true)
      requestRender()
    })
    .on('end', () => {
      savePositions()
      if (fitPending) fit()
    })
  // começa centrado e, no primeiro layout, vai enquadrando enquanto a física assenta
  fitPending = !hadSaved
  if (hadSaved) fit()
  else view = { k: Math.max(0.1, Math.min(1, Math.min(size.w, size.h) / 2 / (spread + 80))), x: size.w / 2, y: size.h / 2 }
  rank.clear()
  ;[...nodes].sort((a, b) => (b.n.kind === 'area' ? 1e6 : b.n.degree) - (a.n.kind === 'area' ? 1e6 : a.n.degree)).forEach((n, i) => rank.set(n.id, i))
  requestRender()
}

/** Enquadra o gráfico inteiro na área (`keep`: continua enquadrando a cada tanto, até a física assentar) */
function fit(keep = false) {
  if (!keep) fitPending = false
  if (!nodes.length || !size.w) return
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r)
    y0 = Math.min(y0, n.y - n.r)
    x1 = Math.max(x1, n.x + n.r)
    y1 = Math.max(y1, n.y + n.r)
  }
  const pad = 40
  const k = Math.max(0.08, Math.min(1.6, Math.min((size.w - pad * 2) / Math.max(1, x1 - x0), (size.h - pad * 2) / Math.max(1, y1 - y0))))
  view = { k, x: size.w / 2 - ((x0 + x1) / 2) * k, y: size.h / 2 - ((y0 + y1) / 2) * k }
  requestRender()
}

// ---------- desenho ----------
function requestRender() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    render()
  })
}
/** Vizinhos do nó em destaque (selecionado ou sob o mouse) */
function neighborsOf(id: string | null): Set<string> | null {
  if (!id) return null
  const out = new Set<string>([id])
  for (const l of links) {
    if (l.source.id === id) out.add(l.target.id)
    else if (l.target.id === id) out.add(l.source.id)
  }
  return out
}
const matchesOf = (q: string) => (q ? new Set(nodes.filter((n) => `${n.n.name} ${n.n.description ?? ''} ${n.n.files.join(' ')}`.toLowerCase().includes(q)).map((n) => n.id)) : null)
function render() {
  const c = canvas.value
  if (!c) return
  const dpr = window.devicePixelRatio || 1
  const ctx = c.getContext('2d')
  if (!ctx) return
  const t = theme.value
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.w, size.h)
  ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y)
  const focusId = hoverId.value ?? selectedId.value
  const near = neighborsOf(focusId)
  const matches = matchesOf(search.value.trim().toLowerCase())
  const dimmed = (id: string) => (near ? !near.has(id) : matches ? !matches.has(id) : false)
  const cols = areas.value.map((a) => a.color)
  // traços: os da área na cor dela; os da IA cheios; os deduzidos pontilhados
  for (const l of links) {
    const on = near ? near.has(l.source.id) && near.has(l.target.id) && (l.source.id === focusId || l.target.id === focusId) : false
    const off = near ? !on : matches ? !(matches.has(l.source.id) || matches.has(l.target.id)) : false
    const areaLink = l.kind === 'area'
    ctx.strokeStyle = on ? t.accent : areaLink ? (cols[l.source.ai] ?? t.text) : t.text
    ctx.globalAlpha = on ? 0.85 : off ? 0.03 : areaLink ? 0.28 : l.kind === 'ai' ? (t.dark ? 0.22 : 0.3) : t.dark ? 0.1 : 0.14
    ctx.lineWidth = (on ? 1.6 : areaLink ? 1.2 : l.kind === 'ai' ? 1.3 : 1) / view.k
    if (l.kind === 'import') ctx.setLineDash([3 / view.k, 4 / view.k])
    ctx.beginPath()
    ctx.moveTo(l.source.x, l.source.y)
    ctx.lineTo(l.target.x, l.target.y)
    ctx.stroke()
    if (l.kind === 'import') ctx.setLineDash([])
  }
  // nós
  for (const n of nodes) {
    const off = dimmed(n.id)
    const color = cols[n.ai] ?? t.text
    ctx.globalAlpha = off ? 0.15 : 1
    if (n.n.kind === 'area') {
      // núcleo: disco translúcido com borda cheia
      ctx.fillStyle = color
      ctx.globalAlpha = off ? 0.08 : 0.22
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = off ? 0.15 : 0.9
      ctx.strokeStyle = color
      ctx.lineWidth = 2 / view.k
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      ctx.fill()
    }
    if (touched(n.n) && !off) {
      ctx.strokeStyle = t.mod
      ctx.lineWidth = 2 / view.k
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 3 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (n.id === focusId) {
      ctx.strokeStyle = t.accent
      ctx.lineWidth = 2 / view.k
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 5 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  // rótulos: áreas sempre; funcionalidades em destaque, na busca ou as mais ligadas, mais conforme o zoom
  ctx.globalAlpha = 1
  const budget = view.k >= 1.5 ? Infinity : Math.max(areas.value.length + 6, Math.round(areas.value.length + 14 * view.k * view.k))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const n of nodes) {
    const isArea = n.n.kind === 'area'
    const show = isArea || n.id === focusId || (near ? near.has(n.id) : matches ? matches.has(n.id) : (rank.get(n.id) ?? Infinity) < budget)
    if (!show) continue
    const off = dimmed(n.id)
    const px = (isArea ? 13 : Math.max(10, Math.min(12.5, 11 / Math.sqrt(view.k)))) / view.k
    ctx.font = `${isArea ? '700 ' : ''}${px}px system-ui, -apple-system, sans-serif`
    ctx.fillStyle = t.text
    ctx.globalAlpha = off ? 0.25 : n.id === focusId || isArea ? 1 : 0.82
    if (isArea) {
      ctx.textBaseline = 'middle'
      ctx.fillText(n.label, n.x, n.y)
      ctx.textBaseline = 'top'
    } else ctx.fillText(n.label, n.x, n.y + n.r + 3 / view.k)
  }
  ctx.globalAlpha = 1
}

// ---------- interação ----------
let drag: { node: GNode | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null
const toWorld = (px: number, py: number) => ({ x: (px - view.x) / view.k, y: (py - view.y) / view.k })
function hit(px: number, py: number): GNode | null {
  const p = toWorld(px, py)
  let best: GNode | null = null
  let bd = Infinity
  for (const n of nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y)
    const lim = n.r + 3 / view.k
    if (d <= lim && d < bd) {
      bd = d
      best = n
    }
  }
  return best
}
function local(e: PointerEvent | WheelEvent | MouseEvent) {
  const r = canvas.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  const p = local(e)
  const n = hit(p.x, p.y)
  drag = { node: n, sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: false }
  canvas.value?.setPointerCapture(e.pointerId)
  if (n && sim) {
    n.fx = n.x
    n.fy = n.y
    sim.alphaTarget(0.3).restart()
  }
}
function onMove(e: PointerEvent) {
  const p = local(e)
  if (drag) {
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 3) drag.moved = true
    if (drag.node) {
      const w = toWorld(p.x, p.y)
      drag.node.fx = w.x
      drag.node.fy = w.y
    } else {
      view = { ...view, x: drag.vx + (p.x - drag.sx), y: drag.vy + (p.y - drag.sy) }
      requestRender()
    }
    return
  }
  const n = hit(p.x, p.y)
  tip.value = { x: p.x, y: p.y }
  if ((n?.id ?? null) !== hoverId.value) {
    hoverId.value = n?.id ?? null
    requestRender()
  }
}
function onUp(e: PointerEvent) {
  const d = drag
  drag = null
  if (!d) return
  if (d.node) {
    d.node.fx = null
    d.node.fy = null
    sim?.alphaTarget(0)
    savePositions()
    if (!d.moved) select(d.node.id)
  } else if (!d.moved) select(null)
  canvas.value?.releasePointerCapture(e.pointerId)
}
function onDbl(e: MouseEvent) {
  const p = local(e)
  const n = hit(p.x, p.y)
  if (n?.n.files[0]) open(n.n.files[0])
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  const p = local(e)
  const k = Math.max(0.05, Math.min(8, view.k * Math.exp(-e.deltaY * 0.0022)))
  // zoom em volta do ponteiro
  view = { k, x: p.x - ((p.x - view.x) / view.k) * k, y: p.y - ((p.y - view.y) / view.k) * k }
  requestRender()
}
function onLeave() {
  if (hoverId.value) {
    hoverId.value = null
    requestRender()
  }
}
function select(id: string | null) {
  selectedId.value = id
  requestRender()
}
/** Centraliza o nó na área (busca e cliques na lista de ligações) */
function goTo(id: string) {
  const n = byId.get(id)
  if (!n) return
  select(id)
  const k = Math.max(view.k, 1.2)
  view = { k, x: size.w / 2 - n.x * k, y: size.h / 2 - n.y * k }
  requestRender()
}
function open(path: string) {
  state.tab = 'changes'
  setPane('files')
  openSource(path, true)
}
const selected = computed(() => (selectedId.value ? byId.get(selectedId.value) ?? null : null))
const hovered = computed(() => (hoverId.value ? byId.get(hoverId.value) ?? null : null))
const areaName = (id: string) => areas.value.find((a) => a.id === id)?.name ?? id
const areaColor = (id: string) => areas.value.find((a) => a.id === id)?.color ?? theme.value.text
const KIND: Record<string, string> = { screen: 'tela', action: 'ação', report: 'relatório', job: 'rotina', integration: 'integração', api: 'API', config: 'configuração' }
const kindLabel = (k?: string) => (k ? KIND[k] ?? k : '')
/** Ligações do selecionado (fora a da área), com o motivo */
const related = computed(() => {
  const s = selected.value
  if (!s) return []
  return links
    .filter((l) => l.kind !== 'area' && (l.source.id === s.id || l.target.id === s.id))
    .map((l) => {
      const other = l.source.id === s.id ? l.target : l.source
      return { id: other.id, name: other.n.name, why: l.why ?? (l.kind === 'import' ? `${l.weight} import${l.weight === 1 ? '' : 's'}` : ''), ai: l.kind === 'ai' }
    })
    .sort((a, b) => Number(b.ai) - Number(a.ai))
})
/** Funcionalidades de uma área selecionada */
const children = computed(() => (selected.value?.n.kind === 'area' ? nodes.filter((n) => n.n.kind === 'feature' && n.n.area === selected.value!.n.area) : []))
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
/** Busca: Enter vai para o primeiro resultado */
function onSearchEnter() {
  const q = search.value.trim().toLowerCase()
  if (!q) return
  const n = nodes.find((x) => x.n.name.toLowerCase().startsWith(q)) ?? nodes.find((x) => x.n.name.toLowerCase().includes(q)) ?? [...(matchesOf(q) ?? [])].map((id) => byId.get(id)!)[0]
  if (n) goTo(n.id)
}
function toggleArea(id: string) {
  const next = new Set(hidden.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  hidden.value = next
}
function onlyArea(id: string) {
  const all = areas.value.map((a) => a.id)
  hidden.value = hidden.value.size === all.length - 1 && !hidden.value.has(id) ? new Set() : new Set(all.filter((a) => a !== id))
}

// ---------- ciclo de vida ----------
let ro: ResizeObserver | undefined
let offEvent: (() => void) | undefined
function resize() {
  const c = canvas.value
  const w = wrap.value
  if (!c || !w) return
  const dpr = window.devicePixelRatio || 1
  const r = w.getBoundingClientRect()
  const first = !size.w
  size = { w: r.width, h: r.height }
  c.width = Math.round(r.width * dpr)
  c.height = Math.round(r.height * dpr)
  c.style.width = `${r.width}px`
  c.style.height = `${r.height}px`
  if (first && nodes.length) fit()
  render()
}
onMounted(() => {
  readTheme()
  ro = new ResizeObserver(resize)
  if (wrap.value) ro.observe(wrap.value)
  resize()
  window.addEventListener('ovseer-theme', readTheme)
  offEvent = api.onMapEvent(onMapEvent)
})
onUnmounted(() => {
  ro?.disconnect()
  sim?.stop()
  cancelAnimationFrame(raf)
  window.removeEventListener('ovseer-theme', readTheme)
  offEvent?.()
})
watch(root, load, { immediate: true })
watch([graph, hidden], rebuild)
watch([search, changed], requestRender)
</script>

<template>
  <div class="mapview">
    <div class="toolbar">
      <div v-if="hasMap" class="search">
        <Icon name="search" :size="13" />
        <input v-model="search" type="search" placeholder="Buscar funcionalidade…" spellcheck="false" @keydown.enter="onSearchEnter" @keydown.esc="search = ''" />
      </div>
      <span class="gap" />
      <small v-if="hasMap && !loading" class="faint stats">{{ areas.length }} áreas · {{ featureCount }} funcionalidades · {{ linkCount }} ligações<template v-if="aiWhen"> · {{ aiWhen }}</template></small>
      <button v-if="hasMap" class="ghost icon" title="Levantar os imports de novo: as ligações deduzidas acompanham o código atual" :disabled="!root || loading || mapping" @click="rescan"><Icon name="refresh" :size="14" /></button>
      <button v-if="hasMap" class="ghost icon" title="Enquadrar o gráfico" :disabled="!featureCount" @click="fit()"><Icon name="maximize" :size="14" /></button>
      <template v-if="mapping">
        <span class="mapping">
          <span v-if="progress" class="bar" :title="`${progress.done} de ${progress.total}`"><i :style="{ width: `${percent}%` }" /></span>
          <span v-else class="spinner" />
          <b v-if="progress" class="mono pct">{{ percent }}%</b>
          <span class="ellipsis">{{ status || 'Mapeando…' }}</span>
        </span>
        <button class="ghost small" @click="cancelAi">Parar</button>
      </template>
      <button v-else-if="hasMap" class="primary ai" :disabled="!root || loading" :title="`Pede ao ${aiLabel} para ler o projeto de novo e refazer o mapa`" @click="mapWithAi">
        <Icon name="sparkles" :size="14" /> Mapear de novo
      </button>
    </div>

    <div v-if="error" class="error-line"><Icon name="alert" :size="13" /><span class="ellipsis">{{ error }}</span><button class="ghost icon small" @click="error = null"><Icon name="x" :size="12" /></button></div>

    <div ref="wrap" class="stage">
      <canvas ref="canvas" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @dblclick="onDbl" @wheel="onWheel" @pointerleave="onLeave" />

      <div v-if="loading" class="center faint"><span class="spinner" /> Carregando…</div>
      <div v-else-if="!root" class="center faint">Abra um projeto para ver o mapa.</div>
      <!-- sem mapa ainda: o convite -->
      <div v-else-if="!hasMap && !mapping" class="center">
        <div class="invite">
          <Icon name="network" :size="34" class="faint" />
          <h3>Mapa funcional do projeto</h3>
          <p class="faint">A IA lê o código e monta um gráfico das <b>funcionalidades</b> do sistema, em linguagem de quem usa: as áreas ("Nota fiscal") como núcleos e, em volta, o que cada uma faz ("Imprimir nota fiscal", "Enviar por email"). Cada funcionalidade guarda os arquivos que a implementam.</p>
          <button class="primary" :disabled="!root" @click="mapWithAi"><Icon name="sparkles" :size="14" /> Mapear projeto com {{ aiLabel }}</button>
          <small class="faint">Leva alguns minutos num projeto grande. O mapa fica guardado; o botão usa a IA escolhida em "Novo agente".</small>
        </div>
      </div>
      <div v-else-if="!hasMap && mapping" class="center">
        <div class="invite">
          <h3>Mapeando com {{ aiLabel }}…</h3>
          <span class="bar big"><i :style="{ width: `${progress ? percent : 0}%` }" :class="{ indet: !progress }" /></span>
          <b v-if="progress" class="mono pct-big">{{ percent }}%</b>
          <p class="faint">{{ status || 'Preparando…' }}</p>
          <small class="faint">Os arquivos vão em pequenos lotes para a IA, em paralelo; no fim, um pedido consolida as áreas e as ligações.</small>
        </div>
      </div>

      <!-- legenda: as áreas; clique esconde/mostra, duplo clique isola -->
      <div v-if="areas.length" class="legend">
        <button v-for="a in areas" :key="a.id" class="lg" :class="{ off: hidden.has(a.id) }" :title="(a.description ? `${a.description} · ` : '') + `${a.count} ${a.count === 1 ? 'funcionalidade' : 'funcionalidades'}. Clique: esconder/mostrar; duplo clique: só esta`" @click="toggleArea(a.id)" @dblclick="onlyArea(a.id)">
          <span class="sw" :style="{ background: a.color }" /><span class="ellipsis">{{ a.name }}</span><small class="faint">{{ a.count }}</small>
        </button>
      </div>

      <!-- dica sob o mouse -->
      <div v-if="hovered && hovered.id !== selectedId" class="tip" :style="{ left: `${Math.min(tip.x + 14, size.w - 290)}px`, top: `${Math.min(tip.y + 14, size.h - 100)}px` }">
        <strong class="ellipsis">{{ hovered.n.name }}</strong>
        <small v-if="hovered.n.description">{{ hovered.n.description }}</small>
        <small class="faint"><span class="sw" :style="{ background: areaColor(hovered.n.area) }" />{{ hovered.n.kind === 'area' ? `${children.length || areas.find((a) => a.id === hovered!.n.area)?.count} funcionalidades` : `${areaName(hovered.n.area)}${hovered.n.featureKind ? ` · ${kindLabel(hovered.n.featureKind)}` : ''} · ${hovered.n.files.length} ${hovered.n.files.length === 1 ? 'arquivo' : 'arquivos'}` }}</small>
      </div>

      <!-- detalhes do selecionado -->
      <aside v-if="selected" class="details">
        <div class="d-head">
          <span class="sw big" :style="{ background: areaColor(selected.n.area) }" />
          <div class="d-title">
            <strong :title="selected.n.name">{{ selected.n.name }}</strong>
            <small class="faint ellipsis">{{ selected.n.kind === 'area' ? 'Área' : areaName(selected.n.area) }}<template v-if="selected.n.featureKind"> · {{ kindLabel(selected.n.featureKind) }}</template></small>
          </div>
          <button class="ghost icon small" title="Fechar" @click="select(null)"><Icon name="x" :size="13" /></button>
        </div>
        <p v-if="selected.n.description" class="d-desc">{{ selected.n.description }}</p>
        <div class="d-body">
          <div v-if="children.length" class="d-sec">
            <h6>Funcionalidades ({{ children.length }})</h6>
            <button v-for="c in children" :key="c.id" class="ghost d-link" :title="c.n.description" @click="goTo(c.id)"><span class="ellipsis">{{ c.n.name }}</span><small v-if="touched(c.n)" class="warn">alterado</small></button>
          </div>
          <div v-if="related.length" class="d-sec">
            <h6>Ligações ({{ related.length }})</h6>
            <button v-for="l in related" :key="l.id" class="ghost d-link" :title="l.why" @click="goTo(l.id)"><span class="ellipsis">{{ l.name }}</span><small class="faint ellipsis">{{ l.why }}</small></button>
          </div>
          <div v-if="selected.n.files.length" class="d-sec">
            <h6>Arquivos ({{ selected.n.files.length }})</h6>
            <button v-for="p in selected.n.files" :key="p" class="ghost d-link" :title="`${p} · abrir no editor`" @click="open(p)"><Icon name="external" :size="11" class="faint" /><span class="ellipsis">{{ basename(p) }}</span><small v-if="changed.has(p)" class="warn">alterado</small><small v-else class="faint ellipsis">{{ p.slice(0, p.lastIndexOf('/')) }}</small></button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.mapview { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }
.toolbar { display: flex; align-items: center; gap: 8px; flex: none; box-sizing: border-box; height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border); }
.gap { flex: 1; }
.search { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; color: var(--faint); background: var(--bg); width: 220px; }
.search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font-size: 12.5px; outline: none; }
.stats { font-size: 11.5px; white-space: nowrap; }
.toolbar .ai { height: 28px; gap: 6px; font-size: 12.5px; }
.mapping { display: inline-flex; align-items: center; gap: 8px; max-width: 420px; font-size: 12px; color: var(--muted); }
.pct { font-size: 11.5px; color: var(--text); min-width: 32px; text-align: right; }
.bar { position: relative; width: 120px; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; flex: none; }
.bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--accent); transition: width 0.3s ease; }
.bar.big { width: 100%; height: 8px; }
.bar i.indet { width: 30% !important; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { 0% { left: -30%; } 100% { left: 100%; } }
.pct-big { font-size: 22px; color: var(--text); }
.error-line { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12.5px; color: var(--del); background: var(--del-bg); border-bottom: 1px solid var(--border); }
.error-line span { flex: 1; }
.stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--bg); }
canvas { display: block; cursor: grab; touch-action: none; }
canvas:active { cursor: grabbing; }
.center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; }
.center.faint { pointer-events: none; }
.invite { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 460px; padding: 28px; text-align: center; border-radius: 16px; background: var(--panel); border: 1px solid var(--border); }
.invite h3 { margin: 0; font-size: 16px; }
.invite p { margin: 0; font-size: 13px; line-height: 1.5; }
.invite p b { color: var(--text); font-weight: 600; }
.invite button { gap: 6px; }
.invite small { font-size: 11.5px; }
.legend { position: absolute; right: 12px; top: 12px; display: flex; flex-direction: column; gap: 1px; max-height: calc(100% - 24px); overflow: auto; padding: 6px; border-radius: 10px; background: color-mix(in srgb, var(--panel) 88%, transparent); border: 1px solid var(--border); backdrop-filter: blur(6px); max-width: 240px; }
.lg { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font-size: 12px; text-align: left; cursor: pointer; }
.lg:hover { background: var(--hover); }
.lg.off { opacity: 0.4; }
.lg .ellipsis { flex: 1; min-width: 0; }
.lg small { font-size: 11px; }
.sw { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; margin-right: 5px; }
.sw.big { width: 12px; height: 12px; margin: 0; }
.tip { position: absolute; z-index: 3; display: flex; flex-direction: column; gap: 3px; width: 270px; padding: 8px 10px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); font-size: 12px; pointer-events: none; }
.tip strong { font-size: 12.5px; }
.tip small { font-size: 11.5px; line-height: 1.4; }
.details { position: absolute; left: 12px; bottom: 12px; z-index: 2; width: 340px; max-height: calc(100% - 24px); display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: color-mix(in srgb, var(--panel) 94%, transparent); border: 1px solid var(--border); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); backdrop-filter: blur(8px); }
.d-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.d-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.d-title strong { font-size: 13.5px; line-height: 1.3; }
.d-title small { font-size: 11.5px; }
.d-desc { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text); }
.d-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
.d-sec h6 { margin: 0 0 2px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.d-link { display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0 6px; justify-content: flex-start; font-size: 12px; color: var(--text); }
.d-link small { font-size: 11px; margin-left: auto; max-width: 45%; flex: none; }
.warn { color: var(--mod); }
</style>
