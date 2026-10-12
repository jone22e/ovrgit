<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { QueueTask } from '@shared/types'
import { api, saveSettings, state, toast } from '../store'
import { ago } from '../ago'
import Icon from './Icon.vue'
import RepoSelect from './RepoSelect.vue'

/**
 * Fila de tarefas: o próximo agente em espera livre (do repositório da tarefa, se houver) pega a próxima. A
 * tarefa rodando aponta o agente; a concluída guarda a conversa para reabrir; a que falhou pode voltar à fila.
 */
const emit = defineEmits<{ standby: [] }>()
const text = ref('')
const cwd = ref(state.repo?.root ?? '')
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)

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
    <header class="q-head">
      <strong><Icon name="listTodo" :size="14" /> Fila de tarefas</strong>
      <span class="gap" />
      <label class="reuse" title="Ao terminar uma tarefa, o agente abre uma conversa nova (a da tarefa fica em Conversas) e pega a próxima"><input v-model="reuse" type="checkbox" class="switch" /><span>Reaproveitar</span></label>
    </header>

    <!-- os números da fila -->
    <div class="stats">
      <div class="stat" :class="{ on: queued.length }"><b class="mono">{{ queued.length }}</b><small>na fila</small></div>
      <div class="stat live" :class="{ on: running.length }"><b class="mono">{{ running.length }}</b><small>rodando</small></div>
      <button class="stat standby" :class="{ on: standby, zero: !standby }" title="Agentes em espera livres. Clique para deixar mais um em espera" @click="emit('standby')"><b class="mono">{{ standby }}</b><small>em espera</small></button>
    </div>

    <!-- nova tarefa: o campo, o repositório e o botão, como no composer da conversa -->
    <div class="q-add" :class="{ ready: text.trim() }">
      <textarea v-model="text" rows="3" placeholder="O que o próximo agente deve fazer?" spellcheck="false" @keydown.meta.enter.prevent="add" @keydown.ctrl.enter.prevent="add" />
      <div class="q-add-row">
        <RepoSelect v-model="cwd" any class="q-repo" />
        <span class="gap" />
        <small class="faint kbd">⌘↵</small>
        <button class="primary icon q-send" :disabled="!text.trim()" title="Adicionar à fila (⌘Enter)" @click="add"><Icon name="plus" :size="15" /></button>
      </div>
    </div>

    <div v-if="queued.length && !standby && !running.length" class="hint">
      <p><Icon name="alert" :size="13" /> Nenhum agente em espera: a fila só anda quando houver um.</p>
      <button class="ghost link" @click="emit('standby')">Deixar um agente em espera →</button>
    </div>

    <div v-if="!tasks.length" class="q-empty">
      <Icon name="listTodo" :size="26" class="faint" />
      <p class="faint">Escreva uma tarefa acima. O próximo agente em espera livre a pega sozinho, e segue para a seguinte quando terminar.</p>
    </div>

    <template v-if="queued.length">
      <h6 class="q-sec">Na fila <small class="faint">{{ queued.length }}</small></h6>
      <ol class="q-list">
        <li v-for="(t, i) in queued" :key="t.id" class="q-card">
          <span class="n mono">{{ i + 1 }}</span>
          <div class="q-body">
            <p class="q-text">{{ t.text }}</p>
            <small v-if="t.cwd && t.cwd !== state.repo?.root" class="chip">{{ name(t.cwd) }}</small>
          </div>
          <span class="q-acts">
            <button class="ghost icon small" :disabled="i === 0" title="Subir" @click="move(t, -1)"><Icon name="chevron" :size="12" class="up" /></button>
            <button class="ghost icon small" :disabled="i === queued.length - 1" title="Descer" @click="move(t, 1)"><Icon name="chevron" :size="12" class="down" /></button>
            <button class="ghost icon small rm" title="Tirar da fila" @click="remove(t)"><Icon name="x" :size="12" /></button>
          </span>
        </li>
      </ol>
    </template>

    <template v-if="running.length">
      <h6 class="q-sec live">Rodando <small class="faint">{{ running.length }}</small></h6>
      <ol class="q-list">
        <li v-for="t in running" :key="t.id" class="q-card run" title="Abrir a conversa" @click="openTask(t)">
          <span class="spinner tiny" />
          <div class="q-body">
            <p class="q-text">{{ t.text }}</p>
            <small class="faint who"><Icon name="bot" :size="11" /> {{ agentOf(t)?.title ?? t.agentTitle ?? 'agente' }}<template v-if="t.startedAt"> · {{ ago(now, t.startedAt) }}</template></small>
          </div>
        </li>
      </ol>
    </template>

    <template v-if="finished.length">
      <h6 class="q-sec">Concluídas <small class="faint">{{ finished.length }}</small><span class="gap" /><button class="ghost link" @click="clear">Limpar</button></h6>
      <ol class="q-list">
        <li v-for="t in finished" :key="t.id" class="q-card fin" :class="t.status" title="Abrir a conversa" @click="openTask(t)">
          <Icon :name="t.status === 'done' ? 'check' : 'x'" :size="12" class="st" />
          <div class="q-body">
            <p class="q-text">{{ t.text }}</p>
            <small class="faint who">{{ t.agentTitle ?? '' }}<template v-if="t.finishedAt"> · há {{ ago(now, t.finishedAt) }}</template></small>
            <button v-if="t.status === 'failed'" class="ghost link retry" @click.stop="retry(t)">Tentar de novo</button>
          </div>
          <button class="ghost icon small rm q-x" title="Tirar da lista" @click.stop="remove(t)"><Icon name="x" :size="12" /></button>
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
.queue { display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 20px; min-height: 100%; box-sizing: border-box; }
.q-head { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.q-head strong { display: inline-flex; align-items: center; gap: 7px; }
.gap { flex: 1; }
.reuse { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
.switch { appearance: none; width: 28px; height: 16px; margin: 0; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); position: relative; cursor: pointer; flex: none; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: transform 0.12s, background 0.12s; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(12px); background: var(--on-accent); }
/* os três números */
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.stat { display: flex; flex-direction: column; align-items: flex-start; gap: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--faint); text-align: left; }
.stat b { font-size: 18px; line-height: 1.1; color: var(--muted); font-variant-numeric: tabular-nums; }
.stat small { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
.stat.on b { color: var(--text); }
.stat.live.on b { color: var(--accent); }
.stat.standby { cursor: pointer; }
.stat.standby:hover { border-color: color-mix(in srgb, var(--hunk) 50%, var(--border)); }
.stat.standby.on b { color: var(--hunk); }
.stat.standby.zero { border-style: dashed; }
/* composer da tarefa */
.q-add { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); transition: border-color 0.12s; }
.q-add:focus-within, .q-add.ready { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.q-add textarea { width: 100%; box-sizing: border-box; resize: none; min-height: 72px; padding: 10px 12px 4px; border: 0; background: transparent; color: var(--text); font-size: 13px; line-height: 1.45; font-family: inherit; outline: none; }
.q-add-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px; }
.q-repo { max-width: 180px; }
.q-repo :deep(.sel) { height: 28px; font-size: 12px; background: var(--panel); }
.kbd { font-size: 11px; font-family: var(--mono); }
.q-send { width: 30px; height: 30px; border-radius: 8px; }
.hint { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px 10px; border-radius: 10px; font-size: 12px; color: var(--mod); background: color-mix(in srgb, var(--mod) 10%, transparent); }
.hint p { margin: 0; display: flex; align-items: flex-start; gap: 6px; line-height: 1.4; }
.hint .link { margin-left: 19px; padding: 0; }
.link { height: 22px; padding: 0 6px; font-size: 11.5px; color: var(--accent); }
.q-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px 12px; text-align: center; }
.q-empty p { margin: 0; font-size: 12.5px; line-height: 1.5; max-width: 260px; }
.q-sec { display: flex; align-items: center; gap: 6px; margin: 4px 0 -6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.q-sec.live { color: var(--accent); }
.q-sec small { text-transform: none; letter-spacing: 0; }
.q-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
/* cartão da tarefa */
.q-card { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); min-width: 0; }
.q-card.run, .q-card.fin { cursor: pointer; }
.q-card.run:hover, .q-card.fin:hover { border-color: color-mix(in srgb, var(--text) 22%, var(--border)); }
.q-card.run { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.n { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 6px; font-size: 11px; font-weight: 700; color: var(--muted); background: var(--panel-2); flex: none; margin-top: 1px; }
.q-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.q-text { margin: 0; font-size: 12.5px; line-height: 1.4; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.q-card.fin .q-text { color: var(--muted); }
.chip { align-self: flex-start; font-size: 10.5px; padding: 1px 6px; border-radius: 5px; background: var(--panel-2); color: var(--muted); }
.who { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; min-width: 0; }
.q-acts { position: absolute; right: 6px; top: 6px; display: inline-flex; gap: 1px; opacity: 0; background: var(--panel); border-radius: 8px; }
.q-card:hover .q-acts { opacity: 1; }
.up { transform: rotate(-90deg); }
.down { transform: rotate(90deg); }
.rm:hover { color: var(--del); }
.spinner.tiny { margin-top: 3px; }
.st { flex: none; margin-top: 3px; }
.q-card.done .st { color: var(--add); }
.q-card.failed .st { color: var(--del); }
.q-card.failed { border-color: color-mix(in srgb, var(--del) 35%, var(--border)); }
.retry { align-self: flex-start; padding: 0; }
.q-x { position: absolute; right: 6px; top: 6px; opacity: 0; }
.q-card:hover .q-x { opacity: 1; }
</style>
