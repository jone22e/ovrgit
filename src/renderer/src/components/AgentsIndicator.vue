<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AgentSession } from '@shared/types'
import { isInside, loadProject, state } from '../store'
import Icon from './Icon.vue'

/** Agentes do Codex (app do ChatGPT) trabalhando agora, e os que terminaram há pouco. */
const open = ref(false)
const root = ref<HTMLElement>()
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval>

const running = computed(() => state.agents.filter((a) => a.running))
const done = computed(() => state.agents.filter((a) => !a.running))

function ago(ms: number) {
  const m = Math.max(0, Math.round((now.value - ms) / 60000))
  return m < 1 ? 'agora' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}
const folder = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

async function openProject(a: AgentSession) {
  open.value = false
  if (!state.repo || !isInside(a.cwd, state.repo.root)) await loadProject(a.cwd)
}

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
      :class="{ busy: running.length }"
      :title="running.length ? 'Agentes do ChatGPT (Codex) trabalhando agora' : 'Agentes do ChatGPT (Codex) que terminaram há pouco'"
      @click="open = !open"
    >
      <span v-if="running.length" class="pulse" />
      <Icon v-else name="check" :size="12" />
      {{ running.length ? `${running.length} trabalhando` : `${done.length} ${done.length === 1 ? 'terminou' : 'terminaram'}` }}
    </button>
    <div v-if="open" class="pop">
      <h6 v-if="running.length">Trabalhando agora</h6>
      <div v-for="a in running" :key="a.id" class="item">
        <span class="pulse" />
        <div class="txt">
          <strong class="ellipsis">{{ a.title || 'Tarefa do Codex' }}</strong>
          <small class="faint ellipsis">{{ folder(a.cwd) }}<template v-if="a.branch"> · {{ a.branch }}</template> · há {{ ago(a.startedAt) }}</small>
        </div>
        <button class="ghost small" title="Abrir este projeto no OvrGit" @click="openProject(a)"><Icon name="folder" :size="13" /></button>
      </div>
      <h6 v-if="done.length">Terminaram</h6>
      <div v-for="a in done" :key="a.id" class="item">
        <Icon name="check" :size="14" class="ok" />
        <div class="txt">
          <strong class="ellipsis">{{ a.title || 'Tarefa do Codex' }}</strong>
          <small class="faint ellipsis">{{ folder(a.cwd) }}<template v-if="a.branch"> · {{ a.branch }}</template> · há {{ ago(a.completedAt ?? a.updatedAt) }}</small>
          <p v-if="a.lastMessage" class="last">{{ a.lastMessage }}</p>
        </div>
        <button class="ghost small" title="Abrir este projeto e ver as alterações" @click="openProject(a)"><Icon name="folder" :size="13" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agents { position: relative; -webkit-app-region: no-drag; }
.chip { height: 26px; padding: 0 10px; gap: 7px; font-size: 12px; border-radius: 999px; }
.chip.busy { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
.pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: min(420px, calc(100vw - 24px)); padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  max-height: 60vh; overflow: auto;
}
h6 { margin: 8px 8px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.item { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 8px; }
.item:hover { background: var(--hover); }
.item > .ok { margin-top: 3px; }
.item > .pulse { margin: 6px 3px 0; }
.ok { color: var(--add); flex: none; }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.txt strong { font-size: 12.5px; }
.txt small { font-size: 11px; }
.last { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.small { width: 26px; height: 26px; padding: 0; flex: none; }
</style>
