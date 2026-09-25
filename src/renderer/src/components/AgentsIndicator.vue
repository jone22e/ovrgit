<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AgentSession } from '@shared/types'
import { agentName, isInside, linkAgent, loadProject, loadProjectIcon, projectIcons, state, suggestTasks, taskOfAgent } from '../store'
import Icon from './Icon.vue'

/** Tarefas dos agentes (ChatGPT/Codex e Claude): trabalhando agora e as que terminaram há pouco, agrupadas por projeto. */
const open = ref(false)
const root = ref<HTMLElement>()
const now = ref(Date.now())
const expanded = ref<string | null>(null)
let tick: ReturnType<typeof setInterval>

const running = computed(() => state.agents.filter((a) => a.running).length)
const done = computed(() => state.agents.length - running.value)

const folder = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const groups = computed(() => {
  const map = new Map<string, { cwd: string; name: string; items: AgentSession[] }>()
  for (const a of state.agents) {
    const g = map.get(a.cwd) ?? { cwd: a.cwd, name: folder(a.cwd), items: [] }
    g.items.push(a)
    map.set(a.cwd, g)
  }
  return [...map.values()]
})

function ago(ms: number) {
  const m = Math.max(0, Math.round((now.value - ms) / 60000))
  if (m < 1) return 'agora'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}
function took(a: AgentSession) {
  const ms = a.running ? now.value - a.startedAt : a.durationMs
  if (!ms) return ''
  const m = Math.round(ms / 60000)
  return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

async function openProject(cwd: string) {
  open.value = false
  if (!state.repo || !isInside(cwd, state.repo.root)) await loadProject(cwd)
}
const toggle = (id: string) => (expanded.value = expanded.value === id ? null : id)

// ligar a conversa a uma tarefa do Ovseer
const linking = ref<string | null>(null)
const canLink = computed(() => state.tasks.length > 0)
function startLink(a: AgentSession) {
  linking.value = linking.value === a.id ? null : a.id
}
/** Sugestão para conversas trabalhando e ainda sem tarefa: só quando há palavras em comum. */
function suggestion(a: AgentSession) {
  if (!a.running || !canLink.value || taskOfAgent(a)) return null
  const best = suggestTasks(a)[0]
  return best && best.score > 0 ? best.task : null
}

async function pick(a: AgentSession, taskId: string | null) {
  linking.value = null
  await linkAgent(a.id, taskId)
}

watch(open, (v) => v && groups.value.forEach((g) => loadProjectIcon(g.cwd)))
const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  tick = setInterval(() => (now.value = Date.now()), 20_000)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  clearInterval(tick)
})
</script>

