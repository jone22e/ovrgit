<script setup lang="ts">
import { computed } from 'vue'
import type { AgentAction, AgentSnapshot } from '@shared/types'
import { ago } from '../ago'
import AgentLogo from './AgentLogo.vue'
import AgentWindowMenu from './AgentWindowMenu.vue'
import Icon from './Icon.vue'

/**
 * Cartão de um agente no modo orquestrador: número do atalho em destaque, anel de progresso (o checklist do plano;
 * sem checklist, girando enquanto trabalha), selo de situação, o que o agente está fazendo e os controles da janela.
 * Clicar no cartão mostra a conversa na área ao lado.
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

const tone = computed(() => (props.a.status === 'live' && props.stalled ? 'stalled' : props.a.status))
const LABEL: Record<string, string> = { live: 'Rodando', stalled: 'Parado', waiting: 'Aguardando você', done: 'Concluído', error: 'Falhou', idle: 'Sem conversa' }
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
  if (a.status === 'done') return a.summary ?? ''
  return ''
})
/** Etiquetas do resultado (concluído): arquivos, testes, typecheck, build, deploy */
const chips = computed(() => {
  const out: { text: string; tone: '' | 'ok' | 'bad' | 'warn' }[] = []
  const a = props.a
  const c = a.checks
  if (a.status !== 'done') return out
  if (a.files?.count) out.push({ text: `${a.files.count} ${a.files.count === 1 ? 'arquivo' : 'arquivos'}`, tone: '' })
  if (c?.tests) out.push({ text: `${c.tests.count ? `${c.tests.count} testes` : 'testes'} ${c.tests.ok ? '✓' : '✗'}`, tone: c.tests.ok ? 'ok' : 'bad' })
  if (typeof c?.typecheck === 'boolean') out.push({ text: `typecheck ${c.typecheck ? '✓' : '✗'}`, tone: c.typecheck ? 'ok' : 'bad' })
  if (c?.build !== undefined) out.push({ text: `build ${c.build ? '✓' : '✗'}`, tone: c.build ? 'ok' : 'bad' })
  if (c?.deploy) out.push({ text: 'com deploy', tone: 'warn' })
  return out
})
/** Clique fora de botões, campos e texto selecionado: escolhe o cartão */
function onClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest('button, input, textarea, a, select, .ask-in') || window.getSelection()?.toString()) return
  emit('pick')
}
</script>

