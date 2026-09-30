<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { AgentAction, AgentMode, AgentSnapshot } from '@shared/types'
import { api, openNewAgent, selectFile, setPane, state, toast } from '../store'
import { PROVIDER_LABEL } from '@shared/models'
import AskCard from './AskCard.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import PaneSwitch from './PaneSwitch.vue'

/**
 * Gerenciador de agentes: todas as janelas de agente abertas (de qualquer projeto), agrupadas pelo que precisam.
 * Perguntas e a aprovação do plano são respondidas daqui mesmo; a ação vai para a janela do agente, que executa.
 */
const snaps = computed(() => state.agentSnaps)
const byStatus = (s: AgentSnapshot['status']) => snaps.value.filter((a) => a.status === s)
/** Precisa de você: esperando resposta primeiro (a mais antiga no topo), depois as que falharam */
const needYou = computed(() => [...byStatus('waiting').sort((a, b) => a.since - b.since), ...byStatus('error').sort((a, b) => b.since - a.since)])
const running = computed(() => byStatus('live').sort((a, b) => a.since - b.since))
const done = computed(() => byStatus('done').sort((a, b) => b.since - a.since))
const idle = computed(() => byStatus('idle'))

// relógio para os "há 3 min" andarem sozinhos
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval>
onMounted(() => (tick = setInterval(() => (now.value = Date.now()), 15_000)))
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
  if (c?.typecheck === null) out.push({ text: 'typecheck não rodado', tone: 'warn' })
  else if (c?.typecheck !== undefined) out.push({ text: `typecheck ${c.typecheck ? '✓' : '✗'}`, tone: c.typecheck ? 'ok' : 'bad' })
  if (c?.build !== undefined) out.push({ text: `build ${c.build ? '✓' : '✗'}`, tone: c.build ? 'ok' : 'bad' })
  if (c?.deploy) out.push({ text: 'com deploy', tone: 'warn' })
  else if (a.files?.count) out.push({ text: 'sem deploy', tone: '' })
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
function goToChanges(list: AgentSnapshot[], openFirst = false) {
  const paths = [...new Set(list.flatMap(repoPaths))]
  if (!paths.length) return toast('As alterações desses agentes não estão mais na lista.')
  list.forEach(markSeen)
  state.tab = 'changes'
  setPane('changes')
  state.selected = new Set(paths)
  const first = state.repo?.files.find((f) => f.path === paths[0])
  if (openFirst && first) selectFile(first)
}
/** Fecha as janelas dos concluídos já vistos (a conversa continua em Conversas) */
const reviewed = computed(() => done.value.filter((a) => !isNew(a)))
const archiveReviewed = () => api.agentClose(reviewed.value.map((a) => a.uid)).catch(() => undefined)

// ---------- seleção e teclado: J/K navegam, Enter abre, ⌘1–9 traz a janela para a frente ----------
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
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault()
    select(order.value[Math.min(order.value.length - 1, i + 1)])
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
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

/** Resposta digitada em cada cartão (uid → texto) */
const replies = ref<Record<string, string>>({})
function act(a: AgentSnapshot, action: AgentAction) {
  api.agentAct(a.uid, action).catch(() => undefined)
}
function reply(a: AgentSnapshot) {
  const text = (replies.value[a.uid] ?? '').trim()
  if (!text) return
  replies.value[a.uid] = ''
  act(a, { type: 'reply', text })
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
}
</script>