<template>
  <div v-if="state.agents.length" ref="root" class="agents">
    <button
      class="chip"
      :class="{ busy: running, on: open }"
      title="Agentes de IA (ChatGPT e Claude)"
      @click="open = !open"
    >
      <span v-if="running" class="dot live" />
      <Icon v-else name="check" :size="12" />
      <template v-if="running">{{ running }} trabalhando</template>
      <template v-else>{{ done }} {{ done === 1 ? 'terminou' : 'terminaram' }}</template>
    </button>

    <div v-if="open" class="pop">
      <header>
        <strong>Agentes de IA</strong>
        <span class="faint">
          <template v-if="running">{{ running }} trabalhando</template><template v-if="running && done"> · </template><template v-if="done">{{ done }} {{ done === 1 ? 'terminou' : 'terminaram' }}</template>
        </span>
      </header>

      <section v-for="g in groups" :key="g.cwd">
        <div class="proj">
          <img v-if="projectIcons.get(g.cwd)" :src="projectIcons.get(g.cwd)!" class="fav" alt="" />
          <span v-else class="badge">{{ g.name.slice(0, 2).toUpperCase() }}</span>
          <span class="pname ellipsis" :title="g.cwd">{{ g.name }}</span>
          <span v-if="g.items[0].branch" class="branch ellipsis"><Icon name="branch" :size="11" />{{ g.items[0].branch }}</span>
          <button class="ghost open" title="Abrir este projeto no OvrGit" @click="openProject(g.cwd)">
            Abrir <Icon name="chevron" :size="11" />
          </button>
        </div>
        <div
          v-for="a in g.items"
          :key="a.id"
          class="row"
          :class="{ exp: expanded === a.id, click: a.lastMessage }"
          @click="a.lastMessage && toggle(a.id)"
        >
          <div class="line">
            <Icon name="chevron" :size="11" class="caret" :class="{ hide: !a.lastMessage }" />
            <span v-if="a.running" class="dot live" />
            <span v-else class="ok"><Icon name="check" :size="10" /></span>
            <span class="src" :class="a.source" :title="agentName(a)">
              <svg v-if="a.source === 'claude'" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2.5l1.6 6.1 5.5-3.2-3.2 5.5 6.1 1.6-6.1 1.6 3.2 5.5-5.5-3.2L12 22.5l-1.6-6.1-5.5 3.2 3.2-5.5-6.1-1.6 6.1-1.6-3.2-5.5 5.5 3.2z"/></svg>
              <svg v-else viewBox="0 0 24 24" width="12" height="12"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.6"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>
            </span>
            <span class="title ellipsis" :title="`${agentName(a)}: ${a.title}`">{{ a.title || `Tarefa do ${agentName(a)}` }}</span>
            <button
              v-if="taskOfAgent(a)"
              class="task-chip"
              :title="`Ligada à tarefa ${taskOfAgent(a)!.key}: ${taskOfAgent(a)!.title}\nClique para trocar`"
              @click.stop="startLink(a)"
            >
              {{ taskOfAgent(a)!.key }}
            </button>
            <button
              v-else-if="canLink"
              class="link-btn"
              title="Ligar esta conversa a uma tarefa do Ovseer"
              @click.stop="startLink(a)"
            >
              <Icon name="task" :size="11" /> Tarefa
            </button>
            <span class="meta">
              <span v-if="took(a)" class="took" :title="a.running ? 'Trabalhando há' : 'Levou'">{{ took(a) }}</span>
              <span class="when">{{ a.running ? '' : ago(a.completedAt ?? a.updatedAt) }}</span>
            </span>
          </div>
          <div v-if="suggestion(a) && linking !== a.id" class="hint" @click.stop>
            <span class="faint lead">Parece ser</span>
            <span class="k">{{ suggestion(a)!.key }}</span>
            <span class="ellipsis faint">{{ suggestion(a)!.title }}</span>
            <button class="ghost ok-btn" @click="pick(a, suggestion(a)!.id)">Ligar</button>
          </div>
          <div v-if="linking === a.id" class="picker" @click.stop>
            <small class="faint">Qual tarefa esta conversa está fazendo?</small>
            <button
              v-for="(s, i) in suggestTasks(a).slice(0, 6)"
              :key="s.task.id"
              class="ghost opt"
              :class="{ cur: taskOfAgent(a)?.id === s.task.id }"
              @click="pick(a, s.task.id)"
            >
              <span class="k">{{ s.task.key }}</span>
              <span class="ellipsis">{{ s.task.title }}</span>
              <span v-if="i === 0 && s.score > 0 && !taskOfAgent(a)" class="sug">sugerida</span>
            </button>
            <button v-if="state.settings?.agentLinks?.[a.id]" class="ghost opt unlink" @click="pick(a, null)">
              <Icon name="x" :size="11" /> Desligar
            </button>
          </div>
          <p v-if="expanded === a.id && a.lastMessage" class="msg">{{ a.lastMessage }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.agents { position: relative; -webkit-app-region: no-drag; }
.chip { height: 26px; padding: 0 10px; gap: 7px; font-size: 12px; border-radius: 999px; }
.chip.on { background: var(--hover); }
.chip.busy { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
.dot.live { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); } 50% { box-shadow: 0 0 0 4px transparent; } }

.pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: min(400px, calc(100vw - 24px));
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  max-height: min(70vh, 560px); overflow: auto; padding: 4px 0 6px; animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 10px 14px 8px; }
header strong { font-size: 13px; }
header span { font-size: 11.5px; }

section { padding: 2px 6px 4px; }
section + section { border-top: 1px solid var(--border); padding-top: 6px; }
.proj { display: flex; align-items: center; gap: 8px; padding: 6px 8px; min-width: 0; }
.fav { width: 18px; height: 18px; border-radius: 4px; object-fit: contain; flex: none; }
.badge {
  width: 18px; height: 18px; border-radius: 4px; flex: none; display: grid; place-items: center;
  font-size: 8.5px; font-weight: 800; color: #fff; background: var(--accent);
}
.pname { font-size: 12.5px; font-weight: 700; flex: none; max-width: 45%; }
.branch { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--faint); min-width: 0; }
.open { margin-left: auto; height: 22px; padding: 0 6px; font-size: 11px; gap: 3px; color: var(--muted); opacity: 0; flex: none; }
.proj:hover .open { opacity: 1; }

.row { border-radius: 8px; cursor: default; }
.row:hover, .row.exp { background: var(--hover); }
.line { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px 0 4px; min-width: 0; }
.row.click { cursor: pointer; }
.caret { color: var(--faint); flex: none; transition: transform 0.12s; }
.caret.hide { visibility: hidden; }
.row.exp .caret { transform: rotate(90deg); }
.ok {
  width: 14px; height: 14px; border-radius: 50%; flex: none; display: grid; place-items: center;
  background: var(--add-bg); color: var(--add);
}
.line > .dot { margin: 0 3.5px; }
.src { flex: none; display: grid; place-items: center; width: 14px; height: 14px; color: var(--faint); }
.src.claude { color: #d97757; }
.src.codex { color: var(--muted); }
.title { flex: 1; min-width: 0; font-size: 12.5px; }
.meta { display: flex; gap: 10px; flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
.took { color: var(--faint); }
.when { color: var(--muted); min-width: 34px; text-align: right; }
.task-chip {
  height: 18px; padding: 0 7px; font-size: 10.5px; font-weight: 800; letter-spacing: 0.02em; flex: none;
  color: var(--accent); background: var(--accent-soft); border: 0; border-radius: 999px; font-family: var(--mono, monospace);
}
.link-btn {
  height: 20px; padding: 0 7px; gap: 4px; font-size: 11px; flex: none; color: var(--muted);
  border-radius: 999px; border: 1px dashed var(--border); opacity: 0.7;
}
.row:hover .link-btn { opacity: 1; color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.hint { display: flex; align-items: center; gap: 6px; margin: -2px 8px 6px 44px; font-size: 11.5px; min-width: 0; }
.hint .lead { white-space: nowrap; flex: none; }
.hint .k { font-family: var(--mono, monospace); font-size: 10.5px; font-weight: 800; color: var(--accent); flex: none; }
.ok-btn { margin-left: auto; height: 20px; padding: 0 8px; font-size: 11px; font-weight: 700; color: var(--accent); flex: none; }
.picker { display: flex; flex-direction: column; gap: 1px; margin: 0 8px 8px 44px; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.picker small { padding: 2px 6px 5px; font-size: 11px; }
.opt { justify-content: flex-start; gap: 8px; height: 28px; padding: 0 6px; font-size: 12px; min-width: 0; }
.opt .k { font-family: var(--mono, monospace); font-size: 10.5px; font-weight: 800; color: var(--accent); flex: none; }
.opt.cur { background: var(--accent-soft); }
.sug { margin-left: auto; font-size: 10px; font-weight: 700; color: var(--add); background: var(--add-bg); padding: 1px 6px; border-radius: 999px; flex: none; }
.unlink { color: var(--del); }
.msg {
  margin: 0 10px 10px 48px; padding-top: 2px; font-size: 12px; line-height: 1.5; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; user-select: text;
}
</style>
