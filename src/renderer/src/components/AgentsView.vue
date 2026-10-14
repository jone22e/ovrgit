<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { AgentAction, AgentHistoryItem, AgentMode, AgentSnapshot, KnownModels } from '@shared/types'
import { api, ask, openNewAgent, saveSettings, setPane, setShowDock, state, toast } from '../store'
import { groupOf } from '@shared/repoGroups'
import { PROVIDER_LABEL } from '@shared/models'
import { ago as agoSince } from '../ago'
import AgentCard from './AgentCard.vue'
import QueuePanel from './QueuePanel.vue'
import AskCard from './AskCard.vue'
import AgentWindowMenu from './AgentWindowMenu.vue'
import Icon from './Icon.vue'
import MiniComposer from './MiniComposer.vue'
import Modal from './Modal.vue'

/**
 * Gerenciador de agentes (orquestrador): todas as conversas abertas, de qualquer projeto, em cartões à esquerda, e a
 * conversa escolhida embutida à direita. Pelo botão direito do cartão uma conversa pode ir para uma janela própria,
 * sem sair daqui. As ações vão para a janela do agente, que executa.
 */
const snaps = computed(() => state.agentSnaps)
const byStatus = (s: AgentSnapshot['status']) => snaps.value.filter((a) => a.status === s)
/** Dentro de cada situação, as conversas fixadas vêm primeiro; o resto segue a ordem dada */
const pinnedFirst = (list: AgentSnapshot[], by: (a: AgentSnapshot, b: AgentSnapshot) => number = () => 0) =>
  [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || by(a, b))
/** Precisa de você: esperando resposta primeiro (a mais antiga no topo), depois as que falharam */
const needYou = computed(() => [...pinnedFirst(byStatus('waiting'), (a, b) => a.since - b.since), ...pinnedFirst(byStatus('error'), (a, b) => b.since - a.since)])
const running = computed(() => pinnedFirst(byStatus('live'), (a, b) => a.since - b.since))
const done = computed(() => pinnedFirst(byStatus('done'), (a, b) => b.since - a.since))
/** Sem conversa e fora da espera: uma conversa recém-criada (ou reiniciada), que você vai usar agora; a mais nova primeiro */
const fresh = computed(() => pinnedFirst(byStatus('idle').filter((a) => !a.standby), (a, b) => b.since - a.since))
/** Em espera: pega tarefas da fila; fica no fim */
const standby = computed(() => pinnedFirst(byStatus('idle').filter((a) => !!a.standby)))
const idle = computed(() => [...fresh.value, ...standby.value])

