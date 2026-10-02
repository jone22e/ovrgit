<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AgentEffort, AgentMode, AgentSnapshot, KnownModels } from '@shared/types'
import { MODES } from '@shared/models'
import Icon from './Icon.vue'
import ModelPicker from './ModelPicker.vue'

/**
 * Campo de instrução do gerenciador de agentes, com a cara do composer da janela do agente: texto de várias
 * linhas, modelo e esforço, modo e o botão redondo de enviar. Começa com o que a janela está usando; o que for
 * trocado aqui vale para a janela também.
 */
const props = defineProps<{ agent: AgentSnapshot; known: KnownModels | null; placeholder?: string }>()
const emit = defineEmits<{ send: [text: string, opts: { model: string; effort: AgentEffort; mode: AgentMode }] }>()

const text = ref('')
const box = ref<HTMLTextAreaElement>()
const provider = ref(props.agent.provider)
const model = ref(props.agent.modelId)
const effort = ref<AgentEffort>(props.agent.effort)
const mode = ref<AgentMode>(props.agent.mode)
// a janela mudou de modelo/modo (ou é outro agente): o campo acompanha
watch(
  () => [props.agent.uid, props.agent.modelId, props.agent.effort, props.agent.mode] as const,
  ([, m, e, md]) => ((model.value = m), (effort.value = e), (mode.value = md))
)
const modeOpen = ref(false)
const modeRoot = ref<HTMLElement>()
const currentMode = computed(() => MODES.find((m) => m.id === mode.value) ?? MODES[1])
const canSend = computed(() => !!text.value.trim())

function autosize() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}
function send() {
  const t = text.value.trim()
  if (!t) return
  emit('send', t, { model: model.value, effort: effort.value, mode: mode.value })
  text.value = ''
  nextTick(autosize)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
const onDoc = (e: MouseEvent) => {
  if (modeOpen.value && modeRoot.value && !modeRoot.value.contains(e.target as Node)) modeOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div class="mini" @click.stop>
    <textarea ref="box" v-model="text" rows="1" :placeholder="placeholder ?? 'Próxima instrução para este agente…'" maxlength="4000" @input="autosize" @keydown="onKey" />
    <div class="row">
      <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" providers lock-provider :known="known" />
      <div ref="modeRoot" class="mode-menu">
        <button type="button" class="chip mode-chip" :class="[`m-${mode}`, { on: modeOpen }]" :title="`${currentMode.label}: ${currentMode.hint}`" :aria-label="currentMode.label" @click="modeOpen = !modeOpen">
          <Icon :name="currentMode.icon" :size="13" />
        </button>
        <div v-if="modeOpen" class="pop">
          <button v-for="m in MODES" :key="m.id" type="button" class="ghost opt" :class="{ cur: mode === m.id }" @click="(mode = m.id), (modeOpen = false)">
            <Icon :name="m.icon" :size="13" />
            <span class="opt-text"><strong>{{ m.label }}</strong><small>{{ m.hint }}</small></span>
            <Icon v-if="mode === m.id" name="check" :size="13" class="ok" />
          </button>
        </div>
      </div>
      <slot name="actions" />
      <span class="spacer" />
      <button type="button" class="icon send primary" title="Enviar (Enter)" :disabled="!canSend" @click="send"><Icon name="up" :size="16" /></button>
    </div>
  </div>
</template>

<style scoped>
.mini {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 6px; border-radius: 16px;
  background: var(--panel); border: 1px solid var(--border); min-width: 0;
}
.mini:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
textarea { border: 0; background: transparent; padding: 4px 6px 2px; font-size: 13px; line-height: 1.45; max-height: 160px; overflow-y: auto; resize: none; width: 100%; }
textarea:focus { box-shadow: none; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.spacer { flex: 1 1 auto; }
.chip { height: 30px; padding: 0 10px; gap: 6px; border-radius: 999px; font-size: 12px; color: var(--muted); flex: none; }
.chip.mode-chip { width: 30px; padding: 0; justify-content: center; }
.chip.m-full { color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); }
.chip.m-plan, .chip.m-checklist { color: var(--hunk); border-color: color-mix(in srgb, var(--hunk) 45%, var(--border)); }
.chip.on { background: var(--hover); }
.mode-menu { position: relative; flex: none; }
.pop {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30; width: 300px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.opt { justify-content: flex-start; gap: 10px; height: auto; padding: 8px 10px; text-align: left; white-space: normal; color: var(--text); }
.opt.cur { background: var(--accent-soft); }
.opt-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.opt-text strong { font-size: 12.5px; }
.opt-text small { font-size: 11px; color: var(--muted); line-height: 1.35; }
.opt .ok { color: var(--accent); flex: none; }
.send { width: 32px; height: 32px; border-radius: 50%; flex: none; }
</style>
