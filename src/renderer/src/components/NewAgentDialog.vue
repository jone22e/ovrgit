<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { DEFAULT_EFFORT, DEFAULT_MODEL, MODES, PROVIDER_LABEL } from '@shared/models'
import type { AgentEffort, AgentMode, CliProvider, KnownModels, ProviderStatus } from '@shared/types'
import { api, beginTask, state, taskBrief, toast } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import ModelPicker from './ModelPicker.vue'

/** "Novo agente": escolhe Claude ou ChatGPT, modelo, esforço e a primeira tarefa; abre uma janela só do agente. */
const emit = defineEmits<{ close: [] }>()

const PREFS = 'ovrgit.agent.prefs'
interface Prefs { provider: CliProvider; model: Record<CliProvider, string>; effort: Record<CliProvider, AgentEffort>; mode: AgentMode }
function readPrefs(): Prefs {
  const base: Prefs = { provider: 'codex', model: { ...DEFAULT_MODEL }, effort: { ...DEFAULT_EFFORT }, mode: 'safe' }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>
    return { ...base, ...saved, model: { ...base.model, ...saved.model }, effort: { ...base.effort, ...saved.effort } }
  } catch {
    return base
  }
}
const prefs = readPrefs()
const provider = ref<CliProvider>(prefs.provider)
const model = ref(prefs.model[prefs.provider])
const effort = ref<AgentEffort>(prefs.effort[prefs.provider])
const mode = ref<AgentMode>(prefs.mode)

const known = ref<KnownModels | null>(null)
const detected = ref<ProviderStatus | null>(null)
const opening = ref(false)


// o seletor lembra o último modelo/esforço de cada IA durante o diálogo; aqui entram os guardados entre sessões
const defaults = Object.fromEntries((['claude', 'codex', 'agy'] as CliProvider[]).map((p) => [p, { model: prefs.model[p], effort: prefs.effort[p] }]))

onMounted(async () => {
  ;[known.value, detected.value] = await Promise.all([api.knownModels().catch(() => null), api.detectProviders().catch(() => null)])
})


const CLI_NAME: Record<CliProvider, string> = { claude: 'Claude Code', codex: 'Codex CLI', agy: 'Antigravity CLI' }
const INSTALL: Record<CliProvider, string> = {
  claude: 'Instale em claude.com/claude-code.',
  codex: 'Instale com "npm i -g @openai/codex".',
  agy: 'Instale o Antigravity (Google) e rode "agy" uma vez para entrar.'
}
void PROVIDER_LABEL

/** Tarefa do Ovseer a executar (vinda de "Iniciar com agente" no painel de tarefas) */
const task = ref(state.newAgentTask)
/** Pedido pronto (ex.: resolver conflitos do merge) */
const brief = ref(state.newAgentBrief)

async function openAgent() {
  if (!state.repo) return
  if (detected.value && !detected.value[provider.value]) {
    toast(`${CLI_NAME[provider.value]} não foi encontrado neste computador.`)
    return
  }
  opening.value = true
  try {
    let firstMessage: string | undefined
    if (task.value) {
      // plano aprovado vira o pedido; a linha de trabalho da tarefa é criada como no botão "Começar"
      const detail = await api.ovseerTaskDetail(task.value.id).catch(() => null)
      firstMessage = taskBrief(task.value, detail?.plan ?? '')
      await beginTask(task.value, detail ?? undefined)
    } else if (brief.value) firstMessage = brief.value.message
    localStorage.setItem(
      PREFS,
      JSON.stringify({ provider: provider.value, model: { ...prefs.model, [provider.value]: model.value }, effort: { ...prefs.effort, [provider.value]: effort.value }, mode: mode.value } satisfies Prefs)
    )
    await api.agentOpen({
      provider: provider.value,
      model: model.value,
      effort: effort.value,
      mode: mode.value,
      cwd: state.repo.root,
      firstMessage
    })
    emit('close')
  } catch (e) {
    state.error = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    opening.value = false
  }
}

// ⌘/Ctrl+Enter abre o agente
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    openAgent()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Modal title="Novo agente" :width="520" @close="emit('close')">
    <p class="where">
      <Icon name="folder" :size="13" class="faint" />
      Trabalha em <strong>{{ state.repo?.name }}</strong>
      <span v-if="state.repo?.branch" class="faint"> · <Icon name="branch" :size="11" /> {{ state.repo.branch }}</span>
    </p>
    <div v-if="task" class="task">
      <Icon name="task" :size="14" class="faint" />
      <span class="task-text">
        <span><span class="key mono">{{ task.key }}</span> {{ task.title }}</span>
        <small class="faint">O agente recebe o plano aprovado como primeira mensagem, e a linha de trabalho da tarefa é criada antes.</small>
      </span>
      <button type="button" class="ghost icon small" title="Abrir sem tarefa" @click="task = null"><Icon name="x" :size="12" /></button>
    </div>
    <div v-if="brief" class="task">
      <Icon name="merge" :size="14" class="faint" />
      <span class="task-text">
        <span>{{ brief.label }}</span>
        <small class="faint">O agente recebe a lista de conflitos e a orientação de resolver sem commitar; você conclui pelo OvrGit.</small>
      </span>
      <button type="button" class="ghost icon small" title="Abrir sem esse pedido" @click="brief = null"><Icon name="x" :size="12" /></button>
    </div>

    <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" inline providers :known="known" :defaults="defaults" />
    <p v-if="detected && !detected[provider]" class="bad">
      {{ CLI_NAME[provider] }} não foi encontrado. {{ INSTALL[provider] }}
    </p>

    <div>
      <div class="lbl">Permissões</div>
      <div class="modes">
        <button v-for="m in MODES" :key="m.id" type="button" class="mode" :class="{ active: mode === m.id }" @click="mode = m.id">
          <span class="name"><Icon :name="m.icon" :size="13" /> {{ m.label }}</span>
          <span class="hint">{{ m.hint }}</span>
        </button>
      </div>
    </div>

    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" :disabled="opening" @click="openAgent">
        <span v-if="opening" class="spinner" />
        <Icon v-else name="bot" :size="14" />
        Abrir agente
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.where { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 12.5px; flex-wrap: wrap; }
.task { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--accent); background: var(--accent-soft); border-radius: 10px; }
.task-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; }
.task-text small { font-weight: 400; font-size: 11.5px; line-height: 1.35; }
.task .key { color: var(--accent); font-size: 11px; font-weight: 800; margin-right: 4px; }
.task .icon.small { width: 24px; height: 24px; flex: none; }
.lbl { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.modes { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.mode { height: auto; padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; white-space: normal; }
.mode.active { border-color: var(--accent); background: var(--accent-soft); }
.mode .name { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.mode .hint { font-size: 11.5px; color: var(--muted); font-weight: 400; line-height: 1.35; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
textarea { font-size: 13px; line-height: 1.45; }
</style>