<template>
  <article class="acard" :class="[tone, { sel: selected, fresh, numbered: n !== null }]" :data-uid="a.uid" @click="onClick">
    <div class="top">
      <span v-if="n !== null" class="num mono" :title="`⌘${n}: mostra esta conversa`">{{ n }}</span>
      <div class="ttl">
        <span class="line">
          <AgentLogo :source="a.provider" :size="14" class="logo" />
          <strong class="ellipsis">{{ a.title }}</strong>
          <span v-if="fresh" class="new">novo</span>
        </span>
        <small class="faint ellipsis">{{ a.project }} · {{ a.model }}</small>
      </div>
      <!-- anel de progresso: checklist feito/total; sem checklist, gira enquanto trabalha; cheio ao terminar -->
      <span class="ring" :class="[tone, { indet: fraction === null }]" :title="checklist.length ? `${doneCount} de ${checklist.length} etapas` : statusLabel">
        <svg viewBox="0 0 36 36">
          <circle class="track" cx="18" cy="18" :r="RADIUS" />
          <circle class="bar" cx="18" cy="18" :r="RADIUS" :stroke-dasharray="CIRC" :stroke-dashoffset="dashOffset" />
        </svg>
        <span class="in">
          <Icon v-if="a.status === 'done'" name="check" :size="13" />
          <Icon v-else-if="a.status === 'error'" name="x" :size="13" />
          <b v-else-if="a.status === 'waiting'">?</b>
          <b v-else-if="percent !== null && checklist.length" class="mono pct">{{ percent }}</b>
        </span>
      </span>
    </div>

    <div class="status">
      <span class="pill" :class="tone"><span class="dot" />{{ statusLabel }}</span>
      <small v-if="since" class="faint">{{ since }}</small>
      <span v-if="checklist.length" class="steps mono" :title="`${doneCount} de ${checklist.length} etapas concluídas`"><Icon name="listChecks" :size="11" /> {{ doneCount }}/{{ checklist.length }}</span>
      <span v-if="a.files && (a.files.add || a.files.del)" class="stats mono">
        <span v-if="a.files.add" class="add">+{{ a.files.add }}</span>
        <span v-if="a.files.del" class="del">−{{ a.files.del }}</span>
      </span>
    </div>

    <p v-if="detail" class="detail" :class="{ err: a.status === 'error', warn: tone === 'stalled' }" :title="detail">{{ detail }}</p>
    <!-- checklist por etapas: barrinhas, uma por etapa (feita, dispensada, a atual pulsando, a fazer) -->
    <ol v-if="checklist.length" class="track-steps" :title="checklist.map((i, k) => `${k + 1}. ${i.text}`).join('\n')">
      <li v-for="(it, k) in checklist" :key="k" :class="{ done: it.done && !it.state, skipped: it.state === 'skipped', failed: it.state === 'failed', now: it === current && a.status === 'live' && !stalled }" />
    </ol>
    <div v-if="chips.length" class="chips">
      <span v-for="c in chips" :key="c.text" class="chip" :class="c.tone">{{ c.text }}</span>
    </div>

    <slot />

    <div class="foot">
      <button v-if="a.status === 'error'" class="small retry" title="Continua a tarefa de onde parou" @click.stop="emit('act', { type: 'retry' })">Retomar</button>
      <button v-if="tone === 'stalled'" class="small nudge" title="Avisa o agente de que há pressa (o mesmo do Acelerar)" @click.stop="emit('act', { type: 'nudge' })">Cutucar</button>
      <span class="gap" />
      <button v-if="a.canPin" class="ghost icon small pin" :class="{ pinned: a.pinned }" :title="a.pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click.stop="emit('act', { type: 'pin' })"><Icon name="pin" :size="13" /></button>
      <AgentWindowMenu :a="a" />
      <span class="go" :class="{ on: selected }" :title="selected ? 'Conversa mostrada ao lado' : 'Mostrar a conversa ao lado'"><Icon name="columns" :size="13" /></span>
    </div>
  </article>
</template>

<style scoped>
.acard {
  position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 14px 10px;
  border: 1px solid var(--border); border-radius: 14px; background: var(--panel); cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, transform 0.12s;
}
.acard:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.acard.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 10px 30px -14px color-mix(in srgb, var(--accent) 60%, transparent); }
/* cor da situação: uma faixa fina na borda de cima */
.acard::before { content: ''; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; border-radius: 0 0 2px 2px; background: transparent; }
.acard.live::before { background: var(--accent); }
.acard.stalled::before, .acard.waiting::before { background: var(--mod); }
.acard.done::before { background: var(--add); }
.acard.error::before { background: var(--del); }
.acard.waiting { background: color-mix(in srgb, var(--mod) 4%, var(--panel)); }
.acard.error { background: color-mix(in srgb, var(--del) 5%, var(--panel)); }
.acard.stalled { background: color-mix(in srgb, var(--mod) 6%, var(--panel)); }

