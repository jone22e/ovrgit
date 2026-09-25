<script setup lang="ts">
import { computed, ref } from 'vue'
import type { OvseerTask } from '@shared/types'
import { agentByTask, agentName, loadTasks, openNewTask, openTaskDetail, ovseerReady, ovseerWorkspace, setShowTasks, state } from '../store'
import Icon from './Icon.vue'

/** Mesmas etapas, textos e cores da tela de tarefas do Ovseer. */
const SECTIONS: { id: string; title: string; description: string; tone: string }[] = [
  { id: 'plan_pending', title: 'Aguardando aprovação do plano', description: 'O trabalho ainda não pode começar.', tone: '#f59e0b' },
  { id: 'plan_rejected', title: 'Plano recusado', description: 'O plano precisa ser corrigido e reenviado.', tone: '#f43f5e' },
  { id: 'waiting_execution', title: 'Aguardando execução', description: 'Planos aprovados que ainda não foram iniciados.', tone: '#3b82f6' },
  { id: 'execution', title: 'Em execução', description: 'Tarefas em andamento ou bloqueadas.', tone: '#10b981' },
  { id: 'paused', title: 'Pausado', description: 'Tarefas interrompidas temporariamente, prontas para retomar.', tone: '#6366f1' },
  { id: 'legacy_report', title: 'Aguardando relatório retroativo', description: 'Tarefas antigas concluídas que precisam documentar a entrega.', tone: '#d946ef' },
  { id: 'completion_pending', title: 'Entrega aguardando validação', description: 'Relatórios enviados para decisão do admin ou dono.', tone: '#10b981' },
  { id: 'integration', title: 'Fora do novo fluxo', description: 'Tarefas de integrações legadas, incluindo WhatsApp.', tone: '#94a3b8' }
]
const PRIORITY: Record<string, string> = { low: 'Baixa', medium: 'Média', high: 'Alta', urgent: 'Urgente' }

const query = ref('')

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? state.tasks.filter((t) => `${t.key} ${t.title} ${t.statusLabel} ${t.owner?.name ?? ''}`.toLowerCase().includes(q))
    : state.tasks
  return SECTIONS.map((s) => ({ ...s, tasks: list.filter((t) => sectionOf(t) === s.id) })).filter(
    (s) => s.tasks.length
  )
})

/** Etapa da tarefa. Servidores antigos do Ovseer não mandam a etapa: deduz pelo status. */
function sectionOf(t: OvseerTask) {
  if (t.section) return t.section
  return ({ paused: 'paused', todo: 'waiting_execution', backlog: 'waiting_execution', review: 'completion_pending' } as Record<string, string>)[t.status] ?? 'execution'
}

/** Responsável. Servidores antigos não mandam: nas minhas tarefas, sou eu. */
function ownerOf(t: OvseerTask) {
  if (t.owner) return t.owner
  const me = state.ovseer?.user
  return t.assignedToMe && me ? { name: me.name, avatarUrl: me.avatarUrl ?? null } : null
}

/** Cor do selo de status (mesma lógica do Ovseer: etapas de plano primeiro, depois o status). */
function badgeTone(t: OvseerTask) {
  if (t.section === 'plan_pending') return 'amber'
  if (t.section === 'plan_rejected') return 'rose'
  return (
    ({ backlog: 'slate', todo: 'blue', doing: 'emerald', paused: 'indigo', blocked: 'amber', review: 'violet', done: 'teal', cancelled: 'rose' } as Record<string, string>)[
      t.status
    ] ?? 'slate'
  )
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')

</script>

<template>
  <aside class="tasks">
    <header>
      <strong>Tarefas</strong>
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
        <section v-for="g in groups" :key="g.id" class="group">
          <div class="g-head">
            <span class="g-dot" :style="{ background: g.tone }" />
            <div class="g-text">
              <h4>{{ g.title }} <span class="g-count mono">{{ g.tasks.length }}</span></h4>
              <p>{{ g.description }}</p>
            </div>
          </div>

          <article
            v-for="t in g.tasks"
            :key="t.id"
            class="card"
            :class="{ selected: state.commitTaskId === t.id }"
            :title="state.commitTaskId === t.id ? 'Vinculada aos próximos commits. Clique para ver os detalhes' : 'Ver os detalhes da tarefa'"
            @click="openTaskDetail(t.id)"
          >
            <div class="c-body">
              <div class="c-top">
                <span class="key mono">{{ t.key }}</span>
                <span class="pill status" :class="badgeTone(t)" :title="t.statusLabel">{{ t.statusLabel }}</span>
                <Icon v-if="state.commitTaskId === t.id" name="commit" :size="14" class="using" />
              </div>
              <div class="c-title">{{ t.title }}</div>
              <div
                v-if="agentByTask.get(t.id)"
                class="agent"
                :class="{ on: agentByTask.get(t.id)!.running }"
                :title="`${agentByTask.get(t.id)!.title}${agentByTask.get(t.id)!.lastMessage ? `\n\n${agentByTask.get(t.id)!.lastMessage}` : ''}`"
              >
                <span v-if="agentByTask.get(t.id)!.running" class="apulse" />
                <Icon v-else name="check" :size="11" />
                <span class="ellipsis">{{ agentName(agentByTask.get(t.id)!) }} {{ agentByTask.get(t.id)!.running ? 'trabalhando' : 'terminou' }} · {{ agentByTask.get(t.id)!.title }}</span>
              </div>
              <div class="c-foot">
                <template v-if="ownerOf(t)">
                  <img v-if="ownerOf(t)!.avatarUrl" :src="ownerOf(t)!.avatarUrl!" class="av" alt="" />
                  <span v-else class="av initials">{{ initials(ownerOf(t)!.name) }}</span>
                  <span class="owner ellipsis">{{ ownerOf(t)!.name }}</span>
                </template>
                <span v-if="t.priority" class="pill" :class="`p-${t.priority}`">{{ PRIORITY[t.priority] ?? t.priority }}</span>
                <span class="spacer" />
                <button v-if="t.canDeliver" class="ghost deliver" title="Preparar entrega" @click.stop="state.deliveryTask = t">
                  Entregar
                </button>
              </div>
            </div>
            <button class="ghost chev" title="Ver os detalhes" @click.stop="openTaskDetail(t.id)">
              <Icon name="chevron" :size="16" />
            </button>
          </article>
        </section>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.tasks { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); }
