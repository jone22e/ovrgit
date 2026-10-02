<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { AgentAction, AgentMode, AgentSnapshot, GridCell, GridSize, KnownModels } from '@shared/types'
import { api, openNewAgent, saveSettings, setPane, state, toast } from '../store'
import { PROVIDER_LABEL } from '@shared/models'
import { clampGrid, fitGrid, gridLimitsFor, normalizeGrid } from '@shared/grid'
import AskCard from './AskCard.vue'
import Icon from './Icon.vue'
import MiniComposer from './MiniComposer.vue'
import Modal from './Modal.vue'
import PaneSwitch from './PaneSwitch.vue'
import WindowGrid from './WindowGrid.vue'

/**
 * Gerenciador de agentes: todas as janelas de agente abertas (de qualquer projeto), agrupadas pelo que precisam.
 * Perguntas e a aprovação do plano são respondidas daqui mesmo; a ação vai para a janela do agente, que executa.
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
const idle = computed(() => pinnedFirst(byStatus('idle')))

// relógio para os "há 3 min" andarem sozinhos
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval>
onMounted(() => (tick = setInterval(() => (now.value = Date.now()), 5_000)))
onUnmounted(() => clearInterval(tick))
function ago(ms: number) {
  const s = Math.max(0, Math.round((now.value - ms) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

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
/** Vai para Alterações com os arquivos destes agentes marcados (e o diff do primeiro aberto) */
function goToChanges(list: AgentSnapshot[]) {
  const paths = [...new Set(list.flatMap(repoPaths))]
  if (!paths.length) return toast('As alterações desses agentes não estão mais na lista.')
  list.forEach(markSeen)
  state.tab = 'changes'
  setPane('changes')
  state.selected = new Set(paths)
}
/** Fecha as janelas dos concluídos já vistos (a conversa continua em Conversas) */
const reviewed = computed(() => done.value.filter((a) => !isNew(a)))
const archiveReviewed = () => api.agentClose(reviewed.value.map((a) => a.uid)).catch(() => undefined)

// ---------- seleção e teclado: setas navegam, Enter abre, ⌘1–9 traz a janela para a frente ----------
const order = computed(() => [...needYou.value, ...running.value, ...done.value, ...idle.value])
const selUid = ref<string | null>(null)
const sel = computed(() => order.value.find((a) => a.uid === selUid.value) ?? null)
const root = ref<HTMLElement>()
function select(a: AgentSnapshot | undefined) {
  if (!a) return
  selUid.value = a.uid
  markSeen(a)
  nextTick(() => root.value?.querySelector(`[data-uid="${a.uid}"]`)?.scrollIntoView({ block: 'nearest' }))
}
/** Clique num concluído: abre (ou fecha) o resumo; nos outros, traz a janela */
function clickDone(a: AgentSnapshot) {
  if (selUid.value === a.uid) selUid.value = null
  else select(a)
}
function onKey(e: KeyboardEvent) {
  if (state.tab !== 'agents' || planUid.value) return
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    const a = order.value[Number(e.key) - 1]
    if (a) {
      e.preventDefault()
      select(a)
      show(a)
    }
    return
  }
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

const arranging = ref(false)
async function arrange() {
  arranging.value = true
  await api.agentArrange().catch(() => undefined)
  arranging.value = false
  if (gridOpen.value) gridCells.value = await api.agentGridCells('', { ...shownGrid.value }).catch(() => [])
}