<template>
  <div ref="root" class="agents">
    <div class="toolbar">
      <PaneSwitch />
      <span class="gap" />
      <small class="keys faint mono" title="Atalhos desta tela">J/K navegar · ↵ abrir · ⌘1–9 focar</small>
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
          <span class="bars"><span v-for="i in Math.min(snaps.length, 12)" :key="i" :class="{ on: i <= active }" /></span>
        </span>
        <button :disabled="!snaps.length || arranging" title="Coloca as janelas de agente no grid de cada tela, lado a lado" @click="arrange">
          <span v-if="arranging" class="spinner" />
          <Icon v-else name="grid" :size="13" />
          Organizar
        </button>
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
        <div v-for="a in running" :key="a.uid" :data-uid="a.uid" class="item run" :class="{ stalled: stalled(a), sel: selUid === a.uid }" @click="show(a)">
          <span class="dot" :class="stalled(a) ? 'waiting' : 'live'" />
          <span class="text">
            <span class="line">
              <strong class="ellipsis">{{ a.title }}</strong>
              <small v-if="stalled(a)" class="warn ellipsis">sem saída há {{ ago(a.lastEventAt!) }}{{ a.lastTool ? ` · último: ${a.lastTool}` : '' }}</small>
              <small v-else class="faint ellipsis">{{ a.activity || 'Trabalhando…' }}</small>
            </span>
            <span class="bar" :class="{ stalled: stalled(a) }"><span /></span>
          </span>
          <small class="faint when">{{ ago(a.startedAt ?? a.since) }}</small>
          <button v-if="stalled(a)" class="small nudge" title="Avisa o agente de que há pressa (o mesmo do Acelerar)" @click.stop="act(a, { type: 'nudge' })">Cutucar</button>
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
              <button class="ghost icon small" title="Abrir a janela" @click="show(a)"><Icon name="external" :size="13" /></button>
            </div>
            <p v-if="a.summary" class="result">{{ a.summary }}</p>
            <div v-if="chips(a).length" class="chips">
              <span v-for="c in chips(a)" :key="c.text" class="chip" :class="c.tone">{{ c.text }}</span>
            </div>
            <form class="next" @submit.prevent="reply(a)">
              <input v-model="replies[a.uid]" type="text" placeholder="Próxima instrução para este agente…" maxlength="4000" />
              <button v-if="a.checks?.typecheck !== true && a.files?.count" type="button" class="small" @click="act(a, { type: 'reply', text: 'Rode o typecheck do projeto e corrija o que falhar.' })">Rodar typecheck</button>
              <button v-if="repoPaths(a).length" type="button" class="small" @click="goToChanges([a], true)">Ver diff</button>
            </form>
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
.keys { font-size: 11px; white-space: nowrap; }
@container (max-width: 640px) { .keys { display: none; } }
.toolbar { display: flex; align-items: center; flex: none; box-sizing: border-box; height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border); }
.scroll { flex: 1; overflow: auto; padding: 0 16px 24px; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.head strong { font-size: 14px; }
.count { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.gap { flex: 1; }
.head button { height: 28px; gap: 6px; font-size: 12.5px; }
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
.line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
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
.nudge { height: 26px; color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); background: color-mix(in srgb, var(--mod) 10%, transparent); }
/* barra de andamento: o CLI não informa quanto falta, então ela corre sem parar enquanto há sinal; parada, fica âmbar */
.bar { position: relative; display: block; height: 3px; max-width: 520px; margin-top: 5px; border-radius: 2px; background: var(--panel-2); overflow: hidden; }
.bar span { position: absolute; top: 0; bottom: 0; width: 35%; border-radius: inherit; background: var(--accent); animation: run 1.6s ease-in-out infinite; }
.bar.stalled span { width: 45%; left: 0; background: var(--mod); animation: none; }
@keyframes run { from { left: -35%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .bar span { animation: none; left: 0; } }
.slots { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; }
.bars { display: inline-flex; gap: 3px; }
.bars span { width: 12px; height: 4px; border-radius: 2px; background: var(--panel-2); }
.bars span.on { background: var(--accent); }
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
.next { display: flex; gap: 8px; margin-left: 18px; }
.next input { flex: 1; min-width: 0; font-size: 12.5px; }
.next button { height: 30px; }
.go-btn { color: var(--faint); }
.item:hover { background: var(--hover); }
.when { font-size: 12px; white-space: nowrap; min-width: 40px; text-align: right; }
.stats { display: flex; gap: 8px; font-size: 12px; }
.stats .add { color: var(--add); }
.stats .del { color: var(--del); }
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
