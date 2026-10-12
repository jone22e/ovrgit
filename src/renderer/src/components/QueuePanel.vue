<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { QueueTask } from '@shared/types'
import { api, saveSettings, state, toast } from '../store'
import { ago } from '../ago'
import Icon from './Icon.vue'

/**
 * Fila de tarefas: o próximo agente em espera livre (do repositório da tarefa, se houver) pega a próxima. A
 * tarefa rodando aponta o agente; a concluída guarda a conversa para reabrir; a que falhou pode voltar à fila.
 */
const emit = defineEmits<{ standby: [] }>()
const text = ref('')
const cwd = ref(state.repo?.root ?? '')
const projects = ref<string[]>([])
const options = computed(() => [...new Set([state.repo?.root ?? '', ...projects.value].filter(Boolean))])
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
onMounted(() => api.agentProjects().then((l) => (projects.value = l)).catch(() => undefined))

const tasks = computed(() => state.queue)
const queued = computed(() => tasks.value.filter((t) => t.status === 'queued'))
const running = computed(() => tasks.value.filter((t) => t.status === 'running'))
const finished = computed(() => tasks.value.filter((t) => t.status === 'done' || t.status === 'failed').slice().reverse())
/** Agentes em espera livres agora */
const standby = computed(() => state.agentSnaps.filter((a) => a.standby && a.status === 'idle').length)

const now = ref(Date.now())
onMounted(() => setInterval(() => (now.value = Date.now()), 5000))

async function add() {
  const t = text.value.trim()
  if (!t) return
  await api.queueAdd({ text: t, cwd: cwd.value || undefined }).catch((e) => (state.error = String((e as Error).message)))
  text.value = ''
}
const remove = (t: QueueTask) => api.queueRemove(t.id).catch(() => undefined)
const move = (t: QueueTask, dir: -1 | 1) => api.queueMove(t.id, dir).catch(() => undefined)
const retry = (t: QueueTask) => api.queueRetry(t.id).catch(() => undefined)
const clear = () => api.queueClearFinished().catch(() => undefined)
/** Abre a conversa em que a tarefa rodou (a janela, se ainda estiver aberta; senão, pelo histórico) */
async function openTask(t: QueueTask) {
  // rodando: a conversa ainda está no agente que a pegou
  if (t.status === 'running' && t.uid && state.agentSnaps.some((a) => a.uid === t.uid)) return api.agentShow(t.uid).catch(() => undefined)
  if (!t.sessionId) return toast('A conversa dessa tarefa não foi guardada.')
  if (await api.agentFocus(t.sessionId).catch(() => false)) return
  const h = (await api.agentHistory().catch(() => [])).find((x) => x.sessionId === t.sessionId)
  if (!h) return toast('A conversa dessa tarefa não está mais no histórico.')
  await api.agentOpen({ provider: h.provider, model: h.model, effort: h.effort, mode: h.mode, cwd: h.cwd, resumeId: h.sessionId }).catch(() => undefined)
}
const agentOf = (t: QueueTask) => state.agentSnaps.find((a) => a.uid === t.uid)
const reuse = computed({
  get: () => state.settings?.queueReuse !== false,
  set: (v: boolean) => void saveSettings({ queueReuse: v })
})
</script>

