<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AgentEffort, CliProvider, KnownModels, ProviderStatus } from '@shared/types'
import { api, state, toast } from '../store'
import { AGENT_PREFS, readAgentPrefs, type AgentPrefs } from '../agentPrefs'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import ModelPicker from './ModelPicker.vue'

/**
 * "Agente em espera": escolhe a IA, o modelo, o esforço e o repositório; os agentes nascem prontos, sem conversa,
 * e ficam à espera de tarefas da fila. Nada é enviado a eles aqui.
 */
const emit = defineEmits<{ close: [] }>()

const prefs = readAgentPrefs()
const provider = ref<CliProvider>(prefs.provider)
const model = ref(prefs.model[prefs.provider])
const effort = ref<AgentEffort>(prefs.effort[prefs.provider])
const defaults = Object.fromEntries((['claude', 'codex', 'agy'] as CliProvider[]).map((p) => [p, { model: prefs.model[p], effort: prefs.effort[p] }]))
const known = ref<KnownModels | null>(null)
const detected = ref<ProviderStatus | null>(null)
/** Repositórios: o aberto e os recentes */
const projects = ref<string[]>([])
const cwd = ref(state.repo?.root ?? '')
const count = ref(1)
const opening = ref(false)
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const options = computed(() => [...new Set([state.repo?.root ?? '', ...projects.value].filter(Boolean))])

onMounted(async () => {
  ;[known.value, detected.value, projects.value] = await Promise.all([api.knownModels().catch(() => null), api.detectProviders().catch(() => null), api.agentProjects().catch(() => [])])
})

const CLI_NAME: Record<CliProvider, string> = { claude: 'Claude Code', codex: 'Codex CLI', agy: 'Antigravity CLI' }

async function open() {
  if (!cwd.value) return
  if (detected.value && !detected.value[provider.value]) return toast(`${CLI_NAME[provider.value]} não foi encontrado neste computador.`)
  opening.value = true
  try {
    localStorage.setItem(AGENT_PREFS, JSON.stringify({ ...prefs, provider: provider.value, model: { ...prefs.model, [provider.value]: model.value }, effort: { ...prefs.effort, [provider.value]: effort.value } } satisfies AgentPrefs))
    for (let i = 0; i < count.value; i++) await api.agentOpen({ provider: provider.value, model: model.value, effort: effort.value, mode: 'full', cwd: cwd.value, standby: true, quiet: true })
    toast(count.value === 1 ? 'Agente em espera pronto.' : `${count.value} agentes em espera prontos.`)
    emit('close')
  } catch (e) {
    state.error = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <Modal title="Agente em espera" :width="520" @close="emit('close')">
    <p class="faint intro">Nasce pronto, sem conversa, e pega a próxima tarefa da fila. Você também pode falar com ele quando quiser.</p>
    <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" inline providers :known="known" :defaults="defaults" />
    <p v-if="detected && !detected[provider]" class="bad">{{ CLI_NAME[provider] }} não foi encontrado neste computador.</p>
    <div class="row">
      <label class="field">
        <span class="lbl">Repositório</span>
        <select v-model="cwd">
          <option v-for="p in options" :key="p" :value="p">{{ name(p) }}</option>
        </select>
      </label>
      <label class="field qty">
        <span class="lbl">Quantos</span>
        <select v-model.number="count">
          <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
    </div>
    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" :disabled="opening || !cwd" @click="open">
        <span v-if="opening" class="spinner" />
        <Icon v-else name="bot" :size="14" />
        {{ count === 1 ? 'Deixar em espera' : `Deixar ${count} em espera` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.intro { margin: 0; font-size: 12.5px; line-height: 1.5; }
.row { display: flex; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.field.qty { flex: 0 0 90px; }
.lbl { font-size: 12px; color: var(--muted); }
select { height: 32px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 13px; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