// ---------- fixadas sem janela aberta: continuam na lista depois de fechar o app; o clique reabre a conversa ----------
const pinnedHistory = ref<AgentHistoryItem[]>([])
async function loadPinned() {
  pinnedHistory.value = (await api.agentHistory().catch(() => [])).filter((h) => h.pinned)
}
const closedPinned = computed(() =>
  pinnedHistory.value.filter((h) => !state.agentWindows.includes(h.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)
)
onMounted(loadPinned)
// janela aberta ou fechada, ou conversa fixada/solta por uma janela: a lista de fixadas muda
watch(() => [state.agentWindows.join(','), snaps.value.map((a) => `${a.uid}:${a.pinned ? 1 : 0}`).join(',')], loadPinned)
const reopenError = (e: unknown) => (state.error = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
const reopening = ref<string | null>(null)
async function reopen(h: AgentHistoryItem) {
  if (reopening.value) return
  reopening.value = h.sessionId
  try {
    if (!(await api.agentFocus(h.sessionId))) await api.agentOpen({ provider: h.provider, model: h.model, effort: h.effort, mode: h.mode, cwd: h.cwd, resumeId: h.sessionId })
  } catch (e) {
    reopenError(e)
  } finally {
    reopening.value = null
  }
}
/** Reabre todas as fixadas, uma de cada vez (cada janela acha o seu lugar no grid) */
async function reopenAllPinned() {
  for (const h of [...closedPinned.value]) await reopen(h)
}
async function unpin(h: AgentHistoryItem) {
  await api.agentPin(h.sessionId, false).catch(() => undefined)
  pinnedHistory.value = pinnedHistory.value.filter((x) => x.sessionId !== h.sessionId)
  toast('Conversa solta.')
}
/** Situação gravada da conversa fechada (fechada não trabalha: "rodando" vira interrompida) */
const closedStatus = (h: AgentHistoryItem) => (h.status === 'live' ? 'stopped' : h.status === 'waiting' || h.status === 'done' || h.status === 'error' ? h.status : '')
const CLOSED_LABEL: Record<string, string> = { stopped: 'interrompida ao fechar', waiting: 'aguardando a sua resposta', done: 'concluída', error: 'falhou', '': '' }

// relógio para os "há 3 min" andarem sozinhos
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval>
onMounted(() => (tick = setInterval(() => (now.value = Date.now()), 5_000)))
onUnmounted(() => clearInterval(tick))
const ago = (ms: number) => agoSince(now.value, ms)

/** Rodando sem nenhum sinal do agente há este tempo: fica âmbar e ganha o "Cutucar" */
const STALL_MS = 6 * 60_000
const stalled = (a: AgentSnapshot) => a.status === 'live' && !!a.lastEventAt && now.value - a.lastEventAt >= STALL_MS
const elapsedTitle = (a: AgentSnapshot) => `Trabalhando há ${ago(a.startedAt ?? a.since)}`
/** Agentes ativos (rodando, esperando ou com falha) sobre o total de janelas */
const active = computed(() => snaps.value.filter((a) => a.status === 'live' || a.status === 'waiting' || a.status === 'error').length)

// ---------- concluídos: novo até ser visto; o selecionado aparece aberto ----------
const seenKey = (a: AgentSnapshot) => `${a.uid}:${a.since}`
const isNew = (a: AgentSnapshot) => a.status === 'done' && !state.agentSeen.has(seenKey(a))
function markSeen(a: AgentSnapshot) {
  if (a.status === 'done' && !state.agentSeen.has(seenKey(a))) state.agentSeen = new Set(state.agentSeen).add(seenKey(a))
}
/** Etiquetas do resultado: arquivos, testes, typecheck, build e deploy vistos nos comandos do agente */
function chips(a: AgentSnapshot): { text: string; tone: '' | 'ok' | 'bad' | 'warn' }[] {
  const out: { text: string; tone: '' | 'ok' | 'bad' | 'warn' }[] = []
  const c = a.checks
  if (a.files?.count) out.push({ text: `${a.files.count} ${a.files.count === 1 ? 'arquivo' : 'arquivos'}`, tone: '' })
  if (c?.tests) out.push({ text: `${c.tests.count ? `${c.tests.count} testes` : 'testes'} ${c.tests.ok ? '✓' : '✗'}`, tone: c.tests.ok ? 'ok' : 'bad' })
  // só o que aconteceu de fato: typecheck/build rodados e deploy feito (nada de "não rodado" / "sem deploy")
  if (typeof c?.typecheck === 'boolean') out.push({ text: `typecheck ${c.typecheck ? '✓' : '✗'}`, tone: c.typecheck ? 'ok' : 'bad' })
  if (c?.build !== undefined) out.push({ text: `build ${c.build ? '✓' : '✗'}`, tone: c.build ? 'ok' : 'bad' })
  if (c?.deploy) out.push({ text: 'com deploy', tone: 'warn' })
  return out
}

/** Caminhos que o agente alterou dentro do projeto aberto, relativos à raiz dele (só os que estão na lista de alterações) */
function repoPaths(a: AgentSnapshot): string[] {
  const root = state.repo?.root
  if (!root || !a.paths?.length) return []
  const changed = new Set(state.repo!.files.map((f) => f.path))
  const out: string[] = []
  for (const p of a.paths) {
    const abs = p.startsWith('/') ? p : `${a.cwd.replace(/\/$/, '')}/${p}`
    const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null
    if (rel && changed.has(rel)) out.push(rel)
  }
  return out
}
/** Concluídos cujas alterações ainda estão na lista do projeto aberto */
const withChanges = computed(() => done.value.filter((a) => repoPaths(a).length))
/** Vai para a aba Alterações */
function goToChanges() {
  state.tab = 'changes'
  setPane('changes')
}
/** Fecha as janelas dos concluídos já vistos (a conversa continua em Conversas) */
const reviewed = computed(() => done.value.filter((a) => !isNew(a)))
const archiveReviewed = () => api.agentClose(reviewed.value.map((a) => a.uid)).catch(() => undefined)

// ---------- filtro por situação: os contadores do cabeçalho; de novo no mesmo, ou em "agentes", volta a todos ----------
type StatusFilter = 'all' | AgentSnapshot['status']
const filter = ref<StatusFilter>('all')
const pass = (a: AgentSnapshot) => filter.value === 'all' || a.status === filter.value
function toggleFilter(s: StatusFilter) {
  filter.value = s === 'all' || filter.value === s ? 'all' : s
}
// o grupo filtrado esvaziou (ex.: todas as perguntas respondidas): volta a todos, em vez de uma tela vazia
watch(
  () => filter.value !== 'all' && !snaps.value.some(pass),
  (empty) => empty && (filter.value = 'all')
)
const needYouShown = computed(() => needYou.value.filter(pass))
const runningShown = computed(() => running.value.filter(pass))
const doneShown = computed(() => done.value.filter(pass))
const idleShown = computed(() => idle.value.filter(pass))

// ---------- seleção e teclado: setas navegam, Enter abre, ⌘1–9 traz a janela para a frente ----------
/** Todos, na ordem de prioridade: a conversa nova no topo (é nela que você vai escrever), depois quem precisa de você,
 * rodando, concluídos e, no fim, os agentes em espera. As barrinhas da barra de ferramentas mostram todos, filtrados ou não */
const allOrder = computed(() => [...fresh.value, ...needYou.value, ...running.value, ...done.value, ...standby.value])
/** Os que estão na tela: é sobre esta lista que valem as setas e os atalhos ⌘1–9 */
const order = computed(() => allOrder.value.filter(pass))
const selUid = ref<string | null>(null)
const sel = computed(() => order.value.find((a) => a.uid === selUid.value) ?? null)
const root = ref<HTMLElement>()
function select(a: AgentSnapshot | undefined) {
  if (!a) return
  selUid.value = a.uid
  markSeen(a)
  nextTick(() => root.value?.querySelector(`[data-uid="${a.uid}"]`)?.scrollIntoView({ block: 'nearest' }))
}
function onKey(e: KeyboardEvent) {
  if (state.tab !== 'agents' || planUid.value) return
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const i = order.value.findIndex((a) => a.uid === selUid.value)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    select(order.value[Math.min(order.value.length - 1, i + 1)])
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    select(order.value[Math.max(0, i - 1)])
  } else if (e.key === 'Enter' && sel.value) {
    e.preventDefault()
    show(sel.value)
  } else if (e.key === 'Escape') selUid.value = null
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
// ⌘1…⌘9 (menu do app): a conversa do cartão N, mesmo com o foco dentro da conversa embutida
watch(
  () => state.agentPick,
  (pick) => {
    const a = pick && order.value[pick.n - 1]
    if (!a) return
    select(a)
    show(a)
  },
  { immediate: true }
)
// o selecionado fechou: tira a seleção
watch(order, (l) => selUid.value && !l.some((a) => a.uid === selUid.value) && (selUid.value = null))

/** Catálogo de modelos, para o composer dos cartões */
const known = ref<KnownModels | null>(null)
onMounted(() => api.knownModels().then((k) => (known.value = k)).catch(() => undefined))
function act(a: AgentSnapshot, action: AgentAction) {
  api.agentAct(a.uid, action).catch(() => undefined)
}
function show(a: AgentSnapshot) {
  markSeen(a)
  api.agentShow(a.uid).catch(() => undefined)
}

/** Plano aberto para leitura: o da janela `uid` (acompanha o resumo; some se o cartão deixar de esperar) */
const planUid = ref<string | null>(null)
const planOf = computed(() => {
  const a = snaps.value.find((x) => x.uid === planUid.value)
  return a?.ask?.kind === 'plan' ? { a, ask: a.ask } : null
})
const planHtml = computed(() => (planOf.value ? DOMPurify.sanitize(marked.parse(planOf.value.ask.plan, { async: false, gfm: true })) : ''))
function implement(mode: AgentMode) {
  const p = planOf.value
  planUid.value = null
  if (p) act(p.a, { type: 'plan', mode })
}

/** Repositórios da conversa: o nome do grupo salvo, quando é um; senão o principal e quantos foram juntados */
const workspaceLabel = (h: { cwd: string; project: string; extraDirs?: string[] }) =>
  groupOf(state.settings?.repoGroups ?? [], h.cwd, h.extraDirs)?.name ?? `${h.project}${h.extraDirs?.length ? ` +${h.extraDirs.length}` : ''}`

// ---------- modo orquestrador: cartões à esquerda, a conversa do agente escolhido à direita ----------
/**
 * A conversa é a própria janela do agente, presa dentro desta pela janela principal (processo principal). Daqui vai
 * só onde a área fica: a cada mudança de tamanho ou posição, e quando um diálogo cobre a tela (aí a área some, para
 * a janela presa não ficar por cima do diálogo).
 */
/** Tarefas esperando na fila (selo no botão) */
const queuedCount = computed(() => state.queue.filter((t) => t.status === 'queued' || t.status === 'running').length)
/** Conversa mostrada na área agora */
const docked = computed(() => snaps.value.find((a) => a.docked) ?? null)
const dockEl = ref<HTMLElement>()
const dockWidth = ref(Number(localStorage.getItem('ovseer.dock') ?? 620))
function startDockResize(e: MouseEvent) {
  const startX = e.clientX
  const start = dockWidth.value
  const move = (ev: MouseEvent) => {
    dockWidth.value = Math.min(Math.max(start - (ev.clientX - startX), 380), window.innerWidth - 320)
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    localStorage.setItem('ovseer.dock', String(dockWidth.value))
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
type Box = { x: number; y: number; width: number; height: number }
/**
 * Algo por cima da área (diálogo, menu aberto, balão): a janela presa, que fica sempre por cima da página,
 * cobriria isso. Amostra pontos da área e vê se o elemento no topo de cada um pertence a ela.
 */
function covered(el: HTMLElement, r: DOMRect): boolean {
  if (document.querySelector('.backdrop, .overlay-backdrop')) return true
  const step = 56
  for (let y = r.top + 6; y < r.bottom; y += step) {
    for (let x = r.left + 8; x < r.right; x += step) {
      const top = document.elementFromPoint(Math.min(x, r.right - 4), Math.min(y, r.bottom - 4))
      if (top && !el.contains(top)) return true
    }
  }
  return false
}
/*
 * Coberta, a conversa não some nem se recorta: o processo principal tira uma foto da vista, a foto entra no quadro
 * no mesmo lugar, e só então a vista se esconde. O menu ou diálogo aparece por cima da foto, onde sempre apareceu.
 * Descoberta, a vista volta e a foto sai um instante depois, para não piscar.
 */
const frozen = ref<string | null>(null)
let wantFrozen = false
let freezing = false
let unfreezeTimer: ReturnType<typeof setTimeout> | undefined
async function freeze() {
  wantFrozen = true
  clearTimeout(unfreezeTimer)
  if (frozen.value || freezing) return
  freezing = true
  try {
    const snap = await api.dockSnapshot().catch(() => null)
    // o que cobria já saiu enquanto a foto era tirada: fica tudo como está
    if (!wantFrozen) return
    frozen.value = snap
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    if (wantFrozen) api.orchestratorArea(null)
  } finally {
    freezing = false
  }
}
function unfreeze(rect: Box) {
  wantFrozen = false
  api.orchestratorArea(rect)
  clearTimeout(unfreezeTimer)
  unfreezeTimer = setTimeout(() => (frozen.value = null), 80)
}
let areaRaf = 0
function reportArea() {
  cancelAnimationFrame(areaRaf)
  areaRaf = requestAnimationFrame(() => {
    const el = dockEl.value
    if (!el) return api.orchestratorArea(null)
    const r = el.getBoundingClientRect()
    if (covered(el, r)) return void freeze()
    unfreeze({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })
  })
}
let sizeObs: ResizeObserver | undefined
let domObs: MutationObserver | undefined
watch(dockEl, (el) => {
  sizeObs?.disconnect()
  sizeObs = undefined
  if (el) {
    sizeObs = new ResizeObserver(reportArea)
    sizeObs.observe(el)
  }
  reportArea()
})
// a largura da área encaixada vira uma variável CSS da página: os avisos (toast) se mantêm fora dela
watch(
  () => (state.showDock ? dockWidth.value : 0),
  (w) => document.documentElement.style.setProperty('--dock-w', `${w}px`),
  { immediate: true }
)
onMounted(() => {
  window.addEventListener('resize', reportArea)
  // diálogos abrem e fecham, barras aparecem: a área muda de lugar ou precisa sumir
  domObs = new MutationObserver(reportArea)
  domObs.observe(document.body, { childList: true, subtree: true })
})
onUnmounted(() => {
  document.documentElement.style.removeProperty('--dock-w')
  window.removeEventListener('resize', reportArea)
  domObs?.disconnect()
  sizeObs?.disconnect()
  cancelAnimationFrame(areaRaf)
  api.orchestratorArea(null)
})
/** Número do atalho do cartão (⌘1–9), pela posição na lista */
function numberOf(a: AgentSnapshot): number | null {
  const i = order.value.indexOf(a)
  return i >= 0 && i < 9 ? i + 1 : null
}
/** Clique no cartão: a conversa vai para a área ao lado (escondida, volta a aparecer) */
function pick(a: AgentSnapshot) {
  select(a)
  if (!state.showDock) setShowDock(true)
  show(a)
}
</script>

<template>
  <div ref="root" class="agents orch">
    <div class="toolbar">
      <button class="primary new-agent" :disabled="!state.repo" title="Novo agente de IA neste projeto (⌘⇧N)" @click="openNewAgent()"><Icon name="plus" :size="14" /> Novo agente</button>
      <button class="ghost tool" :disabled="!state.repo" title="Agente em espera: nasce pronto, sem conversa, e pega tarefas da fila" @click="state.showStandby = true"><Icon name="hourglass" :size="14" /><span class="lbl">Em espera</span></button>
      <button class="ghost tool" :class="{ on: state.showQueue }" title="Fila de tarefas para os agentes em espera" @click="state.showQueue = !state.showQueue">
        <Icon name="listTodo" :size="14" /><span class="lbl">Fila</span><span v-if="queuedCount" class="cnt">{{ queuedCount }}</span>
      </button>
      <span class="gap" />
    </div>

    <div class="body">
    <!-- a fila de tarefas é uma coluna própria, antes dos cartões -->
    <aside v-if="state.showQueue" class="queue-col">
      <QueuePanel @standby="state.showStandby = true" />
    </aside>
    <div class="scroll">
      <!-- os contadores filtram a lista por situação; "agentes" (ou o filtro de novo) mostra todos -->
      <header class="head" :class="{ filtered: filter !== 'all' }">
        <button class="ghost all" :title="filter === 'all' ? 'Todos os agentes' : 'Mostrar todos'" @click="toggleFilter('all')"><strong>{{ snaps.length }} {{ snaps.length === 1 ? 'agente' : 'agentes' }}</strong></button>
        <button v-if="byStatus('waiting').length" class="ghost count" :class="{ on: filter === 'waiting' }" :title="filter === 'waiting' ? 'Mostrar todos' : 'Só os que aguardam você'" @click="toggleFilter('waiting')"><span class="dot waiting" />{{ byStatus('waiting').length }} aguardando</button>
        <button v-if="byStatus('error').length" class="ghost count" :class="{ on: filter === 'error' }" :title="filter === 'error' ? 'Mostrar todos' : 'Só os que falharam'" @click="toggleFilter('error')"><span class="dot error" />{{ byStatus('error').length }} falhou</button>
        <button v-if="running.length" class="ghost count" :class="{ on: filter === 'live' }" :title="filter === 'live' ? 'Mostrar todos' : 'Só os que estão rodando'" @click="toggleFilter('live')"><span class="dot live" />{{ running.length }} rodando</button>
        <button v-if="done.length" class="ghost count" :class="{ on: filter === 'done' }" :title="filter === 'done' ? 'Mostrar todos' : 'Só os concluídos'" @click="toggleFilter('done')"><span class="dot done" />{{ done.length }} {{ done.length === 1 ? 'concluído' : 'concluídos' }}</button>
        <span class="gap" />
        <span v-if="snaps.length" class="slots" :title="`${active} de ${snaps.length} agentes ativos (rodando, esperando ou com falha)`">
          <span class="faint">{{ active }}/{{ snaps.length }} ativos</span>
          <span class="bars"><span v-for="a in allOrder.slice(0, 12)" :key="a.uid" :class="a.status" :title="a.title" /></span>
        </span>
      </header>

      <div v-if="!snaps.length" class="empty" :class="{ slim: closedPinned.length }">
        <p class="faint">Nenhum agente aberto.</p>
        <button class="primary" :disabled="!state.repo" @click="openNewAgent()"><Icon name="squarePen" :size="14" /> Novo agente</button>
      </div>

      <!-- modo orquestrador: uma lista só, na ordem de prioridade (precisa de você, rodando, concluídos, sem conversa).
           Quem espera resposta só avisa no cartão: a resposta é dada na conversa, ao lado -->
      <section v-if="order.length" class="orch-list">
        <div class="list">
          <AgentCard v-for="a in order" :key="a.uid" :a="a" :n="numberOf(a)" :now="now" :selected="selUid === a.uid || !!a.docked" :fresh="isNew(a)" :stalled="stalled(a)" @pick="pick(a)" @act="(action) => act(a, action)" />
        </div>
      </section>

      <section v-if="closedPinned.length">
        <h3 class="sec">
          <span class="sec-title"><Icon name="pin" :size="11" /> Fixadas</span>
          <span class="sec-actions">
            <button v-if="closedPinned.length > 1" class="ghost link accent" title="Reabre todas as conversas fixadas, cada uma na sua janela" @click="reopenAllPinned">Abrir as {{ closedPinned.length }} →</button>
          </span>
        </h3>
        <div class="list">
        <div v-for="h in closedPinned" :key="h.sessionId" class="item closed" :title="'Reabrir a conversa'" @click="reopen(h)">
          <span class="dot" :class="closedStatus(h) === 'stopped' ? '' : closedStatus(h)" />
          <span class="text">
            <strong class="ellipsis light">{{ h.title }}</strong>
            <small class="faint ellipsis">{{ workspaceLabel(h) }} · {{ h.model }}{{ CLOSED_LABEL[closedStatus(h)] ? ` · ${CLOSED_LABEL[closedStatus(h)]}` : '' }}</small>
          </span>
          <span v-if="reopening === h.sessionId" class="spinner" />
          <small class="faint when">{{ ago(h.updatedAt) }}</small>
          <button class="ghost icon small pin pinned" title="Soltar a conversa (sai desta lista; continua em Conversas)" @click.stop="unpin(h)"><Icon name="pin" :size="13" /></button>
          <Icon name="external" :size="13" class="go" />
        </div>
        </div>
      </section>
    </div>

    <!-- a área da conversa: a janela do agente escolhido fica presa por cima dela (processo principal).
         Escondida (botão do painel na barra do topo), os cartões ocupam a largura toda -->
    <template v-if="state.showDock">
      <div class="dock-resizer" @mousedown.prevent="startDockResize" />
      <div class="dock" :style="{ width: `${dockWidth}px` }">
        <!-- a janela presa cobre exatamente esta área -->
        <div ref="dockEl" class="dock-area">
          <!-- a foto da conversa, enquanto algo cobre a área (a vista fica escondida por baixo do que cobre) -->
          <img v-if="frozen" :src="frozen" class="dock-frozen" alt="" />
          <div v-if="docked" class="dock-under">
            <span class="dot" :class="docked.status" />
            <strong class="ellipsis">{{ docked.title }}</strong>
          </div>
          <div v-else class="dock-empty">
            <Icon name="bot" :size="28" />
            <p>{{ snaps.length ? 'Escolha um agente nos cartões: a conversa aparece aqui.' : 'Nenhum agente aberto.' }}</p>
            <button class="primary" :disabled="!state.repo" @click="openNewAgent()"><Icon name="squarePen" :size="14" /> Novo agente</button>
          </div>
        </div>
      </div>
    </template>
    </div>

    <Modal v-if="planOf" :title="planOf.a.title" :width="760" @close="planUid = null">
      <div class="md" v-html="planHtml" />
      <template #footer>
        <button type="button" class="ghost" @click="planUid = null">Fechar</button>
        <button v-if="planOf.ask.options[0]" type="button" class="primary" @click="implement(planOf.ask.options[0].mode)">{{ planOf.ask.options[0].label }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.agents { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }
.body { flex: 1; display: flex; min-height: 0; min-width: 0; }
.queue-col { flex: none; width: 340px; min-width: 0; overflow: hidden auto; border-right: 1px solid var(--border); background: var(--panel); }
.toolbar { gap: 10px; }
.orch-btn { height: 26px; padding: 0 8px; gap: 6px; font-size: 12px; color: var(--muted); }
.new-agent { height: 28px; gap: 6px; font-size: 12.5px; }
.tool { height: 26px; padding: 0 8px; gap: 6px; font-size: 12px; color: var(--muted); }
.tool.on { color: var(--accent); background: var(--accent-soft); }
.tool .cnt { min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: var(--accent); color: var(--on-accent); font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.orch-btn.on { color: var(--accent); background: var(--accent-soft); }
/* modo orquestrador: a conversa do agente escolhido fica à direita, numa área redimensionável */
.dock { flex: none; min-width: 0; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border); }
/* o fundo imita a janela presa (cabeçalho em cima, corpo embaixo): os cantos arredondados dela ficam invisíveis */
.dock-area { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: linear-gradient(var(--panel) 0 var(--titlebar), var(--bg) var(--titlebar)); }
.dock-frozen { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; display: block; }
.dock-resizer { width: 5px; margin: 0 -2px; cursor: col-resize; position: relative; z-index: 2; flex: none; }
.dock-resizer::after { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 1px; background: var(--border); }
.dock-resizer:hover::after { background: var(--accent); width: 2px; left: 1.5px; }
/* por baixo da janela presa: só aparece se ela estiver escondida por um instante (ex.: com um diálogo aberto) */
.dock-under { display: flex; align-items: center; gap: 8px; padding: 14px 16px; font-size: 13px; color: var(--muted); min-width: 0; }
.dock-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; color: var(--faint); text-align: center; }
.dock-empty p { margin: 0; font-size: 13px; color: var(--muted); max-width: 280px; }
.dock-empty button { gap: 6px; }
/* cartões: quantas colunas couberem na largura da lista; os que esperam resposta ocupam a linha inteira */
.orch .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; align-items: stretch; }
.orch-list { margin-top: 14px; }
/* fixadas sem janela: cartão simples, no mesmo espírito */
.orch .item.closed { flex-wrap: wrap; align-items: flex-start; margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); }
.orch .item.closed > .dot { margin-top: 6px; }
.orch .item.closed > .text { flex: 1 1 calc(100% - 20px); min-width: 0; }
.orch .item.closed > .when { margin-right: auto; min-width: 0; text-align: left; }
/* a segunda linha (tempo, alfinete e abrir) se alinha pelo meio: o alinhamento pelo topo é só para a bolinha da primeira */
.orch .item.closed > .when, .orch .item.closed > .pin, .orch .item.closed > .go, .orch .item.closed > .spinner { align-self: center; }
.orch .item.closed > .go { display: block; margin: 0 5px; }
.toolbar { display: flex; align-items: center; flex: none; box-sizing: border-box; height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border); }
.scroll { flex: 1; overflow: auto; padding: 0 16px 24px; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.head strong { font-size: 14px; }
/* contadores como filtros: pílulas discretas; a ativa fica marcada e as outras apagam um pouco */
.head .all, .head .count { height: 26px; padding: 0 9px; margin: 0 -5px; border-radius: 999px; color: var(--muted); font-size: 13px; }
.head .all { color: var(--text); }
.count { display: inline-flex; align-items: center; gap: 6px; }
.count.on { background: var(--accent-soft); color: var(--text); }
.head.filtered .count:not(.on) { opacity: 0.55; }
.head.filtered .count:not(.on):hover { opacity: 1; }
.gap { flex: 1; }
.head button { height: 28px; gap: 6px; font-size: 12.5px; }
/* Organizar dividido: a ação à esquerda, a seta abre o grid */
.arrange { position: relative; display: inline-flex; flex: none; }
.arrange-main { border-radius: var(--radius) 0 0 var(--radius); }
.arrange-more { width: 24px; padding: 0; border-radius: 0 var(--radius) var(--radius) 0; border-left: 0; }
.arrange.on .arrange-more { background: var(--hover); }
.arrange .chev { transform: rotate(90deg); }
.arrange .pop {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 320px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
}
.where { height: 22px; max-width: 150px; padding: 0 4px; font-size: 11px; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.where:hover, .where:focus { border-color: var(--border); color: var(--text); }
.all { margin-top: 6px; padding: 8px 4px 2px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
.all h6 { margin: 0 0 4px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.all-row { display: flex; gap: 4px; }
.all-row button { flex: 1; justify-content: flex-start; height: 28px; padding: 0 8px; gap: 6px; font-size: 12px; color: var(--text); }
.all-row button.cur { background: var(--accent-soft); }
.all-row button .ok { color: var(--accent); margin-left: auto; }
.all-row button.bad:hover:not(:disabled) { color: var(--del); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 12px; margin: 48px 0 0; }
.empty p { margin: 0; font-size: 13px; }
.empty.slim { margin: 24px 0 8px; }
.sec-title { display: inline-flex; align-items: center; gap: 6px; }
.empty button { gap: 6px; }

.sec { display: flex; align-items: baseline; justify-content: space-between; margin: 18px 0 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.sec small { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; }
.sec.waiting { color: var(--mod); }
.sec.live { color: var(--accent); }
.sec.done { color: var(--add); }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); opacity: 0.5; }
.dot.live { background: var(--accent); opacity: 1; box-shadow: 0 0 0 3px var(--accent-soft); animation: pulse 1.4s ease-in-out infinite; }
.dot.waiting { background: var(--mod); opacity: 1; }
.dot.done { background: var(--add); opacity: 1; }
.dot.error { background: var(--del); opacity: 1; }
@keyframes pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } }

.card { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
.card.waiting { border-color: color-mix(in srgb, var(--mod) 40%, var(--border)); background: color-mix(in srgb, var(--mod) 5%, var(--panel)); }
.card.error { border-color: color-mix(in srgb, var(--del) 40%, var(--border)); background: color-mix(in srgb, var(--del) 6%, var(--panel)); }
.row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
/* o título tem prioridade: fica inteiro até 70% da linha; o que o agente está fazendo usa o resto */
.line { display: grid; grid-template-columns: fit-content(70%) minmax(0, 1fr); align-items: baseline; gap: 8px; min-width: 0; }
.line > * { min-width: 0; }
/* a etiqueta "novo" não estica na célula (os textos esticam, para o ellipsis valer) */
.line > .new { justify-self: start; }
.line > :only-child { grid-column: 1 / -1; }
.line strong, .item strong { font-size: 13.5px; }
.text small { font-size: 12px; }
.err { color: var(--del); }
.wait { color: var(--mod); font-size: 12px; white-space: nowrap; }
.retry { height: 26px; }

.opt small { font-size: 12px; min-width: 0; }
/* o cartão do agente, sem a moldura dele: a moldura é a do cartão do gerenciador */
.card .ask-in { width: 100%; max-width: none; box-sizing: border-box; padding: 0; border: 0; background: transparent; }
.link { height: auto; padding: 0; color: var(--muted); font-size: 12.5px; }
.link:hover:not(:disabled) { background: transparent; color: var(--accent); }

.item { display: flex; align-items: center; gap: 12px; padding: 9px 8px; border-radius: 8px; cursor: pointer; min-width: 0; }
.item.sel, .card.sel { box-shadow: 0 0 0 1px var(--accent); }
.item.stalled { background: color-mix(in srgb, var(--mod) 7%, var(--panel)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mod) 35%, var(--border)); }
.warn { color: var(--mod); }
/* checklist do plano: itens compactos; o da vez em destaque, os abertos no concluído ficam âmbar */
.cl { list-style: none; margin: 6px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.cl li { display: flex; align-items: center; gap: 8px; min-height: 18px; font-size: 12px; color: var(--muted); min-width: 0; }
.cl li.done { color: var(--faint); }
.cl li.now { color: var(--text); font-weight: 600; }
.cl li.open { color: var(--mod); }
/* marcador redondo, do mesmo tamanho nos três estados, para o texto ficar numa coluna só */
.cl-box { display: inline-grid; place-items: center; width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--faint) 70%, transparent); flex: none; color: var(--bg); }
.cl li.done .cl-box { background: var(--add); border-color: var(--add); }
.cl li.now .cl-box { border-color: var(--hunk); }
.cl li.open .cl-box { border-color: var(--mod); }
/* dispensada: encerrada sem ter sido feita */
.cl li.skipped { color: var(--faint); }
.cl li.skipped .cl-box { border-style: dashed; }
/* item em andamento: o mesmo arco girando do indicador da linha, em tamanho de marcador */
.cl-spin { width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%; flex: none; border: 2px solid color-mix(in srgb, var(--hunk) 25%, transparent); border-top-color: var(--hunk); border-right-color: var(--hunk); animation: turn 0.9s linear infinite; }
@media (prefers-reduced-motion: reduce) { .cl-spin { animation: none; } }
/* linha com checklist: ponto, contador, indicador e hora ficam na altura do título, não no meio do bloco */
.item.has-cl { align-items: flex-start; }
.item.has-cl > .dot { margin-top: 6px; }
.item.has-cl > .cl-pill { margin-top: -1px; }
.item.has-cl > .ring { margin-top: 3px; }
.item.has-cl > .when, .item.has-cl > .go, .item.has-cl > .pin, .item.has-cl > .win-menu, .item.has-cl > .nudge { margin-top: 2px; }
.card-cl { margin: 0 0 4px 18px; }
.cl-pill { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--hunk); background: color-mix(in srgb, var(--hunk) 14%, transparent); flex: none; }
/* anel de atividade: dois quartos girando enquanto há sinal do agente; sem saída, para e fica âmbar */
.ring {
  width: 14px; height: 14px; border-radius: 50%; flex: none; box-sizing: border-box;
  border: 2.5px solid color-mix(in srgb, var(--faint) 30%, transparent);
  border-top-color: var(--accent); border-right-color: var(--accent);
  animation: turn 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  animation-delay: calc(var(--i, 0) * -0.4s);
}
.ring.stalled { border-color: color-mix(in srgb, var(--mod) 25%, transparent); border-top-color: var(--mod); border-right-color: var(--mod); animation: none; }
@keyframes turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
.nudge { height: 26px; color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); background: color-mix(in srgb, var(--mod) 10%, transparent); }
.slots { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; }
.bars { display: inline-flex; gap: 3px; }
.bars span { width: 12px; height: 4px; border-radius: 2px; background: var(--panel-2); }
/* um traço por agente, na cor da situação dele (mesma ordem da lista) */
.bars span.waiting { background: var(--mod); }
.bars span.error { background: var(--del); }
.bars span.live { background: var(--accent); }
.bars span.done { background: var(--add); }
.bars span.idle { background: color-mix(in srgb, var(--faint) 45%, var(--panel-2)); }
.sec-actions { display: inline-flex; gap: 14px; text-transform: none; letter-spacing: 0; font-weight: 400; }
.link.accent { color: var(--accent); }
.new { flex: none; font-size: 10.5px; padding: 0 6px; border-radius: 5px; color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.dot.seen { opacity: 0.55; }
strong.light { font-weight: 500; }
.grow { flex: 1; font-size: 13.5px; }
.done-open { gap: 10px; }
.result { margin: 0 0 0 18px; font-size: 13px; line-height: 1.5; color: var(--text); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-left: 18px; }
.chip { font-size: 11.5px; padding: 2px 8px; border-radius: 6px; background: var(--panel-2); color: var(--muted); }
.chip.ok { color: var(--add); background: color-mix(in srgb, var(--add) 12%, transparent); }
.chip.bad { color: var(--del); background: color-mix(in srgb, var(--del) 12%, transparent); }
.chip.warn { color: var(--mod); background: color-mix(in srgb, var(--mod) 12%, transparent); }
.next { margin-left: 18px; }
.next .small { height: 30px; flex: none; }
.go-btn { color: var(--faint); }
.item:hover { background: var(--hover); }
.when { font-size: 12px; white-space: nowrap; min-width: 40px; text-align: right; }
.stats { display: flex; gap: 8px; font-size: 12px; }
.stats .add { color: var(--add); }
.stats .del { color: var(--del); }
/* alfinete: só aparece ao passar o mouse, ou sempre quando a conversa está fixada */
.pin { opacity: 0; color: var(--faint); flex: none; }
.item:hover .pin, .row:hover .pin, .pin.pinned { opacity: 1; }
.item:hover :deep(.win-btn), .row:hover :deep(.win-btn) { opacity: 1; }
.pin.pinned { color: var(--accent); }
.go { color: var(--faint); flex: none; }
.item:hover .go { color: var(--text); }
/* plano em Markdown */
.md { user-select: text; line-height: 1.6; font-size: 14px; min-width: 0; overflow-wrap: anywhere; }
.md :deep(p) { margin: 0 0 10px; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 10px; padding-left: 22px; }
.md :deep(li) { margin: 3px 0; }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { margin: 12px 0 6px; font-size: 15px; }
.md :deep(h1:first-child) { margin-top: 0; }
.md :deep(code) { font-family: var(--mono); font-size: 12.5px; background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.md :deep(pre) { margin: 0 0 10px; padding: 10px 12px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--border); white-space: pre-wrap; }
.md :deep(pre code) { background: transparent; padding: 0; }
.md :deep(a) { color: var(--accent); }
.md :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 10px; font-size: 13px; }
.md :deep(td), .md :deep(th) { border: 1px solid var(--border); padding: 4px 8px; }
.md :deep(blockquote) { margin: 0 0 10px; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
</style>