.top { display: flex; align-items: center; gap: 10px; min-width: 0; }
/* número do atalho: quadrado em destaque, na cor do tema */
.num {
  display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 9px;
  font-size: 15px; font-weight: 800; color: var(--on-accent); background: var(--accent);
  box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--accent) 80%, transparent);
}
.acard.done .num { background: var(--add); color: #0f1a12; box-shadow: none; }
.acard.error .num { background: var(--del); color: #fff; box-shadow: none; }
.acard.waiting .num, .acard.stalled .num { background: var(--mod); color: #1a1a1a; box-shadow: none; }
.acard.idle .num { background: var(--panel-2); color: var(--muted); box-shadow: none; }
.ttl { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.line strong { font-size: 13.5px; min-width: 0; }
.logo { flex: none; opacity: 0.85; }
.ttl small { font-size: 11.5px; }
.new { flex: none; font-size: 10px; padding: 0 6px; border-radius: 5px; color: var(--accent); background: var(--accent-soft); font-weight: 700; }

/* anel de progresso */
.ring { position: relative; width: 34px; height: 34px; flex: none; }
.ring > svg { display: block; width: 100%; height: 100%; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3; }
.ring .track { stroke: color-mix(in srgb, var(--faint) 22%, transparent); }
.ring .bar { stroke: var(--accent); stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
.ring.waiting .bar, .ring.stalled .bar { stroke: var(--mod); }
.ring.done .bar { stroke: var(--add); }
.ring.error .bar { stroke: var(--del); }
.ring.idle .bar { stroke: transparent; }
/* sem checklist e rodando: um arco girando */
.ring.indet > svg { animation: turn 1.1s linear infinite; }
.ring.stalled.indet > svg { animation: none; }
.ring .in { position: absolute; inset: 0; display: grid; place-items: center; font-size: 11px; color: var(--text); line-height: 1; }
.ring .in :deep(svg) { width: 13px; height: 13px; }
.ring .pct { font-size: 10.5px; font-weight: 700; color: var(--muted); }
.ring.done .in { color: var(--add); }
.ring.error .in { color: var(--del); }
.ring.waiting .in { color: var(--mod); font-size: 14px; font-weight: 800; animation: blink 1.6s ease-in-out infinite; }
@keyframes turn { to { transform: rotate(270deg); } }
@keyframes blink { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .ring.indet > svg, .ring.waiting .in, .track-steps li.now { animation: none; } }

.status { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; background: var(--panel-2); color: var(--muted); }
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.live { color: var(--accent); background: var(--accent-soft); }
.pill.live .dot { animation: blink 1.4s ease-in-out infinite; }
.pill.waiting, .pill.stalled { color: var(--mod); background: color-mix(in srgb, var(--mod) 14%, transparent); }
.pill.done { color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); }
.pill.error { color: var(--del); background: color-mix(in srgb, var(--del) 14%, transparent); }
.status small { font-size: 11.5px; }
.steps { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; color: var(--hunk); }
.stats { display: inline-flex; gap: 6px; font-size: 11.5px; }
.stats .add { color: var(--add); }
.stats .del { color: var(--del); }

.detail { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.acard.live .detail { color: var(--text); }
.detail.err { color: var(--del); }
.detail.warn { color: var(--mod); }
/* etapas do checklist como barrinhas */
.track-steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 3px; }
.track-steps li { flex: 1; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--faint) 25%, transparent); }
.track-steps li.done { background: var(--add); }
.track-steps li.skipped { background: color-mix(in srgb, var(--faint) 50%, transparent); }
.track-steps li.failed { background: var(--del); }
.track-steps li.now { background: var(--hunk); animation: blink 1.2s ease-in-out infinite; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 11px; padding: 2px 7px; border-radius: 6px; background: var(--panel-2); color: var(--muted); }
.chip.ok { color: var(--add); background: color-mix(in srgb, var(--add) 12%, transparent); }
.chip.bad { color: var(--del); background: color-mix(in srgb, var(--del) 12%, transparent); }
.chip.warn { color: var(--mod); background: color-mix(in srgb, var(--mod) 12%, transparent); }

.foot { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.gap { flex: 1; }
.retry { height: 26px; }
.nudge { height: 26px; color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); background: color-mix(in srgb, var(--mod) 10%, transparent); }
.pin { opacity: 0; color: var(--faint); }
.acard:hover .pin, .pin.pinned { opacity: 1; }
.pin.pinned { color: var(--accent); }
.acard:hover :deep(.win-btn) { opacity: 1; }
.go { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; color: var(--faint); }
.go.on { color: var(--accent); background: var(--accent-soft); }
/* o cartão de pergunta, sem a própria moldura */
.acard :deep(.ask-in) { width: 100%; max-width: none; box-sizing: border-box; padding: 0; border: 0; background: transparent; }
</style>
