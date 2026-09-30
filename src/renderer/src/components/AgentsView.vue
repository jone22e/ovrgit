<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { AgentAction, AgentMode, AgentSnapshot } from '@shared/types'
import { api, state } from '../store'
import AgentLogo from './AgentLogo.vue'
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
const working = computed(() => byStatus('live').sort((a, b) => a.since - b.since))
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
const show = (a: AgentSnapshot) => api.agentShow(a.uid).catch(() => undefined)

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
const closeDone = () => api.agentClose(done.value.map((a) => a.uid)).catch(() => undefined)
</script>

<template>
  <div class="agents">
    <div class="toolbar"><PaneSwitch /></div>

    <div class="scroll">
      <header class="head">
        <strong>{{ snaps.length }} {{ snaps.length === 1 ? 'janela' : 'janelas' }}</strong>
        <span v-if="working.length" class="count"><span class="dot live" />{{ working.length }} trabalhando</span>
        <span v-if="byStatus('waiting').length" class="count"><span class="dot waiting" />{{ byStatus('waiting').length }} aguardando</span>
        <span v-if="byStatus('error').length" class="count"><span class="dot error" />{{ byStatus('error').length }} falhou</span>
        <span v-if="done.length" class="count"><span class="dot done" />{{ done.length }} {{ done.length === 1 ? 'concluído' : 'concluídos' }}</span>
        <span class="gap" />
        <button :disabled="!snaps.length || arranging" title="Coloca as janelas de agente no grid de cada tela, lado a lado" @click="arrange">
          <span v-if="arranging" class="spinner" />
          <Icon v-else name="grid" :size="13" />
          Organizar janelas
        </button>
        <button :disabled="!done.length" title="Fecha as janelas dos agentes que já terminaram (a conversa fica em Conversas)" @click="closeDone">Fechar concluídos</button>
      </header>

      <p v-if="!snaps.length" class="empty faint">Nenhuma janela de agente aberta.</p>

      <!-- precisa de você: perguntas, aprovação do plano, falhas -->
      <section v-if="needYou.length">
        <h3 class="sec waiting">Precisa de você</h3>
        <article v-for="a in needYou" :key="a.uid" class="card" :class="a.status">
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

          <template v-if="a.ask">
            <p class="q">
              {{ a.ask.kind === 'plan' ? 'Deseja iniciar a implementação do plano?' : a.ask.text }}
              <small v-if="a.ask.kind === 'question' && a.ask.total > 1" class="faint">{{ a.ask.index + 1 }} de {{ a.ask.total }}</small>
            </p>
            <div class="opts">
              <template v-if="a.ask.kind === 'plan'">
                <button v-for="(o, i) in a.ask.options" :key="o.mode" class="opt" :class="{ first: i === 0 }" @click="act(a, { type: 'plan', mode: o.mode })">
                  <span class="num">{{ i + 1 }}</span><span class="lbl">{{ o.label }}</span><small class="faint ellipsis">{{ o.detail }}</small>
                </button>
                <button class="opt" @click="act(a, { type: 'keepPlanning' })">
                  <span class="num">{{ a.ask.options.length + 1 }}</span><span class="lbl">Continuar planejando</span><small class="faint">mantém no modo Plano</small>
                </button>
              </template>
              <template v-else>
                <button v-for="(o, i) in a.ask.options" :key="o.label" class="opt" :class="{ first: o.recommended }" @click="act(a, { type: 'decide', choice: o.label })">
                  <span class="num">{{ i + 1 }}</span><span class="lbl">{{ o.label }}</span><small v-if="o.detail" class="faint ellipsis">{{ o.detail }}</small>
                </button>
              </template>
            </div>
            <form class="reply" @submit.prevent="reply(a)">
              <button v-if="a.ask.kind === 'plan'" type="button" class="ghost link" @click="planUid = a.uid">Ver plano</button>
              <span v-if="a.ask.kind === 'plan'" class="faint">·</span>
              <input v-model="replies[a.uid]" type="text" :placeholder="a.ask.kind === 'plan' ? 'ou digite um ajuste…' : 'ou responda com as suas palavras…'" maxlength="2000" />
              <button v-if="(replies[a.uid] ?? '').trim()" type="submit" class="small primary">Enviar</button>
              <button v-else-if="a.ask.kind === 'question'" type="button" class="ghost small" @click="act(a, { type: 'decide', choice: null })">Pular</button>
            </form>
          </template>
        </article>
      </section>

      <section v-if="working.length">
        <h3 class="sec live">Trabalhando</h3>
        <div v-for="a in working" :key="a.uid" class="item" @click="show(a)">
          <span class="dot live" />
          <span class="text">
            <strong class="ellipsis">{{ a.title }}</strong>
            <small class="faint ellipsis">{{ a.project }} · {{ a.activity || 'Trabalhando…' }}</small>
          </span>
          <small class="faint when">{{ ago(a.since) }}</small>
          <Icon name="external" :size="13" class="go" />
        </div>
      </section>

      <section v-if="done.length">
        <h3 class="sec done">Concluídos <small class="faint">mais recente primeiro</small></h3>
        <div v-for="a in done" :key="a.uid" class="item" @click="show(a)">
          <span class="dot done" />
          <span class="text">
            <strong class="ellipsis">{{ a.title }}</strong>
            <small class="faint ellipsis">{{ a.summary || a.project }}</small>
          </span>
          <span v-if="a.files && (a.files.add || a.files.del)" class="stats mono">
            <span v-if="a.files.add" class="add">+{{ a.files.add }}</span>
            <span v-if="a.files.del" class="del">−{{ a.files.del }}</span>
          </span>
          <small class="faint when">{{ ago(a.since) }}</small>
          <Icon name="external" :size="13" class="go" />
        </div>
      </section>

      <section v-if="idle.length">
        <h3 class="sec">Sem conversa</h3>
        <div v-for="a in idle" :key="a.uid" class="item" @click="show(a)">
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
.toolbar { display: flex; align-items: center; flex: none; box-sizing: border-box; height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border); }
.scroll { flex: 1; overflow: auto; padding: 0 16px 24px; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.head strong { font-size: 14px; }
.count { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.gap { flex: 1; }
.head button { height: 28px; gap: 6px; font-size: 12.5px; }
.empty { margin: 24px 0; text-align: center; font-size: 13px; }

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

.q { margin: 0; font-size: 13.5px; }
.q small { margin-left: 6px; font-size: 11.5px; }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { height: auto; min-height: 36px; justify-content: flex-start; gap: 10px; padding: 6px 10px; border-radius: 8px; text-align: left; white-space: normal; }
.opt.first { border-color: color-mix(in srgb, var(--mod) 55%, var(--border)); background: color-mix(in srgb, var(--mod) 8%, var(--panel)); }
.opt .num { flex: none; width: 20px; height: 20px; border-radius: 5px; background: var(--panel-2); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
.opt .lbl { font-weight: 600; font-size: 13px; flex: none; }
.opt small { font-size: 12px; min-width: 0; }
.reply { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.reply input { flex: 1; border: 0; background: transparent; padding: 4px 0; font-size: 12.5px; }
.reply input:focus { box-shadow: none; }
.link { height: auto; padding: 0; color: var(--muted); font-size: 12.5px; }
.link:hover:not(:disabled) { background: transparent; color: var(--accent); }

.item { display: flex; align-items: center; gap: 12px; padding: 9px 8px; border-radius: 8px; cursor: pointer; min-width: 0; }
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
