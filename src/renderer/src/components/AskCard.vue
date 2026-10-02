<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AgentAsk, AgentMode } from '@shared/types'
import Icon from './Icon.vue'

/**
 * Cartão do que o agente espera do usuário: uma pergunta (opções, "outra resposta" e pular) ou a aprovação do
 * plano (modos para implementar, continuar planejando, ajuste). O mesmo cartão na janela do agente e no
 * gerenciador de agentes; quem usa executa as escolhas.
 */
const props = defineProps<{
  ask: AgentAsk
  /** Nome do agente no campo de resposta ("diga ao ChatGPT…") */
  agent: string
  /** Pergunta: opção já escolhida na pergunta em exibição */
  current?: string | null
}>()
const emit = defineEmits<{
  decide: [choice: string | null]
  plan: [mode: AgentMode]
  adjust: [text: string]
  seePlan: []
  close: []
  nav: [index: number]
}>()

const other = ref('')
watch(
  () => (props.ask.kind === 'question' ? `q:${props.ask.index}:${props.ask.text}` : 'plan'),
  () => (other.value = '')
)
function submit() {
  const text = other.value.trim()
  if (!text) return
  other.value = ''
  if (props.ask.kind === 'plan') emit('adjust', text)
  else emit('decide', text)
}
</script>

<template>
  <div v-if="ask.kind === 'question'" class="ask">
    <div class="ask-head">
      <p class="ask-q">{{ ask.text }}</p>
      <span v-if="ask.total > 1" class="ask-nav">
        <button type="button" class="ghost nav" title="Pergunta anterior" :disabled="ask.index === 0" @click="emit('nav', ask.index - 1)"><Icon name="chevron" :size="13" class="prev" /></button>
        <span class="ask-count">{{ ask.index + 1 }} de {{ ask.total }}</span>
        <button type="button" class="ghost nav" title="Próxima pergunta" :disabled="ask.index === ask.total - 1" @click="emit('nav', ask.index + 1)"><Icon name="chevron" :size="13" /></button>
      </span>
      <button type="button" class="ghost nav" title="Fechar: responda pelo campo de mensagem" @click="emit('close')"><Icon name="x" :size="13" /></button>
    </div>
    <div class="ask-opts">
      <button v-for="(o, i) in ask.options" :key="o.label" type="button" class="ghost ask-opt" :class="{ cur: current === o.label }" @click="emit('decide', o.label)">
        <span class="num">{{ i + 1 }}</span>
        <span class="opt-body">
          <span class="opt-label">{{ o.label }}<span v-if="o.recommended" class="pill">Recomendado</span></span>
          <span v-if="o.detail" class="opt-detail">{{ o.detail }}</span>
        </span>
      </button>
    </div>
    <form class="ask-other" @submit.prevent="submit">
      <Icon name="pencil" :size="13" class="pen" />
      <input v-model="other" type="text" :placeholder="`Não, e diga ao ${agent} o que fazer diferente`" maxlength="2000" />
      <button v-if="other.trim()" type="submit" class="small primary">Responder</button>
      <button v-else type="button" class="small skip" @click="emit('decide', null)">Pular</button>
    </form>
  </div>

  <div v-else class="ask">
    <div class="ask-head">
      <p class="ask-q">{{ ask.title ?? 'Deseja iniciar a implementação do plano?' }}</p>
      <button type="button" class="ghost small see-plan" title="Abrir para leitura" @click="emit('seePlan')"><Icon name="clipboard" :size="12" /> {{ ask.see ?? 'Ver plano' }}</button>
      <button type="button" class="ghost nav" title="Fechar: continue pelo campo de mensagem" @click="emit('close')"><Icon name="x" :size="13" /></button>
    </div>
    <div class="ask-opts">
      <button v-for="(o, i) in ask.options" :key="o.mode" type="button" class="ghost ask-opt" @click="emit('plan', o.mode)">
        <span class="num">{{ i + 1 }}</span>
        <span class="opt-body">
          <span class="opt-label">{{ o.label }}<span v-if="o.pill" class="pill">{{ o.pill }}</span></span>
          <span class="opt-detail">{{ o.detail }}</span>
        </span>
      </button>
      <button type="button" class="ghost ask-opt" @click="emit('close')">
        <span class="num">{{ ask.options.length + 1 }}</span>
        <span class="opt-body">
          <span class="opt-label">{{ ask.stay?.label ?? 'Não, continuar planejando' }}</span>
          <span class="opt-detail">{{ ask.stay?.detail ?? 'Fecha este cartão; a conversa segue no modo Plano.' }}</span>
        </span>
      </button>
    </div>
    <form class="ask-other" @submit.prevent="submit">
      <Icon name="pencil" :size="13" class="pen" />
      <input v-model="other" type="text" :placeholder="ask.adjustHint ?? `Não, e diga ao ${agent} o que ajustar no plano`" maxlength="2000" />
      <button v-if="other.trim()" type="submit" class="small primary">Enviar</button>
    </form>
  </div>
</template>

<style scoped>
.ask { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 12px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel); max-width: 640px; }
.ask-head { display: flex; align-items: flex-start; gap: 8px; }
.see-plan { flex: none; gap: 5px; color: var(--accent); }
.ask-q { margin: 0; flex: 1; min-width: 0; font-size: calc(var(--agent-size, 14px) + 0.5px); font-weight: 600; line-height: 1.45; user-select: text; }
.ask-nav { display: inline-flex; align-items: center; gap: 2px; flex: none; color: var(--muted); }
.ask-count { font-size: 11.5px; padding: 0 4px; font-variant-numeric: tabular-nums; }
.nav { width: 22px; height: 22px; padding: 0; border-radius: 6px; color: var(--muted); flex: none; }
.nav:hover:not(:disabled) { color: var(--text); }
.nav:disabled { opacity: 0.3; }
.nav .prev { transform: rotate(180deg); }
.ask-opts { display: flex; flex-direction: column; gap: 2px; }
.ask-opt { height: auto; padding: 7px 8px; border-radius: 10px; justify-content: flex-start; align-items: flex-start; gap: 12px; text-align: left; white-space: normal; color: var(--text); }
.ask-opt.cur { background: var(--accent-soft); }
.ask-opt .num { width: 20px; height: 20px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 11px; font-weight: 600; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); margin-top: 1px; }
.ask-opt:hover .num, .ask-opt.cur .num { color: var(--text); border-color: var(--accent); }
.opt-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.opt-label { font-size: var(--agent-size, 14px); font-weight: 600; line-height: 1.45; }
.opt-detail { font-size: calc(var(--agent-size, 14px) - 1px); line-height: 1.45; color: var(--muted); font-weight: 400; }
.pill { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); vertical-align: 1px; }
.ask-other { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 6px 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); }
.ask-other:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.ask-other .pen { color: var(--faint); flex: none; }
.ask-other input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; padding: 0; font-size: calc(var(--agent-size, 14px) - 0.5px); }
.ask-other input:focus { box-shadow: none; }
.ask-other .small { height: 26px; border-radius: 999px; flex: none; }
.ask-other .skip { background: var(--panel); }
</style>
