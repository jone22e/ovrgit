<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { ForceGraph3DInstance } from '3d-force-graph'
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

// ---------- painel de ajustes (como o do Obsidian): exibição e forças, guardados para todos os projetos ----------
interface GraphPrefs {
  /** multiplicadores (1 = padrão) */
  nodeSize: number
  linkWidth: number
  labels: number
  center: number
  repel: number
  linkForce: number
  linkDistance: number
  /** setas nas ligações apontadas pela IA (de quem usa para quem é usado) */
  arrows: boolean
  /** funcionalidades sem nenhuma ligação (fora a da área) */
  orphans: boolean
}
const PREFS_DEFAULT: GraphPrefs = { nodeSize: 1, linkWidth: 1, labels: 1, center: 1, repel: 1, linkForce: 1, linkDistance: 1, arrows: false, orphans: true }
const tune = ref<GraphPrefs>(readPrefs())
function readPrefs(): GraphPrefs {
  try {
    return { ...PREFS_DEFAULT, ...(JSON.parse(localStorage.getItem('ovseer.map.prefs') ?? '{}') as Partial<GraphPrefs>) }
  } catch {
    return { ...PREFS_DEFAULT }
  }
}
const panelOpen = ref(localStorage.getItem('ovseer.map.panel') !== '0')
function togglePanel() {
  panelOpen.value = !panelOpen.value
  localStorage.setItem('ovseer.map.panel', panelOpen.value ? '1' : '0')
}
const resetPrefs = () => (tune.value = { ...PREFS_DEFAULT })
/** Seções do painel abertas */
const secOpen = ref<Record<string, boolean>>({ areas: true, display: true, forces: false })
const SLIDERS: { key: keyof GraphPrefs; label: string; min: number; max: number; step: number; sec: 'display' | 'forces' }[] = [
  { key: 'nodeSize', label: 'Tamanho dos nós', min: 0.4, max: 2.5, step: 0.05, sec: 'display' },
  { key: 'linkWidth', label: 'Espessura das ligações', min: 0.3, max: 4, step: 0.1, sec: 'display' },
  { key: 'labels', label: 'Quantidade de rótulos', min: 0, max: 3, step: 0.1, sec: 'display' },
  { key: 'center', label: 'Força central', min: 0, max: 3, step: 0.1, sec: 'forces' },
  { key: 'repel', label: 'Repulsão', min: 0.2, max: 3, step: 0.1, sec: 'forces' },
  { key: 'linkForce', label: 'Força das ligações', min: 0.1, max: 3, step: 0.1, sec: 'forces' },
  { key: 'linkDistance', label: 'Distância das ligações', min: 0.3, max: 3, step: 0.1, sec: 'forces' }
]
const loading = ref(false)
const mapping = ref(false)
const status = ref('')
/** Andamento do mapeamento com IA: lotes feitos do total (null: ainda preparando) */
const progress = ref<{ done: number; total: number; stage: 'chunks' | 'reduce'; found: number } | null>(null)
const percent = computed(() => (progress.value ? Math.round((progress.value.done / Math.max(1, progress.value.total)) * 100) : 0))
/** Últimas funcionalidades encontradas, para a tela de andamento */
const recent = ref<string[]>([])
const startedAt = ref(0)
const clock = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | undefined
const elapsed = computed(() => Math.max(0, Math.round((clock.value - startedAt.value) / 1000)))
const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`)
/** Estimativa do que falta, pelo ritmo dos lotes (só depois de alguns lotes) */
const remaining = computed(() => {
  const p = progress.value
  if (!p || p.stage !== 'chunks' || p.done < 3 || !startedAt.value) return null
  const per = (clock.value - startedAt.value) / 1000 / p.done
  return Math.round(per * (p.total - p.done))
})
watch(mapping, (on) => {
  clearInterval(clockTimer)
  if (on) {
    if (!startedAt.value) startedAt.value = Date.now()
    clockTimer = setInterval(() => (clock.value = Date.now()), 1000)
  } else startedAt.value = 0
})
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
/** O nó entra no gráfico: área não escondida e, se os órfãos estão ocultos, com alguma ligação */
const isShown = (n: FeatureNode) => !hidden.value.has(n.area) && (tune.value.orphans || n.kind === 'area' || n.degree > 0)
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
const hueOf = (i: number) => (i * 137.508 + 20) % 360
const colorOf = (i: number) => `hsl(${hueOf(i)}, ${theme.value.dark ? 62 : 55}%, ${theme.value.dark ? 64 : 42}%)`
/** A mesma cor com transparência (o 3D esmaece por aqui) */
const colorOfA = (i: number, a: number) => `hsla(${hueOf(i)}, ${theme.value.dark ? 62 : 55}%, ${theme.value.dark ? 64 : 42}%, ${a})`
/** Cor do tema ("#rrggbb") com transparência */
function hexA(hex: string, a: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

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
    progress.value = running?.type === 'progress' ? { done: running.done, total: running.total, stage: running.stage, found: running.found } : null
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
  recent.value = []
  startedAt.value = Date.now()
  status.value = 'Começando…'
  try {
    await api.mapAi(r, { provider: prefs.provider, model: prefs.model[prefs.provider], effort: prefs.effort[prefs.provider] })
  } catch (e) {
    mapping.value = false
    error.value = clean(e)
  }
}
const cancelAi = () => root.value && api.mapCancel(root.value).catch(() => undefined)
/** Remapeia só a área selecionada: funcionalidades e ligações novas, sem mexer nas outras áreas */
async function remapArea(areaId: string) {
  const r = root.value
  if (!r || mapping.value) return
  error.value = null
  mapping.value = true
  progress.value = null
  recent.value = []
  startedAt.value = Date.now()
  status.value = 'Começando…'
  try {
    await api.mapArea(r, areaId, { provider: prefs.provider, model: prefs.model[prefs.provider], effort: prefs.effort[prefs.provider] })
  } catch (e) {
    mapping.value = false
    error.value = clean(e)
  }
}
function onMapEvent(r: string, ev: MapEvent) {
  if (r !== root.value) return
  if (ev.type === 'status') status.value = ev.text
  else if (ev.type === 'progress') {
    progress.value = { done: ev.done, total: ev.total, stage: ev.stage, found: ev.found }
    status.value = ev.text
    if (ev.sample?.length) recent.value = [...ev.sample, ...recent.value].slice(0, 6)
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
/** Muda a cada gráfico refeito: o painel de detalhes (que lê `nodes` e `links`, não reativos) acompanha */
const graphRev = ref(0)
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
  const visible = g.nodes.filter((n) => isShown(n))
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
  sim = forceSimulation<GNode, GLink>(nodes)
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
  applyForces()
  fitPending = !hadSaved
  if (hadSaved) fit()
  else view = { k: Math.max(0.1, Math.min(1, Math.min(size.w, size.h) / 2 / (spread + 80))), x: size.w / 2, y: size.h / 2 }
  rank.clear()
  ;[...nodes].sort((a, b) => (b.n.kind === 'area' ? 1e6 : b.n.degree) - (a.n.kind === 'area' ? 1e6 : a.n.degree)).forEach((n, i) => rank.set(n.id, i))
  graphRev.value++
  requestRender()
}

/** As forças do 2D com os ajustes do painel (também ao mexer nos sliders, sem refazer o gráfico) */
function applyForces() {
  if (!sim) return
  const p = tune.value
  const ns = p.nodeSize
  const ring = Math.sqrt(nodes.length) * 34 + 160
  sim
    // funcionalidades em volta da sua área (mola curta e forte); ligações entre funcionalidades puxam de leve;
    // repulsão forte para os rótulos não se amontoarem
    .force('link', forceLink<GNode, GLink>(links).distance((l) => (l.kind === 'area' ? 70 + l.source.r * ns : 160) * p.linkDistance).strength((l) => Math.min(1, (l.kind === 'area' ? 0.6 : l.kind === 'ai' ? 0.12 : 0.04) * p.linkForce)))
    .force('charge', forceManyBody<GNode>().strength((n) => (n.n.kind === 'area' ? -900 : -220) * p.repel).distanceMax(900))
    .force('center', forceCenter(0, 0).strength(0.03 * p.center))
    .force('collide', forceCollide<GNode>((n) => n.r * ns + (n.n.kind === 'area' ? 26 : 16)).iterations(2))
    // nós sem ligação: ficam num anel em volta, como no Obsidian
    .force('ring', forceRadial<GNode>(ring, 0, 0).strength((n) => (n.n.kind === 'feature' && !n.n.degree ? 0.3 : 0)))
}
/** Reaquece a física: o gráfico se reorganiza com as forças atuais */
function animate() {
  if (mode.value === '3d') return void g3?.d3ReheatSimulation()
  sim?.alpha(1).restart()
}

/** Enquadra o gráfico inteiro na área (`keep`: continua enquadrando a cada tanto, até a física assentar) */
function fit(keep = false) {
  if (!keep && mode.value === '3d') return void g3?.zoomToFit(600, 60)
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
  for (const e of graph.value?.edges ?? []) {
    if (e.from === id) out.add(e.to)
    else if (e.to === id) out.add(e.from)
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
  const ns = tune.value.nodeSize
  const lw = tune.value.linkWidth
  // traços: os da área na cor dela; os da IA cheios; os deduzidos pontilhados
  for (const l of links) {
    const on = near ? near.has(l.source.id) && near.has(l.target.id) && (l.source.id === focusId || l.target.id === focusId) : false
    const off = near ? !on : matches ? !(matches.has(l.source.id) || matches.has(l.target.id)) : false
    const areaLink = l.kind === 'area'
    ctx.strokeStyle = on ? t.accent : areaLink ? (cols[l.source.ai] ?? t.text) : t.text
    ctx.globalAlpha = on ? 0.85 : off ? 0.03 : areaLink ? 0.28 : l.kind === 'ai' ? (t.dark ? 0.22 : 0.3) : t.dark ? 0.1 : 0.14
    ctx.lineWidth = ((on ? 1.6 : areaLink ? 1.2 : l.kind === 'ai' ? 1.3 : 1) * lw) / view.k
    if (l.kind === 'import') ctx.setLineDash([3 / view.k, 4 / view.k])
    ctx.beginPath()
    ctx.moveTo(l.source.x, l.source.y)
    ctx.lineTo(l.target.x, l.target.y)
    ctx.stroke()
    if (l.kind === 'import') ctx.setLineDash([])
    // seta na ponta (de quem usa para quem é usado), encostada no nó de destino
    if (tune.value.arrows && l.kind === 'ai' && !off) {
      const dx = l.target.x - l.source.x
      const dy = l.target.y - l.source.y
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len, uy = dy / len
      const tx = l.target.x - ux * (l.target.r * ns + 3 / view.k)
      const ty = l.target.y - uy * (l.target.r * ns + 3 / view.k)
      const a = 7 / view.k
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(tx - ux * a - uy * a * 0.5, ty - uy * a + ux * a * 0.5)
      ctx.lineTo(tx - ux * a + uy * a * 0.5, ty - uy * a - ux * a * 0.5)
      ctx.closePath()
      ctx.fill()
    }
  }
  // nós
  for (const n of nodes) {
    const off = dimmed(n.id)
    const color = cols[n.ai] ?? t.text
    const r = n.r * ns
    ctx.globalAlpha = off ? 0.15 : 1
    if (n.n.kind === 'area') {
      // núcleo: disco translúcido com borda cheia
      ctx.fillStyle = color
      ctx.globalAlpha = off ? 0.08 : 0.22
      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = off ? 0.15 : 0.9
      ctx.strokeStyle = color
      ctx.lineWidth = 2 / view.k
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    if (touched(n.n) && !off) {
      ctx.strokeStyle = t.mod
      ctx.lineWidth = 2 / view.k
      ctx.beginPath()
      ctx.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (n.id === focusId) {
      ctx.strokeStyle = t.accent
      ctx.lineWidth = 2 / view.k
      ctx.beginPath()
      ctx.arc(n.x, n.y, r + 5 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  // rótulos: áreas sempre; funcionalidades em destaque, na busca ou as mais ligadas, mais conforme o zoom
  ctx.globalAlpha = 1
  const lf = tune.value.labels
  const budget = lf === 0 ? 0 : view.k >= 1.5 / lf ? Infinity : Math.max(areas.value.length + Math.round(6 * lf), Math.round(areas.value.length + 14 * lf * view.k * view.k))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const n of nodes) {
    const isArea = n.n.kind === 'area'
    const show = (isArea && lf > 0) || n.id === focusId || (near ? near.has(n.id) : matches ? matches.has(n.id) : (rank.get(n.id) ?? Infinity) < budget)
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
    } else ctx.fillText(n.label, n.x, n.y + n.r * ns + 3 / view.k)
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
    const lim = n.r * tune.value.nodeSize + 3 / view.k
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
  refresh3d()
}
/** Centraliza o nó na área (busca e cliques na lista de ligações) */
function goTo(id: string) {
  select(id)
  if (mode.value === '3d') return flyTo(id)
  const n = byId.get(id)
  if (!n) return
  const k = Math.max(view.k, 1.2)
  view = { k, x: size.w / 2 - n.x * k, y: size.h / 2 - n.y * k }
  requestRender()
}
function open(path: string) {
  state.tab = 'changes'
  setPane('files')
  openSource(path, true)
}
const selected = computed(() => (graphRev.value, selectedId.value ? byId.get(selectedId.value) ?? null : null))
const hovered = computed(() => (hoverId.value ? byId.get(hoverId.value) ?? null : null))
const areaName = (id: string) => areas.value.find((a) => a.id === id)?.name ?? id
const areaColor = (id: string) => areas.value.find((a) => a.id === id)?.color ?? theme.value.text
const KIND: Record<string, string> = { screen: 'tela', action: 'ação', report: 'relatório', job: 'rotina', integration: 'integração', api: 'API', config: 'configuração' }
const kindLabel = (k?: string) => (k ? KIND[k] ?? k : '')
/** Ligações do selecionado (fora a da área), com o motivo */
const related = computed(() => {
  const s = selected.value
  if (!s || graphRev.value < 0) return []
  return links
    .filter((l) => l.kind !== 'area' && (l.source.id === s.id || l.target.id === s.id))
    .map((l) => {
      const other = l.source.id === s.id ? l.target : l.source
      return { id: other.id, name: other.n.name, why: l.why ?? (l.kind === 'import' ? `${l.weight} import${l.weight === 1 ? '' : 's'}` : ''), ai: l.kind === 'ai' }
    })
    .sort((a, b) => Number(b.ai) - Number(a.ai))
})
/** Funcionalidades de uma área selecionada */
const children = computed(() => (graphRev.value, selected.value?.n.kind === 'area' ? nodes.filter((n) => n.n.kind === 'feature' && n.n.area === selected.value!.n.area) : []))
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

// ---------- 3D: a mesma física em três eixos; arrastar gira, a roda aproxima ----------
interface N3 {
  id: string
  r: number
  ai: number
  n: FeatureNode
  x?: number
  y?: number
  z?: number
}
interface L3 {
  source: string | N3
  target: string | N3
  kind: FeatureEdge['kind']
  why?: string
}
const mode = ref<'2d' | '3d'>(localStorage.getItem('ovseer.map.mode') === '3d' ? '3d' : '2d')
/** Giro automático (3D) */
const spin = ref(false)
const el3d = ref<HTMLElement>()
let g3: ForceGraph3DInstance<N3, L3> | null = null
const nodes3 = new Map<string, N3>()
let ticks3 = 0
/** Primeiro layout do 3D em andamento: o enquadramento acompanha */
let settling3 = true
function setMode(m: '2d' | '3d') {
  mode.value = m
  localStorage.setItem('ovseer.map.mode', m)
}
const idOf = (v: string | N3) => (typeof v === 'string' ? v : v.id)
/** Dados do 3D a partir do gráfico (nós já existentes mantêm a posição) */
function data3d() {
  const g = graph.value
  if (!g) return { nodes: [], links: [] }
  const ai = areaIndex.value
  const visible = g.nodes.filter((n) => isShown(n))
  const keep = new Set<string>()
  const nodes: N3[] = visible.map((n) => {
    keep.add(n.id)
    const prev = nodes3.get(n.id)
    const r = n.kind === 'area' ? Math.min(14, 6 + Math.sqrt(g.nodes.filter((x) => x.area === n.area).length) * 0.9) : Math.min(7, 2.2 + Math.sqrt(n.degree) * 0.9)
    const node: N3 = prev ?? { id: n.id, r, ai: 0, n }
    node.r = r
    node.ai = ai.get(n.area) ?? 0
    node.n = n
    nodes3.set(n.id, node)
    return node
  })
  for (const id of [...nodes3.keys()]) if (!keep.has(id)) nodes3.delete(id)
  const links: L3[] = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)).map((e) => ({ source: e.from, target: e.to, kind: e.kind, why: e.why }))
  return { nodes, links }
}
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
async function build3d() {
  const el = el3d.value
  if (!el) return
  const [{ default: ForceGraph3D }, { default: SpriteText }] = await Promise.all([import('3d-force-graph'), import('three-spritetext')])
  if (!el3d.value || mode.value !== '3d') return
  if (!g3) {
    const t = theme.value
    // o construtor não é genérico nos tipos da biblioteca: os nós e as ligações são os nossos
    const g = (new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<N3, L3>)
      .showNavInfo(false)
      .backgroundColor(t.bg)
      .nodeRelSize(1)
      .nodeVal((n) => Math.pow(n.r * tune.value.nodeSize, 3))
      .nodeResolution(14)
      .nodeOpacity(1)
      .nodeColor((n) => nodeColor3(n))
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((n: N3) => {
        // rótulo flutuando sobre a esfera: as áreas em destaque, as funcionalidades menores
        const area = n.n.kind === 'area'
        const label = new SpriteText(n.n.name, area ? 7 : 3.4, theme.value.text) as InstanceType<typeof SpriteText> & { material: { depthWrite: boolean }; position: { y: number } }
        label.fontFace = 'system-ui, -apple-system, sans-serif'
        label.fontWeight = area ? 'bold' : 'normal'
        label.backgroundColor = false
        label.material.depthWrite = false
        label.position.y = n.r + (area ? 7 : 4)
        return label as never
      })
      .nodeLabel((n) => {
        const a = n.n.kind === 'area' ? 'Área' : areaName(n.n.area)
        return `<div class="tip3"><strong>${esc(n.n.name)}</strong>${n.n.description ? `<small>${esc(n.n.description)}</small>` : ''}<small class="faint">${esc(a)}${n.n.kind === 'feature' ? ` · ${n.n.files.length} ${n.n.files.length === 1 ? 'arquivo' : 'arquivos'}` : ''}</small></div>`
      })
      .linkColor((l) => linkColor3(l))
      .linkWidth(() => (tune.value.linkWidth > 1.4 ? tune.value.linkWidth * 0.35 : 0))
      .linkOpacity(0.55)
      .onNodeHover((n) => {
        el.style.cursor = n ? 'pointer' : ''
        if ((n?.id ?? null) !== hoverId.value) {
          hoverId.value = n?.id ?? null
          refresh3d()
        }
      })
      .onNodeClick((n) => {
        select(n.id)
        flyTo(n.id)
      })
      .onBackgroundClick(() => select(null))
      .cooldownTicks(250)
      // enquanto a física assenta o gráfico encolhe: reenquadra de tempos em tempos e, no fim, com calma
      .onEngineTick(() => {
        if (++ticks3 % 25 === 0 && settling3) g.zoomToFit(0, 60)
      })
      .onEngineStop(() => {
        settling3 = false
        g.zoomToFit(500, 60)
      })
    g3 = g
    applyForces3d()
    applySpin()
  }
  size3d()
  settling3 = true
  g3.graphData(data3d())
}
function nodeColor3(n: N3): string {
  const focusId = hoverId.value ?? selectedId.value
  const near = neighborsOf(focusId)
  const q = search.value.trim().toLowerCase()
  const off = near ? !near.has(n.id) : q ? !`${n.n.name} ${n.n.description ?? ''}`.toLowerCase().includes(q) : false
  if (n.id === focusId) return theme.value.accent
  return off ? colorOfA(n.ai, 0.12) : colorOf(n.ai)
}
function linkColor3(l: L3): string {
  const t = theme.value
  const a = idOf(l.source)
  const b = idOf(l.target)
  const focusId = hoverId.value ?? selectedId.value
  const near = neighborsOf(focusId)
  if (near) {
    const on = (a === focusId || b === focusId) && near.has(a) && near.has(b)
    return on ? t.accent : hexA(t.text, 0.03)
  }
  if (l.kind === 'area') return colorOfA(nodes3.get(a)?.ai ?? 0, 0.45)
  return hexA(t.text, l.kind === 'ai' ? 0.35 : 0.14)
}
/** Reaplica as cores (destaque, esmaecimento e busca) */
function refresh3d() {
  if (!g3) return
  g3.nodeColor(g3.nodeColor()).linkColor(g3.linkColor())
}
/** Voa até o nó: a câmera se aproxima dele, olhando para ele */
function flyTo(id: string) {
  const n = nodes3.get(id)
  if (!g3 || !n || n.x === undefined) return
  const x = n.x ?? 0, y = n.y ?? 0, z = n.z ?? 0
  const dist = 110
  const r = Math.hypot(x, y, z) || 1
  const k = 1 + dist / r
  g3.cameraPosition({ x: x * k, y: y * k, z: z * k }, { x, y, z }, 900)
}
/** As forças do 3D com os ajustes do painel */
function applyForces3d() {
  if (!g3) return
  const p = tune.value
  const charge = g3.d3Force('charge') as unknown as { strength: (s: (n: N3) => number) => void } | undefined
  charge?.strength((n) => (n.n.kind === 'area' ? -260 : -70) * p.repel)
  const link = g3.d3Force('link') as unknown as { distance: (d: (l: L3) => number) => void; strength: (s: (l: L3) => number) => void } | undefined
  link?.distance((l) => (l.kind === 'area' ? 38 : 85) * p.linkDistance)
  link?.strength((l) => Math.min(1, (l.kind === 'area' ? 0.8 : l.kind === 'ai' ? 0.3 : 0.1) * p.linkForce))
  const center = g3.d3Force('center') as unknown as { strength?: (s: number) => void } | undefined
  center?.strength?.(Math.min(1, 0.3 * p.center))
  g3.d3ReheatSimulation()
}
function applySpin() {
  const c = g3?.controls() as { autoRotate?: boolean; autoRotateSpeed?: number } | undefined
  if (!c) return
  c.autoRotate = spin.value
  c.autoRotateSpeed = 0.8
}
function size3d() {
  const el = el3d.value
  if (!g3 || !el) return
  const r = el.getBoundingClientRect()
  if (r.width && r.height) g3.width(r.width).height(r.height)
}
function destroy3d() {
  g3?._destructor()
  g3 = null
  nodes3.clear()
}
watch(mode, async (m) => {
  if (m === '3d') {
    await nextTick()
    await build3d()
  } else destroy3d()
})
watch(spin, applySpin)
watch([graph, hidden], async () => {
  if (mode.value !== '3d') return
  if (g3) g3.graphData(data3d())
  else {
    // o mapa chegou depois de o componente montar: o palco 3D só existe agora
    await nextTick()
    await build3d()
  }
})
watch(search, refresh3d)
watch(
  tune,
  (p) => {
    localStorage.setItem('ovseer.map.prefs', JSON.stringify(p))
    if (mode.value === '3d' && g3) {
      g3.nodeVal(g3.nodeVal()).linkWidth(g3.linkWidth())
      applyForces3d()
    } else if (sim) {
      applyForces()
      sim.alpha(0.5).restart()
    }
    requestRender()
  },
  { deep: true }
)
watch(() => tune.value.orphans, rebuild)
watch(theme, () => {
  g3?.backgroundColor(theme.value.bg)
  refresh3d()
})

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
  size3d()
}
onMounted(() => {
  readTheme()
  ro = new ResizeObserver(resize)
  if (wrap.value) ro.observe(wrap.value)
  resize()
  window.addEventListener('ovseer-theme', readTheme)
  offEvent = api.onMapEvent(onMapEvent)
  if (mode.value === '3d') build3d()
})
onUnmounted(() => {
  ro?.disconnect()
  destroy3d()
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
      <span v-if="hasMap" class="seg dim" role="group" aria-label="Dimensões">
        <button :class="{ on: mode === '2d' }" title="Plano, como o gráfico do Obsidian" @click="setMode('2d')">2D</button>
        <button :class="{ on: mode === '3d' }" title="Em três eixos: arraste para girar, role para aproximar" @click="setMode('3d')">3D</button>
      </span>
      <button v-if="hasMap && mode === '3d'" class="ghost icon" :class="{ on: spin }" :title="spin ? 'Parar o giro' : 'Girar sozinho'" @click="spin = !spin"><Icon name="refresh" :size="14" /></button>
      <template v-if="mapping">
        <span class="mapping">
          <span v-if="progress" class="bar" :class="{ busy: progress.stage === 'reduce' }" :title="`${progress.done} de ${progress.total}`"><i :style="{ width: `${percent}%` }" /></span>
          <span v-else class="spinner" />
          <b v-if="progress" class="mono pct">{{ percent }}%</b>
          <span class="ellipsis">{{ progress?.stage === 'reduce' ? 'Consolidando as áreas…' : status || 'Mapeando…' }}</span>
        </span>
        <button class="ghost small" @click="cancelAi">Parar</button>
      </template>
      <button v-else-if="hasMap" class="primary ai" :disabled="!root || loading" :title="`Pede ao ${aiLabel} para ler o projeto de novo e refazer o mapa`" @click="mapWithAi">
        <Icon name="sparkles" :size="14" /> Mapear de novo
      </button>
    </div>

    <div v-if="error" class="error-line"><Icon name="alert" :size="13" /><span class="ellipsis">{{ error }}</span><button class="ghost icon small" @click="error = null"><Icon name="x" :size="12" /></button></div>

    <div ref="wrap" class="stage">
      <canvas v-show="mode === '2d'" ref="canvas" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @dblclick="onDbl" @wheel="onWheel" @pointerleave="onLeave" />
      <div v-if="mode === '3d' && hasMap" ref="el3d" class="stage3d" />

      <div v-if="loading" class="center faint"><span class="spinner" /> Carregando…</div>
      <div v-else-if="!root" class="center faint">Abra um projeto para ver o mapa.</div>
      <!-- sem mapa ainda: o convite -->
      <div v-else-if="!hasMap && !mapping" class="center">
        <div class="invite">
          <Icon name="network" :size="34" class="faint" />
          <h3>Mapa funcional do projeto</h3>
          <p class="faint">O sistema desenhado por <b>funcionalidades</b>, não por arquivos: cada área é um núcleo e, em volta, o que ela faz.</p>
          <p class="example"><span class="ex-area">Nota fiscal</span><span class="ex-arrow">→</span><span>Imprimir nota fiscal</span><span class="ex-dot">·</span><span>Enviar por email</span><span class="ex-dot">·</span><span>Cancelar nota</span></p>
          <button class="primary" :disabled="!root" @click="mapWithAi"><Icon name="sparkles" :size="14" /> Mapear projeto com {{ aiLabel }}</button>
          <small class="faint">Alguns minutos num projeto grande. O mapa fica salvo em <code>.ovseer/map.json</code>, no repositório.</small>
        </div>
      </div>
      <div v-else-if="!hasMap && mapping" class="center">
        <div class="invite prog">
          <div class="p-head">
            <div class="p-title">
              <h3>Mapeando o projeto</h3>
              <small class="faint">com {{ aiLabel }} · {{ fmt(elapsed) }}</small>
            </div>
            <b class="mono pct-big">{{ progress ? percent : 0 }}<span>%</span></b>
          </div>
          <span class="bar big" :class="{ busy: progress?.stage === 'reduce' }"><i :style="{ width: `${progress ? percent : 0}%` }" :class="{ indet: !progress }" /></span>
          <div class="p-row">
            <span class="p-stage" :class="{ on: !progress || progress.stage === 'chunks' }"><i>1</i> Lendo os arquivos</span>
            <span class="p-stage" :class="{ on: progress?.stage === 'reduce' }"><i>2</i> Consolidando as áreas</span>
          </div>
          <p v-if="!progress" class="p-status faint">{{ status || 'Preparando…' }}</p>
          <p v-else-if="progress.stage === 'chunks'" class="p-status">
            <span class="faint">Lote {{ progress.done }} de {{ progress.total - 1 }}</span>
            <span class="mono p-dir ellipsis" :title="status">{{ status }}</span>
            <span v-if="remaining !== null" class="faint">~{{ fmt(remaining) }} restantes</span>
          </p>
          <p v-else class="p-status wrap faint">Juntando {{ progress.found }} funcionalidades candidatas em áreas e ligações. Leva um ou dois minutos.</p>
          <div v-if="progress?.found" class="p-found">
            <small class="faint">{{ progress.found }} {{ progress.found === 1 ? 'funcionalidade encontrada' : 'funcionalidades encontradas' }}</small>
            <ul v-if="recent.length">
              <li v-for="(r, i) in recent" :key="`${i}:${r}`" :style="{ opacity: 1 - i * 0.14 }">{{ r }}</li>
            </ul>
          </div>
          <button class="ghost small p-stop" @click="cancelAi">Parar</button>
        </div>
      </div>

      <!-- painel de ajustes: áreas (a legenda), exibição e forças -->
      <button v-if="hasMap && !panelOpen" class="ghost icon panel-btn" title="Ajustes do gráfico" @click="togglePanel"><Icon name="sliders" :size="14" /></button>
      <aside v-if="hasMap && panelOpen" class="panel">
        <div class="pn-head">
          <strong>Ajustes</strong>
          <span class="gap" />
          <button class="ghost icon small" title="Voltar ao padrão" @click="resetPrefs"><Icon name="undo" :size="13" /></button>
          <button class="ghost icon small" title="Fechar" @click="togglePanel"><Icon name="x" :size="13" /></button>
        </div>

        <section>
          <button class="pn-sec" @click="secOpen.areas = !secOpen.areas"><Icon name="chevron" :size="11" class="chev" :class="{ open: secOpen.areas }" /> Áreas <small class="faint">{{ areas.length }}</small></button>
          <div v-if="secOpen.areas" class="legend">
            <button v-for="a in areas" :key="a.id" class="lg" :class="{ off: hidden.has(a.id) }" :title="(a.description ? `${a.description} · ` : '') + `${a.count} ${a.count === 1 ? 'funcionalidade' : 'funcionalidades'}. Clique: esconder/mostrar; duplo clique: só esta`" @click="toggleArea(a.id)" @dblclick="onlyArea(a.id)">
              <span class="sw" :style="{ background: a.color }" /><span class="ellipsis">{{ a.name }}</span><small class="faint">{{ a.count }}</small>
            </button>
            <button v-if="hidden.size" class="ghost link" @click="hidden = new Set()">Mostrar todas</button>
          </div>
        </section>

        <section>
          <button class="pn-sec" @click="secOpen.display = !secOpen.display"><Icon name="chevron" :size="11" class="chev" :class="{ open: secOpen.display }" /> Exibir</button>
          <div v-if="secOpen.display" class="pn-body">
            <label class="row"><span>Setas nas ligações</span><input v-model="tune.arrows" type="checkbox" class="switch" /></label>
            <label class="row"><span>Sem ligações (órfãs)</span><input v-model="tune.orphans" type="checkbox" class="switch" /></label>
            <label v-for="sl in SLIDERS.filter((x) => x.sec === 'display')" :key="sl.key" class="slider">
              <span>{{ sl.label }}</span>
              <input v-model.number="tune[sl.key]" type="range" :min="sl.min" :max="sl.max" :step="sl.step" />
            </label>
          </div>
        </section>

        <section>
          <button class="pn-sec" @click="secOpen.forces = !secOpen.forces"><Icon name="chevron" :size="11" class="chev" :class="{ open: secOpen.forces }" /> Forças</button>
          <div v-if="secOpen.forces" class="pn-body">
            <label v-for="sl in SLIDERS.filter((x) => x.sec === 'forces')" :key="sl.key" class="slider">
              <span>{{ sl.label }}</span>
              <input v-model.number="tune[sl.key]" type="range" :min="sl.min" :max="sl.max" :step="sl.step" />
            </label>
            <button class="ghost animate" title="Reorganiza o gráfico com as forças atuais" @click="animate"><Icon name="play" :size="12" /> Animar</button>
          </div>
        </section>
      </aside>

      <!-- dica sob o mouse (no 3D a dica vem da própria biblioteca) -->
      <div v-if="mode === '2d' && hovered && hovered.id !== selectedId" class="tip" :style="{ left: `${Math.min(tip.x + 14, size.w - 290)}px`, top: `${Math.min(tip.y + 14, size.h - 100)}px` }">
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
        <button v-if="selected.n.kind === 'area'" class="ghost d-remap" :disabled="mapping" :title="`Relê os arquivos de ${selected.n.name} (e vizinhos) com o ${aiLabel}, atrás de funcionalidades e ligações novas; as outras áreas não mudam`" @click="remapArea(selected.n.area)">
          <Icon name="sparkles" :size="13" /> {{ mapping ? 'Mapeando…' : 'Remapear esta área' }}
        </button>
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
/* consolidando: a barra cheia respira, para mostrar que ainda está trabalhando */
.bar.busy i { animation: breathe 1.6s ease-in-out infinite; }
@keyframes slide { 0% { left: -30%; } 100% { left: 100%; } }
@keyframes breathe { 50% { opacity: 0.45; } }
.pct-big { font-size: 26px; line-height: 1; color: var(--text); font-variant-numeric: tabular-nums; }
.pct-big span { font-size: 14px; color: var(--muted); margin-left: 1px; }
/* tela de andamento */
.invite.prog { width: 460px; max-width: calc(100% - 48px); box-sizing: border-box; align-items: stretch; text-align: left; gap: 12px; padding: 20px 22px; }
.p-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.p-title { display: flex; flex-direction: column; gap: 2px; }
.p-title h3 { font-size: 15px; }
.p-row { display: flex; gap: 14px; }
.p-stage { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--faint); }
.p-stage i { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-style: normal; font-size: 10px; font-weight: 700; background: var(--panel-2); color: var(--muted); }
.p-stage.on { color: var(--text); }
.p-stage.on i { background: var(--accent); color: var(--on-accent); }
.p-status { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12.5px; margin: 0; }
.p-status > .faint { flex: none; }
.p-status.wrap { display: block; line-height: 1.45; }
.p-dir { flex: 1; min-width: 0; font-size: 11.5px; color: var(--muted); }
.p-found { display: flex; flex-direction: column; gap: 4px; padding-top: 10px; border-top: 1px solid var(--border); }
.p-found ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.p-found li { font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p-found li::before { content: '✓ '; color: var(--add); }
.p-stop { align-self: flex-end; }
.error-line { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12.5px; color: var(--del); background: var(--del-bg); border-bottom: 1px solid var(--border); }
.error-line span { flex: 1; }
.stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--bg); }
.stage3d { position: absolute; inset: 0; }
.stage3d :deep(.scene-tooltip) { font: 12px system-ui, -apple-system, sans-serif; }
.stage3d :deep(.tip3) { display: flex; flex-direction: column; gap: 3px; max-width: 260px; padding: 8px 10px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); color: var(--text); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); }
.stage3d :deep(.tip3 small) { font-size: 11.5px; line-height: 1.4; }
.stage3d :deep(.tip3 .faint) { color: var(--faint); }
.seg.dim { display: flex; padding: 2px; gap: 2px; background: var(--panel-2); border-radius: 8px; }
.seg.dim button { height: 22px; padding: 0 8px; border: 0; background: transparent; color: var(--muted); border-radius: 6px; font-size: 11.5px; font-weight: 600; }
.seg.dim button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.toolbar .ghost.on { color: var(--accent); background: var(--accent-soft); }
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
.invite code { font-family: var(--mono); font-size: 11px; padding: 1px 5px; border-radius: 5px; background: var(--panel-2); color: var(--text); }
/* o exemplo: uma área e as funcionalidades dela */
.example { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; font-size: 12.5px; color: var(--text); }
.ex-area { padding: 2px 9px; border-radius: 999px; font-weight: 600; color: var(--accent); background: var(--accent-soft); }
.ex-arrow, .ex-dot { color: var(--faint); }
.panel { position: absolute; right: 12px; top: 12px; z-index: 2; width: 236px; max-height: calc(100% - 24px); display: flex; flex-direction: column; overflow: auto; padding: 8px; border-radius: 12px; background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid var(--border); backdrop-filter: blur(8px); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3); }
.panel-btn { position: absolute; right: 12px; top: 12px; z-index: 2; background: var(--panel); border: 1px solid var(--border); }
.pn-head { display: flex; align-items: center; gap: 2px; padding: 2px 4px 6px; font-size: 13px; }
.panel section { border-top: 1px solid var(--border); padding: 4px 0; }
.pn-sec { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 4px; border: 0; background: transparent; color: var(--text); font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; border-radius: 6px; }
.pn-sec:hover { background: var(--hover); }
.pn-sec small { font-weight: 400; }
.chev { transition: transform 0.12s; }
.chev.open { transform: rotate(90deg); }
.pn-body { display: flex; flex-direction: column; gap: 8px; padding: 4px 4px 6px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text); cursor: pointer; }
.slider { display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--muted); }
.slider input { width: 100%; margin: 0; accent-color: var(--accent); }
.switch { appearance: none; width: 30px; height: 17px; margin: 0; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); position: relative; cursor: pointer; flex: none; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--muted); transition: transform 0.12s, background 0.12s; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(13px); background: var(--on-accent); }
.animate { align-self: flex-start; height: 26px; gap: 6px; font-size: 12px; color: var(--accent); }
.link { height: 24px; padding: 0 8px; font-size: 11.5px; color: var(--accent); justify-content: flex-start; }
.legend { display: flex; flex-direction: column; gap: 1px; padding: 2px 0 4px; }
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
.d-remap { align-self: flex-start; height: 26px; gap: 6px; font-size: 12px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accent-soft); }
</style>
