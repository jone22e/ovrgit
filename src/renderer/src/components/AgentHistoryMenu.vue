<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { catalogOf, modelLabel } from '@shared/models'
import type { AgentHistoryItem, KnownModels } from '@shared/types'
import { api, state, toast } from '../store'
import AgentLogo from './AgentLogo.vue'
import Icon from './Icon.vue'

/** Conversas de agentes abertas pelo OvrGit neste projeto: reabrir (mesma sessão do CLI) ou esquecer. */
const open = ref(false)
const root = ref<HTMLElement>()
const items = ref<AgentHistoryItem[]>([])
const known = ref<KnownModels | null>(null)
const loading = ref(false)
const query = ref('')

const list = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? items.value.filter((i) => `${i.title} ${i.model}`.toLowerCase().includes(q)) : items.value
})

async function load() {
  if (!state.repo) return
  loading.value = true
  try {
    ;[items.value, known.value] = await Promise.all([api.agentHistory(state.repo.root), known.value ? Promise.resolve(known.value) : api.knownModels().catch(() => null)])
  } finally {
    loading.value = false
  }
}
watch(open, (v) => v && load())
// janelas de agente abertas/fechadas: atualiza o selo "aberta"
watch(() => state.agentWindows.length, () => open.value && load())

async function reopen(h: AgentHistoryItem) {
  open.value = false
  if (await api.agentFocus(h.sessionId)) return
  try {
    await api.agentOpen({ provider: h.provider, model: h.model, effort: h.effort, mode: h.mode, cwd: h.cwd, resumeId: h.sessionId })
  } catch (e) {
    state.error = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  }
}
async function forget(h: AgentHistoryItem) {
  await api.agentForget(h.sessionId)
  items.value = items.value.filter((x) => x.sessionId !== h.sessionId)
  toast('Conversa esquecida.')
}
function when(ms: number) {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="hist-menu">
    <button class="ghost trigger" :class="{ on: open }" :disabled="!state.repo" title="Conversas anteriores com agentes neste projeto" @click="open = !open">
      <Icon name="history" :size="15" />
      <span class="trigger-label">Conversas</span>
    </button>
    <div v-if="open" class="pop">
      <header>
        <strong>Conversas em {{ state.repo?.name }}</strong>
        <span v-if="loading" class="spinner" />
      </header>
      <div v-if="items.length > 6" class="search">
        <Icon name="search" :size="13" class="faint" />
        <input v-model="query" type="text" placeholder="Buscar conversa" spellcheck="false" />
      </div>
      <p v-if="!items.length && !loading" class="faint empty">
        Nenhuma conversa guardada ainda. Elas entram aqui depois da primeira resposta do agente.
      </p>
      <div class="list">
        <div v-for="h in list" :key="h.sessionId" class="item" @click="reopen(h)">
          <AgentLogo :source="h.provider" :size="14" />
          <span class="text">
            <span class="ellipsis title">{{ h.title }}</span>
            <small class="faint">{{ modelLabel(h.provider, h.model, catalogOf(known, h.provider)) }} · {{ h.turns }} {{ h.turns === 1 ? 'mensagem' : 'mensagens' }} · {{ when(h.updatedAt) }}</small>
          </span>
          <span v-if="state.agentWindows.includes(h.sessionId)" class="badge accent">aberta</span>
          <button class="ghost rm" title="Esquecer esta conversa" @click.stop="forget(h)"><Icon name="x" :size="12" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hist-menu { position: relative; -webkit-app-region: no-drag; }
.trigger { height: 32px; padding: 0 10px 0 8px; gap: 6px; border-radius: var(--radius); font-size: 12.5px; color: var(--text); }
.trigger.on { color: var(--accent); background: var(--accent-soft); }
@media (max-width: 760px) { .trigger-label { display: none; } .trigger { width: 32px; padding: 0; } }
.pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; width: min(420px, calc(100vw - 24px));
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  max-height: min(70vh, 560px); overflow: auto; padding: 6px; animation: drop 0.12s ease-out; display: flex; flex-direction: column; gap: 4px;
}
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 8px 4px; font-size: 13px; }
.search { display: flex; align-items: center; gap: 8px; margin: 2px 4px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.search input { border: 0; background: transparent; padding: 6px 0; outline: none; font-size: 12.5px; }
.search input:focus { box-shadow: none; }
.empty { margin: 4px 8px 8px; font-size: 12px; line-height: 1.4; }
.list { display: flex; flex-direction: column; gap: 1px; }
.item { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; min-width: 0; }
.item:hover { background: var(--hover); }
.text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.title { font-size: 12.5px; font-weight: 600; }
.text small { font-size: 11px; }
.rm { width: 24px; height: 24px; padding: 0; color: var(--faint); opacity: 0; flex: none; }
.item:hover .rm { opacity: 1; }
</style>