header { display: flex; align-items: center; gap: 6px; height: var(--pane-header); padding: 0 6px 0 14px; border-bottom: 1px solid var(--border); flex: none; box-sizing: border-box; }
header strong { font-size: 13px; }
.ws { font-size: 12px; min-width: 0; }
.spacer { flex: 1; }
.icon.small { width: 28px; height: 28px; }
.empty { padding: 24px 16px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.empty p { margin: 0; font-size: 12.5px; }
.search { display: flex; align-items: center; gap: 8px; margin: 10px 12px 4px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.search input { border: 0; background: transparent; padding: 7px 0; outline: none; }
.search input:focus { box-shadow: none; }
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.bad { margin: 6px 12px; font-size: 12px; color: var(--del); }
.scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 12px 16px; }
.none { font-size: 12.5px; padding: 12px 4px; }

.group { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.g-head { display: flex; align-items: flex-start; gap: 10px; padding: 0 2px; }
.g-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; flex: none; }
.g-text { min-width: 0; }
h4 { margin: 0; font-size: 13.5px; font-weight: 800; line-height: 1.35; }
.g-count { display: inline-block; vertical-align: 1px; margin-left: 4px; font-size: 10.5px; font-weight: 800; padding: 1px 8px; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
.g-text p { margin: 2px 0 0; font-size: 12px; color: var(--muted); line-height: 1.35; }

.card {
  display: flex; align-items: center; gap: 6px; padding: 12px 8px 12px 14px; border-radius: 14px; cursor: pointer;
  background: var(--panel-2); border: 1px solid transparent; transition: border-color 0.12s, background 0.12s;
}
.card:hover { border-color: var(--border); }
.card.selected { border-color: var(--accent); background: var(--accent-soft); }
.c-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.c-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.key { font-size: 11px; font-weight: 700; color: var(--accent); flex: none; }
.using { color: var(--accent); margin-left: auto; }
.c-title { font-size: 14px; font-weight: 800; line-height: 1.3; }
.agent { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; max-width: 100%; min-width: 0; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--add-bg); color: var(--add); }
.agent.on { background: var(--accent-soft); color: var(--accent); }
.apulse { width: 7px; height: 7px; flex: none; border-radius: 50%; background: currentColor; animation: ap 1.4s ease-in-out infinite; }
@keyframes ap { 50% { opacity: 0.3; } }
.c-foot { display: flex; align-items: center; gap: 8px; min-width: 0; }
.av { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: none; }
.initials { display: inline-flex; align-items: center; justify-content: center; background: var(--accent); color: var(--on-accent); font-size: 9.5px; font-weight: 700; }
.owner { font-size: 12px; font-weight: 600; color: var(--muted); min-width: 0; }
.chev { width: 26px; height: 26px; padding: 0; flex: none; color: var(--text); }
.deliver { height: 22px; padding: 0 8px; font-size: 11px; font-weight: 700; color: var(--accent); border-radius: 6px; }
.deliver:hover { background: var(--accent-soft) !important; }

/* selos no estilo do Ovseer: borda e fundo translúcidos na cor do status/prioridade */
.pill {
  --c: #94a3b8;
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; flex: none;
  font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;
  color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
  background: color-mix(in srgb, var(--c) 12%, transparent);
}
.pill.status { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: inline-block; line-height: 18px; }
.pill.slate { --c: #94a3b8; }
.pill.blue { --c: #60a5fa; }
.pill.emerald { --c: #34d399; }
.pill.indigo { --c: #818cf8; }
.pill.amber { --c: #fbbf24; }
.pill.violet { --c: #a78bfa; }
.pill.teal { --c: #2dd4bf; }
.pill.rose { --c: #fb7185; }
.pill.p-low { --c: #38bdf8; }
.pill.p-medium { --c: #fbbf24; }
.pill.p-high { --c: #fb923c; }
.pill.p-urgent { --c: #fb7185; }
</style>
