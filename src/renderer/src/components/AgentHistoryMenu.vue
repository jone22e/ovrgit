<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { catalogOf, modelLabel } from '@shared/models'
import type { AgentHistoryItem, AgentStatus, KnownModels } from '@shared/types'
import { api, state, toast } from '../store'
import AgentLogo from './AgentLogo.vue'
import Icon from './Icon.vue'

/** Conversas de agentes abertas pelo Ovseer neste projeto: reabrir (mesma sessão do CLI) ou esquecer. */
const open = ref(false)
const root = ref<HTMLElement>()
const items = ref<AgentHistoryItem[]>([])
const known = ref<KnownModels | null>(null)
const loading = ref(false)
const query = ref('')
/** Escopo da lista: só o repositório aberto ou as conversas de todos (a escolha fica guardada) */
const SCOPE_KEY = 'ovseer.agentHistory.scope'
const readScope = () => {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all'
  } catch {
    return false
  }
}
const allRepos = ref(readScope())
function setScope(all: boolean) {
  if (allRepos.value === all) return
  allRepos.value = all
  try {
    localStorage.setItem(SCOPE_KEY, all ? 'all' : 'repo')
  } catch {
    /* sem armazenamento: vale só para esta sessão */
  }
  load()
}

const list = computed(() => {
  const q = query.value.trim().toLowerCase()
  const all = q ? items.value.filter((i) => `${i.title} ${i.model} ${allRepos.value ? i.project : ''}`.toLowerCase().includes(q)) : items.value
  // fixadas no topo; entre iguais, as mais recentes
  return [...all].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
})
/** Rótulo do grupo de cada conversa (fixadas, de hoje, anteriores): aparece como separador na primeira de cada grupo */
const groupOf = (h: AgentHistoryItem) => (h.pinned ? 'Fixadas' : new Date(h.updatedAt).toDateString() === new Date().toDateString() ? 'Hoje' : 'Anteriormente')
const rows = computed(() => list.value.map((h, i, all) => ({ h, label: i && groupOf(all[i - 1]) === groupOf(h) ? '' : groupOf(h) })))

/**
 * Situação da conversa: com a janela aberta, a que ela informa agora; fechada, a última gravada.
 * Fechada não pode estar trabalhando (o agente para junto com a janela), então vira "interrompida".
 */
function statusOf(h: AgentHistoryItem): AgentStatus | 'stopped' | 'unknown' {
  if (state.agentWindows.includes(h.sessionId)) return state.agentStatuses[h.sessionId] ?? h.status ?? 'unknown'
  if (!h.status || h.status === 'idle') return 'unknown'
  return h.status === 'live' ? 'stopped' : h.status
}
const STATUS_LABEL: Record<ReturnType<typeof statusOf>, string> = {
  idle: 'Sem conversa',
  live: 'Trabalhando',
  waiting: 'Aguardando a sua resposta',
  done: 'Concluído',
  error: 'Falhou',
  stopped: 'Interrompida ao fechar a janela',
  unknown: 'Sem registro da situação'
}

