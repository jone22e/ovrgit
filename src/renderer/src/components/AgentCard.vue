<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { AgentAction, AgentSnapshot } from '@shared/types'
import { ago } from '../ago'
import { EFFORT_LABEL, MODES } from '@shared/models'
import { api, ask, state } from '../store'
import AgentBuddy from './AgentBuddy.vue'
import AgentLogo from './AgentLogo.vue'
import ContextBattery from './ContextBattery.vue'
import Heartbeat from './Heartbeat.vue'
import Icon from './Icon.vue'

/**
 * Cartão de um agente no modo orquestrador: número do atalho em destaque, anel de progresso (o checklist do plano;
 * sem checklist, girando enquanto trabalha), selo de situação, o que o agente está fazendo e os controles da janela.
 * No rodapé, entre o modo e os controles, os sinais vitais: a bateria de contexto (quanto da janela ainda está
 * livre) e um traçado de eletrocardiograma cujo ritmo diz o estado antes de ler qualquer texto. Clicar no cartão
 * mostra a conversa na área ao lado.
 *
 * Todos os cartões têm a mesma altura: cada parte que varia (título, texto do que está fazendo ou etiquetas do
 * resultado, barrinhas das etapas) tem uma altura reservada, então o texto muda sem mexer no grid.
 */
const props = defineProps<{
  a: AgentSnapshot
  /** Posição na lista (⌘1–9 traz a conversa); null: sem atalho */
  n: number | null
  now: number
  selected: boolean
  /** Concluído ainda não visto */
  fresh?: boolean
  /** Rodando sem sinal do agente há tempo demais */
  stalled?: boolean
}>()
const emit = defineEmits<{ pick: []; act: [action: AgentAction] }>()

/** Configurações: o canto do cartão mostra o mascote em miniatura no lugar do anel */
const mascot = computed(() => state.settings?.cardIndicator === 'mascot')
const checklist = computed(() => props.a.checklist ?? [])
const doneCount = computed(() => checklist.value.filter((i) => i.done).length)
/** Etapa em andamento: a primeira ainda não encerrada */
const current = computed(() => checklist.value.find((i) => !i.done) ?? null)
/** Fração do anel: pelo checklist; concluído ou com falha, cheio; sem checklist, rodando gira sem fim */
const fraction = computed<number | null>(() => {
  if (props.a.status === 'done' || props.a.status === 'error') return 1
  if (checklist.value.length) return doneCount.value / checklist.value.length
  if (props.a.status === 'live') return null
  return 0
})
const RADIUS = 15.5
const CIRC = 2 * Math.PI * RADIUS
const dashOffset = computed(() => CIRC * (1 - (fraction.value ?? 0.28)))
const percent = computed(() => (fraction.value === null ? null : Math.round(fraction.value * 100)))