// ---------- grid das janelas (colunas × linhas), no dropdown do Organizar ----------
const gridOpen = ref(false)
const gridRoot = ref<HTMLElement>()
const gridSize = computed(() => normalizeGrid(state.settings?.agentGrid))
const screenArea = () => ({ width: window.screen.availWidth, height: window.screen.availHeight })
const gridLimits = ref<GridSize>(gridLimitsFor(screenArea()))
const shownGrid = computed(() => clampGrid(gridSize.value, gridLimits.value))
const gridCells = ref<GridCell[]>([])
watch(gridOpen, async (open) => {
  if (!open) return
  gridLimits.value = gridLimitsFor(screenArea())
  gridCells.value = await api.agentGridCells('', { ...shownGrid.value }).catch(() => [])
})
async function setGridSize(s: GridSize) {
  const from = shownGrid.value
  const to = fitGrid(s, screenArea())
  if (to.cols === from.cols && to.rows === from.rows) return
  await saveSettings({ agentGrid: to })
  // as janelas desta tela acompanham o grid novo
  await api.agentRegrid('', { ...from }, { ...to }).catch(() => undefined)
  gridCells.value = await api.agentGridCells('', { ...to }).catch(() => [])
}
const onDocGrid = (e: MouseEvent) => {
  if (gridOpen.value && gridRoot.value && !gridRoot.value.contains(e.target as Node)) gridOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocGrid))
onUnmounted(() => document.removeEventListener('mousedown', onDocGrid))
</script>