<template>
  <section class="queue">
    <div class="q-head">
      <strong><Icon name="listTodo" :size="13" /> Fila de tarefas</strong>
      <span class="gap" />
      <button v-if="finished.length" class="ghost link" @click="clear">Limpar concluídas</button>
    </div>
    <small class="faint q-sum">{{ queued.length }} na fila · {{ running.length }} rodando · {{ standby }} {{ standby === 1 ? 'agente em espera' : 'agentes em espera' }}</small>
    <label class="reuse" title="Ao terminar uma tarefa, o agente abre uma conversa nova (a da tarefa fica em Conversas) e pega a próxima"><input v-model="reuse" type="checkbox" class="switch" /> Reaproveitar agentes ao terminar</label>

    <div class="q-add">
      <textarea v-model="text" rows="2" placeholder="Descreva a tarefa… (⌘Enter adiciona)" spellcheck="false" @keydown.meta.enter.prevent="add" @keydown.ctrl.enter.prevent="add" />
      <div class="q-add-row">
        <select v-model="cwd" title="Repositório onde a tarefa deve rodar">
          <option value="">Qualquer repositório</option>
          <option v-for="p in options" :key="p" :value="p">{{ name(p) }}</option>
        </select>
        <span class="gap" />
        <button class="primary small" :disabled="!text.trim()" @click="add"><Icon name="plus" :size="13" /> Adicionar à fila</button>
      </div>
    </div>

    <p v-if="queued.length && !standby && !running.length" class="hint">
      <Icon name="alert" :size="13" /> Nenhum agente em espera: a fila só anda quando houver um.
      <button class="ghost link" @click="emit('standby')">Deixar um agente em espera</button>
    </p>

    <h6 v-if="queued.length" class="q-sec">Na fila</h6>
    <ol v-if="queued.length" class="q-list">
      <li v-for="(t, i) in queued" :key="t.id" class="q-item">
        <span class="n mono">{{ i + 1 }}</span>
        <span class="q-text">{{ t.text }}</span>
        <small v-if="t.cwd && t.cwd !== state.repo?.root" class="faint chip">{{ name(t.cwd) }}</small>
        <span class="q-acts">
          <button class="ghost icon small" :disabled="i === 0" title="Subir" @click="move(t, -1)"><Icon name="chevron" :size="12" class="up" /></button>
          <button class="ghost icon small" :disabled="i === queued.length - 1" title="Descer" @click="move(t, 1)"><Icon name="chevron" :size="12" class="down" /></button>
          <button class="ghost icon small" title="Tirar da fila" @click="remove(t)"><Icon name="x" :size="12" /></button>
        </span>
      </li>
    </ol>

    <h6 v-if="running.length" class="q-sec">Rodando</h6>
    <ol v-if="running.length" class="q-list">
      <li v-for="t in running" :key="t.id" class="q-item run" @click="openTask(t)">
        <span class="spinner tiny" />
        <span class="q-text">{{ t.text }}</span>
        <small class="faint ellipsis who">{{ agentOf(t)?.title ?? t.agentTitle ?? 'agente' }}<template v-if="t.startedAt"> · há {{ ago(now, t.startedAt) }}</template></small>
      </li>
    </ol>

    <h6 v-if="finished.length" class="q-sec">Concluídas</h6>
    <ol v-if="finished.length" class="q-list done">
      <li v-for="t in finished" :key="t.id" class="q-item" :class="t.status" @click="openTask(t)">
        <Icon :name="t.status === 'done' ? 'check' : 'x'" :size="12" class="st" />
        <span class="q-text">{{ t.text }}</span>
        <small class="faint ellipsis who">{{ t.agentTitle ?? '' }}<template v-if="t.finishedAt"> · há {{ ago(now, t.finishedAt) }}</template></small>
        <button v-if="t.status === 'failed'" class="ghost link" @click.stop="retry(t)">Tentar de novo</button>
        <button class="ghost icon small" title="Tirar da lista" @click.stop="remove(t)"><Icon name="x" :size="12" /></button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.queue { display: flex; flex-direction: column; gap: 10px; padding: 14px 14px 20px; min-height: 100%; box-sizing: border-box; }
.q-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.q-head strong { display: inline-flex; align-items: center; gap: 6px; }
.q-head small { font-size: 11.5px; }
.q-sum { font-size: 11.5px; margin-top: -6px; }
.gap { flex: 1; }
.reuse { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
.switch { appearance: none; width: 28px; height: 16px; margin: 0; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); position: relative; cursor: pointer; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: transform 0.12s, background 0.12s; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(12px); background: var(--on-accent); }
.link { height: 24px; padding: 0 6px; font-size: 11.5px; color: var(--accent); }
.q-add { display: flex; flex-direction: column; gap: 6px; }
.q-add textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 48px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.45; font-family: inherit; }
.q-add-row { display: flex; align-items: center; gap: 8px; }
.q-add-row select { height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--muted); font-size: 12px; max-width: 220px; }
.q-add-row .small { height: 28px; gap: 6px; }
.hint { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; color: var(--mod); flex-wrap: wrap; }
.q-sec { margin: 6px 0 -6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.q-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.q-item { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 4px 6px; border-radius: 8px; font-size: 12.5px; min-width: 0; }
.q-item.run, .q-list.done .q-item { cursor: pointer; }
.q-item:hover { background: var(--hover); }
.n { width: 18px; text-align: right; font-size: 11px; color: var(--faint); flex: none; }
.q-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--panel-2); flex: none; }
.who { font-size: 11.5px; flex: none; max-width: 38%; }
.q-acts { display: inline-flex; gap: 2px; opacity: 0; flex: none; }
.q-item:hover .q-acts { opacity: 1; }
.up { transform: rotate(-90deg); }
.down { transform: rotate(90deg); }
.st { flex: none; }
.q-item.done .st { color: var(--add); }
.q-item.failed .st { color: var(--del); }
.q-list.done .q-item { color: var(--muted); }
</style>