const tone = computed(() => (props.a.status === 'live' && props.stalled ? 'stalled' : props.a.standby && props.a.status === 'idle' ? 'standby' : props.a.status))
const LABEL: Record<string, string> = { live: 'Rodando', stalled: 'Parado', waiting: 'Aguardando você', done: 'Concluído', error: 'Falhou', idle: 'Sem conversa', standby: 'Em espera' }
const statusLabel = computed(() => LABEL[tone.value])
const since = computed(() => {
  const a = props.a
  if (a.status === 'live') return `há ${ago(props.now, a.startedAt ?? a.since)}`
  if (a.status === 'waiting') return `há ${ago(props.now, a.since)}`
  if (a.status === 'done' || a.status === 'error') return `há ${ago(props.now, a.since)}`
  return ''
})
/** O que mostrar sob o selo: atividade, pergunta, plano, resumo ou erro */
const detail = computed(() => {
  const a = props.a
  if (a.status === 'live') {
    if (props.stalled) return `Sem saída há ${ago(props.now, a.lastEventAt!)}${a.lastTool ? ` · último: ${a.lastTool}` : ''}`
    return current.value?.text ?? a.activity ?? 'Trabalhando…'
  }
  if (a.status === 'waiting') return a.ask?.kind === 'plan' ? (a.ask.title ?? 'Plano pronto: aprovar a implementação?') : (a.ask?.text ?? a.note ?? 'Esperando a sua resposta')
  if (a.status === 'error') return a.lastUser ? `Interrompido durante "${a.lastUser}"` : (a.error ?? 'Falhou')
  if (tone.value === 'standby') return 'Pronto para a próxima tarefa da fila'
  // concluído e sem conversa: nada a dizer aqui (a conversa está ao lado)
  return ''
})
/** Etiquetas do resultado (concluído): arquivos, testes, typecheck, build, deploy */
const chips = computed(() => {
  const out: { text: string; tone: '' | 'ok' | 'bad' | 'warn' }[] = []
  const a = props.a
  const c = a.checks
  if (a.status !== 'done') return out
  if (c?.tests) out.push({ text: `${c.tests.count ? `${c.tests.count} testes` : 'testes'} ${c.tests.ok ? '✓' : '✗'}`, tone: c.tests.ok ? 'ok' : 'bad' })
  if (typeof c?.typecheck === 'boolean') out.push({ text: `typecheck ${c.typecheck ? '✓' : '✗'}`, tone: c.typecheck ? 'ok' : 'bad' })
  if (c?.build !== undefined) out.push({ text: `build ${c.build ? '✓' : '✗'}`, tone: c.build ? 'ok' : 'bad' })
  if (c?.deploy) out.push({ text: 'com deploy', tone: 'warn' })
  return out
})
/** Rodapé: modo e esforço da conversa */
const modeLabel = computed(() => MODES.find((m) => m.id === props.a.mode)?.label ?? '')
const effortLabel = computed(() => EFFORT_LABEL[props.a.effort] ?? '')
/** Rodando: tempo decorrido como relógio (m:ss, ou h:mm:ss) */
const clock = computed(() => {
  const s = Math.max(0, Math.round((props.now - (props.a.startedAt ?? props.a.since)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
})
/** Encerra a conversa (no orquestrador não há janela para esconder: só encerrar); trabalhando, confirma antes */
async function close() {
  if (props.a.status === 'live') {
    const ok = await ask({ title: 'Encerrar a conversa?', message: 'O agente está trabalhando e será interrompido. A conversa fica em Conversas.', confirmLabel: 'Encerrar', danger: true })
    if (!ok) return
  }
  api.agentClose([props.a.uid]).catch(() => undefined)
}
/** Clique fora de botões, campos e texto selecionado: escolhe o cartão */
function onClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest('button, input, textarea, a, select, .ask-in') || window.getSelection()?.toString()) return
  emit('pick')
}

// ---------- menu do botão direito: mostrar, renomear, fixar, nova conversa, encerrar ----------
const menu = ref<{ left: number; top: number } | null>(null)
const menuEl = ref<HTMLElement>()
function onMenu(e: MouseEvent) {
  // campos de texto (responder ao agente) ficam com o menu do sistema: copiar e colar
  if ((e.target as HTMLElement).closest('input, textarea, .ask-in') || renaming.value) return
  e.preventDefault()
  menu.value = { left: e.clientX, top: e.clientY }
  nextTick(() => {
    // não deixa o menu sair da janela
    const r = menuEl.value?.getBoundingClientRect()
    if (r) menu.value = { left: Math.min(e.clientX, window.innerWidth - r.width - 8), top: Math.min(e.clientY, window.innerHeight - r.height - 8) }
  })
}
const closeMenu = () => (menu.value = null)
const onDoc = (e: MouseEvent) => {
  if (menu.value && !menuEl.value?.contains(e.target as Node)) closeMenu()
}
const onEsc = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && menu.value) closeMenu()
}
/** A lista rolou ou a janela mudou de tamanho: o menu (fixo na tela) fecha */
const onMove = (e?: Event) => {
  if (e && menuEl.value && e.target instanceof Node && menuEl.value.contains(e.target)) return
  closeMenu()
}
watch(menu, (m, was) => {
  if (m && !was) {
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onEsc, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
  } else if (!m && was) unlisten()
})
function unlisten() {
  document.removeEventListener('mousedown', onDoc, true)
  document.removeEventListener('keydown', onEsc, true)
  window.removeEventListener('resize', onMove)
  window.removeEventListener('scroll', onMove, true)
}
onUnmounted(unlisten)
function pickFromMenu() {
  closeMenu()
  emit('pick')
}
function pinFromMenu() {
  closeMenu()
  emit('act', { type: 'pin' })
}
/** Conversa nova com o mesmo agente (a atual fica em Conversas); trabalhando, confirma antes */
async function newChat() {
  closeMenu()
  if (props.a.status === 'live') {
    const ok = await ask({ title: 'Começar uma conversa nova?', message: 'O agente está trabalhando e será interrompido. A conversa atual fica em Conversas.', confirmLabel: 'Nova conversa', danger: true })
    if (!ok) return
  }
  api.agentNewChat(props.a.uid).catch(() => undefined)
}
function closeFromMenu() {
  closeMenu()
  close()
}