<template>
  <div ref="root" class="agents">
    <div class="toolbar">
      <PaneSwitch />
    </div>

    <div class="scroll">
      <header class="head">
        <strong>{{ snaps.length }} {{ snaps.length === 1 ? 'janela' : 'janelas' }}</strong>
        <span v-if="byStatus('waiting').length" class="count"><span class="dot waiting" />{{ byStatus('waiting').length }} aguardando</span>
        <span v-if="byStatus('error').length" class="count"><span class="dot error" />{{ byStatus('error').length }} falhou</span>
        <span v-if="running.length" class="count"><span class="dot live" />{{ running.length }} rodando</span>
        <span v-if="done.length" class="count"><span class="dot done" />{{ done.length }} {{ done.length === 1 ? 'concluído' : 'concluídos' }}</span>
        <span class="gap" />
        <span v-if="snaps.length" class="slots" :title="`${active} de ${snaps.length} agentes ativos (rodando, esperando ou com falha)`">
          <span class="faint">{{ active }}/{{ snaps.length }} ativos</span>
          <span class="bars"><span v-for="a in order.slice(0, 12)" :key="a.uid" :class="a.status" :title="a.title" /></span>
        </span>
        <span ref="gridRoot" class="arrange" :class="{ on: gridOpen }">
          <button class="arrange-main" :disabled="!snaps.length || arranging" title="Coloca as janelas de agente no grid de cada tela, lado a lado" @click="arrange">
            <span v-if="arranging" class="spinner" />
            <Icon v-else name="grid" :size="13" />
            Organizar
          </button>
          <button class="arrange-more" title="Colunas × linhas do grid" @click="gridOpen = !gridOpen"><Icon name="chevron" :size="11" class="chev" /></button>
          <div v-if="gridOpen" class="pop">
            <WindowGrid :model-value="shownGrid" :cells="gridCells" :limits="gridLimits" manage @update:model-value="setGridSize" />
          </div>
        </span>
      </header>

      <div v-if="!snaps.length" class="empty">
        <p class="faint">Nenhum agente aberto.</p>
        <button class="primary" :disabled="!state.repo" @click="openNewAgent()"><Icon name="squarePen" :size="14" /> Novo agente</button>
      </div>

      <!-- precisa de você: perguntas, aprovação do plano, falhas -->
      <section v-if="needYou.length">
        <h3 class="sec waiting">Precisa de você</h3>
        <article v-for="a in needYou" :key="a.uid" :data-uid="a.uid" class="card" :class="[a.status, { sel: selUid === a.uid }]">
          <div class="row">
            <span class="dot" :class="a.status" />
            <span class="text">
              <span class="line">
                <strong class="ellipsis">{{ a.title }}</strong>
                <small class="faint ellipsis">{{ a.project }} · {{ a.model }}</small>
              </span>
              <small v-if="a.status === 'error'" class="err ellipsis" :title="a.error">
                {{ a.lastUser ? `Interrompido durante "${a.lastUser}"` : (a.error ?? 'Falhou') }}
              </small>
            </span>
            <small v-if="a.status === 'waiting'" class="wait">esperando há {{ ago(a.since) }}</small>
            <button v-if="a.status === 'error'" class="small retry" title="Continua a tarefa de onde parou" @click="act(a, { type: 'retry' })">Retomar</button>
            <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="act(a, { type: 'pin' })"><Icon name="pin" :size="13" /></button>
            <button class="ghost icon small" title="Abrir a janela" @click="show(a)"><Icon name="external" :size="13" /></button>
          </div>

          <AskCard
            v-if="a.ask"
            class="ask-in"
            :ask="a.ask"
            :agent="PROVIDER_LABEL[a.provider]"
            :current="a.ask.kind === 'question' ? a.ask.current : null"
            @decide="(choice) => act(a, { type: 'decide', choice })"
            @plan="(mode) => act(a, { type: 'plan', mode })"
            @adjust="(text) => act(a, { type: 'reply', text })"
            @see-plan="planUid = a.uid"
            @close="act(a, { type: 'dismiss' })"
            @nav="(index) => act(a, { type: 'nav', index })"
          />
        </article>
      </section>

      <section v-if="running.length">
        <h3 class="sec live">Rodando</h3>
        <div v-for="(a, i) in running" :key="a.uid" :data-uid="a.uid" class="item run" :style="{ '--i': i }" :class="{ stalled: stalled(a), sel: selUid === a.uid }" @click="show(a)">
          <span class="dot" :class="stalled(a) ? 'waiting' : 'live'" />
          <span class="text">
            <span class="line">
              <strong class="ellipsis">{{ a.title }}</strong>
              <small v-if="stalled(a)" class="warn ellipsis">sem saída há {{ ago(a.lastEventAt!) }}{{ a.lastTool ? ` · último: ${a.lastTool}` : '' }}</small>
              <small v-else class="faint ellipsis">{{ a.activity || 'Trabalhando…' }}</small>
            </span>
            <ol v-if="a.checklist?.length" class="cl" @click.stop>
              <li v-for="(it, n) in a.checklist" :key="n" :class="{ done: it.done, next: !it.done && a.checklist.slice(0, n).every((x) => x.done) }">
                <span class="cl-box"><Icon v-if="it.done" name="check" :size="10" /></span><span class="ellipsis">{{ it.text }}</span>
              </li>
            </ol>
          </span>
          <span v-if="a.checklist?.length" class="cl-pill" :title="`Checklist: ${a.checklist.filter((i) => i.done).length} de ${a.checklist.length} itens concluídos`">
            <Icon name="listChecks" :size="11" /> {{ a.checklist.filter((i) => i.done).length }}/{{ a.checklist.length }}
          </span>
          <span class="ring" :class="{ stalled: stalled(a) }" :title="elapsedTitle(a)" />
          <small class="faint when">{{ ago(a.startedAt ?? a.since) }}</small>
          <button v-if="stalled(a)" class="small nudge" title="Avisa o agente de que há pressa (o mesmo do Acelerar)" @click.stop="act(a, { type: 'nudge' })">Cutucar</button>
          <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="act(a, { type: 'pin' })"><Icon name="pin" :size="13" /></button>
          <Icon name="external" :size="13" class="go" />
        </div>
      </section>

      <section v-if="done.length">
        <h3 class="sec done">
          Concluídos
          <span class="sec-actions">
            <button v-if="withChanges.length" class="ghost link accent" title="Abre Alterações com os arquivos desses agentes marcados" @click="goToChanges(withChanges)">
              Enviar alterações de {{ withChanges.length }} {{ withChanges.length === 1 ? 'agente' : 'agentes' }} →
            </button>
            <button v-if="reviewed.length" class="ghost link" title="Fecha as janelas dos concluídos que você já viu (a conversa fica em Conversas)" @click="archiveReviewed">Arquivar revisados</button>
          </span>
        </h3>
        <template v-for="a in done" :key="a.uid">
          <article v-if="selUid === a.uid" :data-uid="a.uid" class="card done-open sel">
            <div class="row">
              <span class="dot done" />
              <strong class="ellipsis grow">{{ a.title }}</strong>
              <span v-if="a.files && (a.files.add || a.files.del)" class="stats mono">
                <span v-if="a.files.add" class="add">+{{ a.files.add }}</span>
                <span v-if="a.files.del" class="del">−{{ a.files.del }}</span>
              </span>
              <small class="faint when">{{ ago(a.since) }}</small>
              <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="act(a, { type: 'pin' })"><Icon name="pin" :size="13" /></button>
              <button class="ghost icon small" title="Abrir a janela" @click="show(a)"><Icon name="external" :size="13" /></button>
            </div>
            <p v-if="a.summary" class="result">{{ a.summary }}</p>
            <ol v-if="a.checklist?.length" class="cl card-cl">
              <li v-for="(it, n) in a.checklist" :key="n" :class="{ done: it.done, open: !it.done }">
                <span class="cl-box"><Icon v-if="it.done" name="check" :size="10" /></span><span>{{ it.text }}</span>
              </li>
            </ol>
            <div v-if="chips(a).length" class="chips">
              <span v-for="c in chips(a)" :key="c.text" class="chip" :class="c.tone">{{ c.text }}</span>
            </div>
            <MiniComposer :agent="a" :known="known" class="next" @send="(text, opts) => act(a, { type: 'reply', text, ...opts })" />
          </article>
          <div v-else :data-uid="a.uid" class="item" @click="clickDone(a)">
            <span class="dot done" :class="{ seen: !isNew(a) }" />
            <span class="text">
              <span class="line">
                <strong class="ellipsis" :class="{ light: !isNew(a) }">{{ a.title }}</strong>
                <span v-if="isNew(a)" class="new">novo</span>
              </span>
              <small class="faint ellipsis">{{ a.summary || a.project }}{{ isNew(a) ? '' : ' · revisado' }}</small>
            </span>
            <span v-if="a.files && (a.files.add || a.files.del)" class="stats mono">
              <span v-if="a.files.add" class="add">+{{ a.files.add }}</span>
              <span v-if="a.files.del" class="del">−{{ a.files.del }}</span>
            </span>
            <small class="faint when">{{ ago(a.since) }}</small>
            <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="act(a, { type: 'pin' })"><Icon name="pin" :size="13" /></button>
            <button class="ghost icon small go-btn" title="Abrir a janela" @click.stop="show(a)"><Icon name="external" :size="13" /></button>
          </div>
        </template>
      </section>

      <section v-if="idle.length">
        <h3 class="sec">Sem conversa</h3>
        <div v-for="a in idle" :key="a.uid" :data-uid="a.uid" class="item" :class="{ sel: selUid === a.uid }" @click="show(a)">
          <span class="dot" />
          <span class="text">
            <strong class="ellipsis">{{ a.title }}</strong>
            <small class="faint ellipsis">{{ a.project }} · {{ a.model }}</small>
          </span>
          <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="act(a, { type: 'pin' })"><Icon name="pin" :size="13" /></button>
          <Icon name="external" :size="13" class="go" />
        </div>
      </section>
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
.toolbar { gap: 10px; }
.toolbar { display: flex; align-items: center; flex: none; box-sizing: border-box; height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border); }
.scroll { flex: 1; overflow: auto; padding: 0 16px 24px; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.head strong { font-size: 14px; }
.count { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
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
.empty { display: flex; flex-direction: column; align-items: center; gap: 12px; margin: 48px 0 0; }
.empty p { margin: 0; font-size: 13px; }
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
.cl { list-style: none; margin: 4px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.cl li { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); min-width: 0; }
.cl li.done { text-decoration: line-through; color: var(--faint); }
.cl li.next { color: var(--text); font-weight: 600; }
.cl li.open { color: var(--mod); }
.cl-box { display: inline-grid; place-items: center; width: 13px; height: 13px; border-radius: 4px; border: 1.5px solid var(--faint); flex: none; color: var(--bg); }
.cl li.done .cl-box { background: var(--add); border-color: var(--add); }
.cl li.next .cl-box { border-color: var(--hunk); }
.cl li.open .cl-box { border-color: var(--mod); }
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