async function load() {
  if (!state.repo) return
  loading.value = true
  try {
    items.value = await api.agentHistory(allRepos.value ? undefined : state.repo.root)
  } finally {
    loading.value = false
  }
  // o catálogo de modelos consulta o CLI (pode levar segundos na primeira vez): a lista aparece antes,
  // com os nomes que já conhecemos, e ganha os rótulos do catálogo quando ele chegar
  if (!known.value && !loadingKnown) {
    loadingKnown = true
    api.knownModels()
      .then((k) => (known.value = k))
      .catch(() => null)
      .finally(() => (loadingKnown = false))
  }
}
let loadingKnown = false
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
async function pin(h: AgentHistoryItem) {
  const pinned = !h.pinned
  h.pinned = pinned
  await api.agentPin(h.sessionId, pinned)
  toast(pinned ? 'Conversa fixada no topo.' : 'Conversa solta.')
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
        <strong class="ellipsis">{{ allRepos ? 'Todas as conversas' : `Conversas em ${state.repo?.name}` }}</strong>
        <span v-if="loading" class="spinner" />
        <span class="scope">
          <button class="ghost" :class="{ on: !allRepos }" title="Só as conversas deste repositório" @click="setScope(false)">Repositório</button>
          <button class="ghost" :class="{ on: allRepos }" title="Conversas de todos os repositórios" @click="setScope(true)">Todas</button>
        </span>
      </header>
      <div v-if="items.length > 6" class="search">
        <Icon name="search" :size="13" class="faint" />
        <input v-model="query" type="text" placeholder="Buscar conversa" spellcheck="false" />
      </div>
      <p v-if="!items.length && !loading" class="faint empty">
        Nenhuma conversa guardada {{ allRepos ? '' : 'neste repositório ' }}ainda. Elas entram aqui depois da primeira resposta do agente.
      </p>
      <div class="list">
        <template v-for="{ h, label } in rows" :key="h.sessionId">
        <div v-if="label" class="sep"><span>{{ label }}</span></div>
        <div class="item" @click="reopen(h)">
          <span class="dot" :class="statusOf(h)" :title="STATUS_LABEL[statusOf(h)]" />
          <AgentLogo :source="h.provider" :size="14" />
          <span class="text">
            <span class="ellipsis title">{{ h.title }}</span>
            <small class="faint ellipsis"><template v-if="allRepos">{{ h.project }} · </template>{{ modelLabel(h.provider, h.model, catalogOf(known, h.provider)) }} · {{ h.turns }} {{ h.turns === 1 ? 'mensagem' : 'mensagens' }} · {{ when(h.updatedAt) }}</small>
          </span>
          <span v-if="state.agentWindows.includes(h.sessionId)" class="badge accent">aberta</span>
          <button class="ghost rm pin" :class="{ on: h.pinned }" :title="h.pinned ? 'Soltar do topo' : 'Fixar no topo'" @click.stop="pin(h)"><Icon name="pin" :size="12" /></button>
          <button class="ghost rm" title="Esquecer esta conversa" @click.stop="forget(h)"><Icon name="x" :size="12" /></button>
        </div>
        </template>
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
header strong { min-width: 0; flex: 1; }
/* escopo da lista: dois rótulos pequenos, o ativo só ganha cor */
.scope { display: flex; gap: 2px; flex: none; }
.scope button { height: 20px; padding: 0 6px; border-radius: 6px; font-size: 11px; color: var(--faint); }
.scope button.on { color: var(--accent); background: var(--accent-soft); }
.search { display: flex; align-items: center; gap: 8px; margin: 2px 4px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.search input { border: 0; background: transparent; padding: 6px 0; outline: none; font-size: 12.5px; }
.search input:focus { box-shadow: none; }
.empty { margin: 4px 8px 8px; font-size: 12px; line-height: 1.4; }
.list { display: flex; flex-direction: column; gap: 1px; }
.item { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; min-width: 0; }
.item:hover { background: var(--hover); }
/* situação da conversa: mesmas cores do indicador da janela do agente */
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); opacity: 0.5; }
.dot.live { background: var(--accent); opacity: 1; box-shadow: 0 0 0 3px var(--accent-soft); animation: dot-pulse 1.4s ease-in-out infinite; }
.dot.waiting { background: var(--mod); opacity: 1; }
.dot.done { background: var(--add); opacity: 1; }
.dot.error { background: var(--del); opacity: 1; }
.dot.stopped { background: transparent; opacity: 1; box-shadow: inset 0 0 0 1.5px var(--faint); }
@keyframes dot-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } }
.text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.title { font-size: 12.5px; font-weight: 600; }
.text small { font-size: 11px; }
.rm { width: 24px; height: 24px; padding: 0; color: var(--faint); opacity: 0; flex: none; }
.item:hover .rm { opacity: 1; }
.pin.on { opacity: 1; color: var(--accent); }
/* separador discreto entre os grupos: rótulo pequeno seguido de uma linha */
.sep { display: flex; align-items: center; gap: 8px; padding: 6px 8px 2px; font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.04em; }
.sep::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
</style>