// ---------- renomear em linha, no título do cartão ----------
const renaming = ref(false)
const draft = ref('')
const renameInput = ref<HTMLInputElement>()
/** Título recém-salvo, até o resumo da janela trazer o mesmo (evita o antigo piscar de volta) */
const savedTitle = ref<string | null>(null)
const shownTitle = computed(() => savedTitle.value ?? props.a.title)
watch(() => props.a.title, (t) => t === savedTitle.value && (savedTitle.value = null))
async function startRename() {
  closeMenu()
  draft.value = props.a.title
  renaming.value = true
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}
function cancelRename() {
  renaming.value = false
}
async function saveRename() {
  if (!renaming.value) return
  renaming.value = false
  const t = draft.value.replace(/\s+/g, ' ').trim()
  // vazio ou igual: nada muda (o título não some)
  if (!t || t === props.a.title) return
  savedTitle.value = t
  try {
    await api.agentSetTitle(props.a.uid, t)
  } catch {
    savedTitle.value = null
  }
}
</script>

<template>
  <article class="acard" :class="[tone, { sel: selected, fresh }]" :data-uid="a.uid" @click="onClick" @contextmenu="onMenu">
    <div class="top">
      <span v-if="n !== null" class="num mono" :title="`⌘${n}: mostra esta conversa`">{{ n }}</span>
      <div class="ttl">
        <input
          v-if="renaming"
          ref="renameInput"
          v-model="draft"
          type="text"
          class="rename"
          maxlength="120"
          placeholder="Título da conversa"
          @keydown.stop
          @keydown.enter.prevent="saveRename"
          @keydown.esc.prevent="cancelRename"
          @blur="saveRename"
        />
        <strong v-else class="title" title="Botão direito: renomear e mais"><AgentLogo :source="a.provider" :size="13" class="logo" />{{ shownTitle }}</strong>
        <small class="faint ellipsis">{{ a.project }} · {{ a.model }}</small>
      </div>
      <!-- rodando ou aguardando: anel de progresso (checklist feito/total; sem checklist, gira). Concluído e falhou: um selo pequeno -->
      <!-- mascote no lugar do anel (Configurações): trabalhando, esperando você ou cochilando (parado) -->
      <AgentBuddy
        v-if="mascot && (a.status === 'live' || a.status === 'waiting')"
        :mood="a.status === 'waiting' ? 'waiting' : stalled ? 'stalled' : 'working'"
        :uid="a.uid"
        :size="28"
        class="buddy"
        :title="checklist.length ? `${doneCount} de ${checklist.length} etapas` : statusLabel"
      />
      <span v-else-if="a.status === 'live' || a.status === 'waiting'" class="ring" :class="[tone, { indet: fraction === null }]" :title="checklist.length ? `${doneCount} de ${checklist.length} etapas` : statusLabel">
        <svg viewBox="0 0 36 36">
          <circle class="track" cx="18" cy="18" :r="RADIUS" />
          <circle class="bar" cx="18" cy="18" :r="RADIUS" :stroke-dasharray="CIRC" :stroke-dashoffset="dashOffset" />
        </svg>
        <span class="in">
          <b v-if="a.status === 'waiting'">?</b>
          <b v-else-if="percent !== null && checklist.length" class="mono pct">{{ percent }}</b>
        </span>
      </span>
      <span v-else-if="a.status === 'done' || a.status === 'error'" class="badge" :class="a.status" :title="statusLabel">
        <Icon :name="a.status === 'done' ? 'check' : 'x'" :size="12" />
      </span>
    </div>

    <div class="status">
      <span class="pill" :class="tone"><span class="dot" />{{ statusLabel }}</span>
      <span v-if="a.status === 'live'" class="clock mono" :title="`Trabalhando há ${ago(now, a.startedAt ?? a.since)}`">{{ clock }}</span>
      <small v-else-if="since" class="faint">{{ since }}</small>
      <span v-if="fresh" class="new">novo</span>
      <span class="gap" />
      <span v-if="checklist.length" class="steps mono" :title="`${doneCount} de ${checklist.length} etapas concluídas`"><Icon name="listChecks" :size="11" /> {{ doneCount }}/{{ checklist.length }}</span>
      <span v-if="a.files?.count" class="stats mono" :title="`${a.files.count} ${a.files.count === 1 ? 'arquivo alterado' : 'arquivos alterados'}`">
        <Icon name="pencil" :size="11" /> {{ a.files.count }}
        <span v-if="a.files.add" class="add">+{{ a.files.add }}</span>
        <span v-if="a.files.del" class="del">−{{ a.files.del }}</span>
      </span>
    </div>

    <!-- o que o cartão tem a dizer, numa área de duas linhas: atividade, pergunta, erro ou, concluído, as etiquetas do resultado -->
    <div class="say">
      <div v-if="chips.length" class="chips">
        <span v-for="c in chips" :key="c.text" class="chip" :class="c.tone">{{ c.text }}</span>
      </div>
      <p v-else class="detail" :class="{ err: a.status === 'error', warn: tone === 'stalled', live: a.status === 'live' && !stalled }" :title="detail">{{ detail }}</p>
    </div>
    <!-- etapas do checklist: barrinhas, uma por etapa (feita, dispensada, a atual pulsando, a fazer); sem checklist, a faixa fica vazia -->
    <ol class="track-steps" :title="checklist.map((i, k) => `${k + 1}. ${i.text}`).join('\n')">
      <li v-for="(it, k) in checklist" :key="k" :class="{ done: it.done && !it.state, skipped: it.state === 'skipped', failed: it.state === 'failed', now: it === current && a.status === 'live' && !stalled }" />
    </ol>

    <div class="foot">
      <button v-if="a.status === 'error'" class="small retry" title="Continua a tarefa de onde parou" @click.stop="emit('act', { type: 'retry' })">Retomar</button>
      <button v-else-if="tone === 'stalled'" class="small nudge" title="Avisa o agente de que há pressa (o mesmo do Acelerar)" @click.stop="emit('act', { type: 'nudge' })">Cutucar</button>
      <small v-else-if="a.status === 'waiting'" class="meta hint ellipsis">Clique para responder</small>
      <small v-else class="faint meta ellipsis" :title="effortLabel ? `${modeLabel} · ${effortLabel}` : modeLabel">{{ modeLabel }}<template v-if="effortLabel"> · {{ effortLabel }}</template></small>
      <span class="gap">
        <ContextBattery v-if="a.context" :context="a.context" />
        <Heartbeat v-if="tone !== 'idle'" :tone="tone" />
      </span>
      <span class="ctl">
        <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="emit('act', { type: 'pin' })"><Icon name="pin" :size="13" /></button>
        <button class="ghost icon small close" :title="a.status === 'live' ? 'Encerrar a conversa (interrompe o agente)' : 'Encerrar a conversa (fica em Conversas)'" @click.stop="close"><Icon name="x" :size="13" /></button>
      </span>
      <span class="go" :class="{ on: selected }" :title="selected ? 'Conversa mostrada ao lado' : 'Mostrar a conversa ao lado'"><Icon name="columns" :size="13" /></span>
    </div>
    <!-- menu do botão direito, fixo no ponto do clique (no body, para não ser recortado pela lista) -->
    <Teleport to="body">
      <div v-if="menu" ref="menuEl" class="ctx" role="menu" :style="{ left: `${menu.left}px`, top: `${menu.top}px` }" @click.stop @contextmenu.prevent>
        <p class="where faint ellipsis">{{ shownTitle }}</p>
        <button v-if="!selected" type="button" class="item" @click="pickFromMenu"><Icon name="columns" :size="14" /><span class="nm">Mostrar ao lado</span></button>
        <button type="button" class="item" @click="startRename"><Icon name="pencil" :size="14" /><span class="nm">Renomear…</span></button>
        <button v-if="a.canPin" type="button" class="item" @click="pinFromMenu"><Icon name="pin" :size="14" /><span class="nm">{{ a.pinned ? 'Soltar do topo da lista' : 'Fixar no topo da lista' }}</span></button>
        <button type="button" class="item" @click="newChat"><Icon name="compose" :size="14" /><span class="nm">Nova conversa com este agente</span></button>
        <div class="sep" />
        <button type="button" class="item bad" @click="closeFromMenu"><Icon name="x" :size="14" /><span class="nm">{{ a.status === 'live' ? 'Encerrar (interrompe o agente)' : 'Encerrar a conversa' }}</span></button>
      </div>
    </Teleport>
  </article>
