<script setup lang="ts">
import { computed, ref } from 'vue'
import type { OvseerTask } from '@shared/types'
import {
  api, loadTasks, openNewTask, ovseerReady, ovseerTaskUrl, ovseerWorkspace, setShowTasks, state
} from '../store'
import Icon from './Icon.vue'

const query = ref('')
const ORDER = ['doing', 'paused', 'blocked', 'review', 'todo', 'backlog']
const PRIORITY: Record<string, string> = { low: 'Baixa', medium: 'Média', high: 'Alta', urgent: 'Urgente' }

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? state.tasks.filter((t) => `${t.key} ${t.title} ${t.statusLabel}`.toLowerCase().includes(q))
    : state.tasks
  const map = new Map<string, OvseerTask[]>()
  for (const t of list) {
    if (!map.has(t.status)) map.set(t.status, [])
    map.get(t.status)!.push(t)
  }
  return [...map.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([status, tasks]) => ({ status, label: tasks[0].statusLabel, tasks }))
})

function useInCommit(t: OvseerTask) {
  state.commitTaskId = state.commitTaskId === t.id ? null : t.id
}
</script>

<template>
  <aside class="tasks">
    <header>
      <strong>Tarefas</strong>
      <span
        v-if="ovseerReady"
        class="live"
        :class="{ on: state.ovseerLive }"
        :title="state.ovseerLive ? 'Atualizando em tempo real' : 'Sem conexão em tempo real (tentando reconectar)'"
      />
      <span v-if="ovseerWorkspace" class="faint ws ellipsis">{{ ovseerWorkspace.name }}</span>
      <span class="spacer" />
      <button v-if="ovseerReady" class="ghost icon small" title="Nova tarefa" @click="openNewTask"><Icon name="plus" :size="15" /></button>
      <button v-if="ovseerReady" class="ghost icon small" title="Atualizar" @click="loadTasks(true)">
        <span v-if="state.tasksLoading" class="spinner" />
        <Icon v-else name="refresh" :size="13" />
      </button>
      <button class="ghost icon small" title="Fechar" @click="setShowTasks(false)"><Icon name="x" :size="14" /></button>
    </header>

    <div v-if="!ovseerReady" class="empty">
      <p class="muted">Conecte sua conta do Ovseer para ver e criar tarefas aqui.</p>
      <button class="small primary" @click="state.showSettings = true">Conectar</button>
    </div>

    <template v-else>
      <div class="search">
        <Icon name="search" :size="14" class="faint" />
        <input v-model="query" type="text" placeholder="Buscar tarefas" spellcheck="false" />
      </div>
      <p v-if="state.tasksError" class="bad">{{ state.tasksError }}</p>

      <div class="scroll">
        <p v-if="!state.tasks.length && !state.tasksLoading" class="faint none">Nenhuma tarefa ativa.</p>
        <section v-for="g in groups" :key="g.status">
          <h4><span class="dot" :class="g.status" /> {{ g.label }} <span class="count">{{ g.tasks.length }}</span></h4>
          <article
            v-for="t in g.tasks"
            :key="t.id"
            class="task"
            :class="{ selected: state.commitTaskId === t.id }"
            @click="useInCommit(t)"
            :title="state.commitTaskId === t.id ? 'Usada nos próximos commits (clique para tirar)' : 'Usar nos próximos commits'"
          >
            <div class="top">
              <span class="key mono">{{ t.key }}</span>
              <span v-if="t.priority" class="prio" :class="t.priority">{{ PRIORITY[t.priority] ?? t.priority }}</span>
              <span class="spacer" />
              <Icon v-if="state.commitTaskId === t.id" name="commit" :size="14" class="using" />
              <button
                v-if="t.canDeliver"
                class="ghost deliver"
                title="Preparar entrega"
                @click.stop="state.deliveryTask = t"
              >
                Entregar
              </button>
              <button class="ghost icon tiny open" title="Abrir no Ovseer" @click.stop="api.openExternal(ovseerTaskUrl(t.key))">
                <Icon name="external" :size="13" />
              </button>
            </div>
            <div class="title">{{ t.title }}</div>
            <div v-if="!t.assignedToMe" class="faint other">de outra pessoa</div>
          </article>
        </section>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.tasks { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }
header { display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 6px 0 14px; border-bottom: 1px solid var(--border); flex: none; }
header strong { font-size: 13px; }
.ws { font-size: 12px; min-width: 0; }
.live { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.live.on { background: var(--add); box-shadow: 0 0 0 3px var(--add-bg); }
.spacer { flex: 1; }
.icon.small { width: 28px; height: 28px; }
.empty { padding: 24px 16px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.empty p { margin: 0; font-size: 12.5px; }
.search { display: flex; align-items: center; gap: 8px; margin: 10px 10px 4px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.search input { border: 0; background: transparent; padding: 7px 0; outline: none; }
.search input:focus { box-shadow: none; }
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.bad { margin: 6px 12px; font-size: 12px; color: var(--del); }
.scroll { flex: 1; overflow: auto; padding: 6px 10px 14px; }
.none { font-size: 12.5px; padding: 12px 4px; }
h4 { display: flex; align-items: center; gap: 7px; margin: 12px 4px 6px; font-size: 12px; }
.count { font-size: 11px; color: var(--muted); background: var(--panel-2); border-radius: 999px; padding: 0 7px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
.dot.doing { background: var(--add); }
.dot.paused { background: var(--accent); }
.dot.blocked { background: var(--del); }
.dot.review { background: var(--hunk); }
.dot.todo { background: var(--mod); }
.task {
  padding: 10px 12px; margin-bottom: 6px; border-radius: 10px; cursor: pointer;
  background: var(--panel-2); border: 1px solid transparent; transition: border-color 0.12s, background 0.12s;
}
.task:hover { border-color: var(--border); }
.task.selected { border-color: var(--accent); background: var(--accent-soft); }
.top { display: flex; align-items: center; gap: 6px; }
.key { font-size: 11px; font-weight: 700; color: var(--accent); }
.prio { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; background: var(--panel); color: var(--muted); }
.prio.high { color: var(--mod); }
.prio.urgent { color: var(--del); }
.using { color: var(--accent); }
.deliver { height: 22px; padding: 0 8px; font-size: 11px; font-weight: 600; color: var(--accent); border-radius: 6px; }
.deliver:hover { background: var(--accent-soft) !important; }
.tiny { width: 22px; height: 22px; padding: 0; opacity: 0; }
.task:hover .tiny { opacity: 1; }
.title { margin-top: 4px; font-weight: 600; font-size: 12.5px; line-height: 1.35; }
.other { font-size: 11px; margin-top: 2px; }
</style>