</template>

<style scoped>
.acard {
  position: relative; display: flex; flex-direction: column; gap: 9px; min-width: 0; padding: 14px 14px 10px;
  border: 1px solid var(--border); border-radius: 14px; cursor: pointer;
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 55%, var(--panel)), var(--panel) 70%);
  transition: border-color 0.12s, box-shadow 0.15s, transform 0.12s;
}
.acard:hover { border-color: color-mix(in srgb, var(--text) 22%, var(--border)); transform: translateY(-1px); box-shadow: 0 8px 24px -16px rgba(0, 0, 0, 0.8); }
/* a conversa da vez: contorno na cor do tema e um brilho suave por baixo */
.acard.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 12px 32px -14px color-mix(in srgb, var(--accent) 70%, transparent); }
.acard.sel { background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 10%, var(--panel)), var(--panel) 75%); }
.acard.waiting { background: linear-gradient(180deg, color-mix(in srgb, var(--mod) 9%, var(--panel)), var(--panel) 75%); }
.acard.error { background: linear-gradient(180deg, color-mix(in srgb, var(--del) 9%, var(--panel)), var(--panel) 75%); }
.acard.stalled { background: linear-gradient(180deg, color-mix(in srgb, var(--mod) 7%, var(--panel)), var(--panel) 75%); }
/* aguardando resposta: o cartão é um aviso e pulsa de leve até ser atendido */
.acard.waiting:not(.sel) { border-color: color-mix(in srgb, var(--mod) 55%, var(--border)); animation: waiting 2.2s ease-in-out infinite; }
@keyframes waiting { 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--mod) 22%, transparent); } }
.acard.waiting .detail { color: var(--text); }
.acard.error:not(.sel) { border-color: color-mix(in srgb, var(--del) 40%, var(--border)); }
/* tema Terminal: cartão chapado, sem gradiente, sombra nem brilho; a conversa da vez se marca pela borda e pelo número invertido */
:root[data-theme='terminal'] .acard, :root[data-theme='terminal'] .acard:hover, :root[data-theme='terminal'] .acard.sel { background: var(--panel); box-shadow: none; transform: none; }
:root[data-theme='terminal'] .acard.waiting, :root[data-theme='terminal'] .acard.stalled { background: color-mix(in srgb, var(--mod) 7%, var(--panel)); }
/* o esmaecimento do batimento usa a cor do fundo: só o tema Terminal tem cartão chapado tingido (nos outros o rodapé já está sobre o painel) */
:root[data-theme='terminal'] .acard.waiting, :root[data-theme='terminal'] .acard.stalled { --hb-bg: color-mix(in srgb, var(--mod) 7%, var(--panel)); }
:root[data-theme='terminal'] .acard.error { background: color-mix(in srgb, var(--del) 7%, var(--panel)); }
:root[data-theme='terminal'] .acard.sel .num { box-shadow: none; }

.top { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
/* número do atalho: uma tecla; na conversa da vez, cheia */
.num {
  display: grid; place-items: center; min-width: 22px; height: 22px; padding: 0 5px; flex: none; margin-top: 1px; border-radius: 6px;
  font-size: 12px; font-weight: 800; color: var(--accent); background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.acard.sel .num { color: var(--on-accent); background: var(--accent); box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--accent) 80%, transparent); }
.ttl { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.title { font-size: 13.5px; font-weight: 600; line-height: 1.3; min-height: 2.6em; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.logo { display: inline-block; vertical-align: -2px; margin-right: 6px; opacity: 0.9; }
.ttl small { font-size: 11.5px; }
/* renomear em linha: o campo toma o lugar do título */
.rename { width: 100%; height: 26px; margin: 4px 0 5px; padding: 0 6px; font-size: 13px; font-weight: 600; }

/* anel de progresso (ou o mascote, pelas Configurações) */
.ring { position: relative; width: 28px; height: 28px; flex: none; }
.buddy { margin: -1px -3px 0 0; }
.ring > svg { display: block; width: 100%; height: 100%; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3.5; }
.ring .track { stroke: color-mix(in srgb, var(--faint) 22%, transparent); }
.ring .bar { stroke: var(--accent); stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
.ring.waiting .bar, .ring.stalled .bar { stroke: var(--mod); }
.ring.done .bar { stroke: var(--add); }
.ring.error .bar { stroke: var(--del); }
.ring.idle .bar { stroke: transparent; }
/* sem checklist e rodando: um arco girando */
.ring.indet > svg { animation: turn 1.1s linear infinite; }
.ring.stalled.indet > svg { animation: none; }
.ring .in { position: absolute; inset: 0; display: grid; place-items: center; font-size: 10px; color: var(--text); line-height: 1; }
.ring .pct { font-size: 9px; font-weight: 700; color: var(--muted); }
.ring.waiting .in { color: var(--mod); font-size: 13px; font-weight: 800; animation: blink 1.6s ease-in-out infinite; }
/* selo do concluído e do falhou: pequeno e preenchido */
.badge { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: none; border-radius: 50%; line-height: 0; }
.badge :deep(svg) { display: block; }
.badge.done { color: var(--add); background: color-mix(in srgb, var(--add) 16%, transparent); }
.badge.error { color: var(--del); background: color-mix(in srgb, var(--del) 16%, transparent); }
@keyframes turn { to { transform: rotate(270deg); } }
@keyframes blink { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .ring.indet > svg, .ring.waiting .in, .track-steps li.now, .detail.live::after, .pill.live .dot, .acard.waiting { animation: none; } }

.status { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gap { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; background: var(--panel-2); color: var(--muted); flex: none; }
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.live { color: var(--accent); background: var(--accent-soft); }
.pill.live .dot { animation: blink 1.4s ease-in-out infinite; }
.pill.waiting, .pill.stalled { color: var(--mod); background: color-mix(in srgb, var(--mod) 14%, transparent); }
.pill.done { color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); }
.pill.error { color: var(--del); background: color-mix(in srgb, var(--del) 14%, transparent); }
.pill.standby { color: var(--hunk); background: color-mix(in srgb, var(--hunk) 14%, transparent); }
.acard.standby .num { color: var(--hunk); background: color-mix(in srgb, var(--hunk) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hunk) 35%, transparent); }
.detail.standby { color: var(--muted); }
.status small { font-size: 11.5px; white-space: nowrap; }
.clock { font-size: 11.5px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.new { flex: none; font-size: 10px; padding: 1px 6px; border-radius: 5px; color: var(--accent); background: var(--accent-soft); font-weight: 700; }
.steps { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; color: var(--hunk); flex: none; }
.stats { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); flex: none; }
.stats .add { color: var(--add); }
.stats .del { color: var(--del); }

.say { height: calc(2 * 1.45 * 12.5px); overflow: hidden; }
.detail { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.detail.live { color: var(--text); }
/* rodando: um cursor piscando no fim do que está fazendo */
.detail.live::after { content: ''; display: inline-block; width: 6px; height: 12px; margin-left: 4px; vertical-align: -1px; background: var(--accent); animation: blink 1s steps(2) infinite; }
.detail.err { color: var(--del); }
.detail.warn { color: var(--mod); }
/* etapas do checklist como barrinhas */
.track-steps { list-style: none; margin: 0; padding: 0; height: 4px; display: flex; gap: 3px; }
.track-steps li { flex: 1; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--faint) 25%, transparent); }
.track-steps li.done { background: var(--add); }
.track-steps li.skipped { background: color-mix(in srgb, var(--faint) 50%, transparent); }
.track-steps li.failed { background: var(--del); }
.track-steps li.now { background: var(--hunk); animation: blink 1.2s ease-in-out infinite; }
.chips { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px 6px; }
.chip { font-size: 11px; line-height: 14px; padding: 1px 7px; border-radius: 6px; background: var(--panel-2); color: var(--muted); }
.chip.ok { color: var(--add); background: color-mix(in srgb, var(--add) 12%, transparent); }
.chip.bad { color: var(--del); background: color-mix(in srgb, var(--del) 12%, transparent); }
.chip.warn { color: var(--mod); background: color-mix(in srgb, var(--mod) 12%, transparent); }

/* rodapé, sempre na base do cartão (os cartões da mesma linha têm a mesma altura): modo e esforço; os controles da janela só ao passar o mouse */
.foot { display: flex; align-items: center; gap: 2px; min-height: 26px; margin-top: auto; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.meta { font-size: 11px; min-width: 0; }
.hint { color: var(--mod); font-weight: 600; }
.retry, .nudge { height: 24px; font-size: 11.5px; }
.nudge { color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); background: color-mix(in srgb, var(--mod) 10%, transparent); }
.ctl { display: inline-flex; align-items: center; gap: 2px; opacity: 0; transition: opacity 0.12s; }
.acard:hover .ctl, .ctl:has(.pinned) { opacity: 1; }
.pin, .close { color: var(--faint); }
.pin.pinned { color: var(--accent); }
.close:hover { color: var(--del); }
.go { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; color: var(--faint); }
.go.on { color: var(--accent); background: var(--accent-soft); }

/* menu do botão direito (vive no body) */
.ctx {
  position: fixed; z-index: 60; min-width: 240px; max-width: 320px; padding: 4px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 9px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; } }
.ctx .where { margin: 0; padding: 5px 8px 6px; font-size: 11.5px; }
.ctx .item {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text); font-size: 12.5px; text-align: left; justify-content: flex-start;
}
.ctx .item:hover { background: var(--accent-soft); }
.ctx .item.bad:hover { color: var(--del); background: color-mix(in srgb, var(--del) 12%, transparent); }
.ctx .item svg { color: var(--faint); flex: none; }
.ctx .item.bad:hover svg { color: inherit; }
.ctx .nm { white-space: nowrap; }
.ctx .sep { height: 1px; margin: 4px 6px; background: var(--border); }
</style>
