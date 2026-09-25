<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ProjectOverview } from '@shared/types'
import { forgetProject, isInside, loadProject, loadProjectIcon, openProject, projectIcons, state } from '../store'
import Icon from './Icon.vue'

const open = defineModel<boolean>('open', { default: false })
const query = ref('')
const index = ref(0)
const input = ref<HTMLInputElement>()
const root = ref<HTMLElement>()
const mod = window.ovrgit.platform === 'darwin' ? '⌘' : 'Ctrl+'

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// situação de cada projeto (só leitura local, rápido): linha, alterações, o que falta enviar/baixar
const overview = ref(new Map<string, ProjectOverview>())
async function loadOverview() {
  const list = await window.ovrgit.projectsOverview([...(state.settings?.recentProjects ?? [])]).catch(() => [])
  overview.value = new Map(list.map((o) => [o.root, o]))
}
function badges(p: string) {
  const o = overview.value.get(p)
  if (!o) return []
  if (!o.ok) return [{ t: 'Pasta não encontrada', c: 'bad' }]
  const out: { t: string; c: string }[] = []
  if (o.operation) out.push({ t: o.conflicts ? 'Conflito para resolver' : 'Junção pela metade', c: 'bad' })
  if (o.changes) out.push({ t: `${o.changes} ${o.changes === 1 ? 'alteração' : 'alterações'}`, c: 'warn' })
  const send = o.published ? o.ahead : o.unpublished
  if (send) out.push({ t: `${send} para enviar`, c: 'acc' })
  if (o.behind) out.push({ t: `${o.behind} para baixar`, c: 'acc' })
  const agent = state.agents.find((a) => a.running && isInside(a.cwd, p))
  if (agent) out.push({ t: 'Codex trabalhando', c: 'agent' })
  return out
}

const items = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = state.settings?.recentProjects ?? []
  return q ? list.filter((p) => p.toLowerCase().includes(q)) : list
})

watch(
  () => state.repo?.root,
  (r) => r && loadProjectIcon(r),
  { immediate: true }
)

watch(open, async (v) => {
  if (!v) return
  items.value.forEach(loadProjectIcon)
  loadOverview()
  query.value = ''
  const cur = items.value.indexOf(state.repo?.root ?? '')
  index.value = cur >= 0 && items.value.length > 1 ? (cur === 0 ? 1 : 0) : 0
  await nextTick()
  input.value?.focus()
})
watch(query, () => (index.value = 0))

async function choose(p: string) {
  open.value = false
  if (p !== state.repo?.root) await loadProject(p)
}

function browse() {
  open.value = false
  openProject()
}

function onKey(e: KeyboardEvent) {
  const n = items.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    index.value = n ? (index.value + 1) % n : 0
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    index.value = n ? (index.value - 1 + n) % n : 0
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (items.value[index.value]) choose(items.value[index.value])
    else browse()
  } else if (e.key === 'Escape') {
    open.value = false
  }
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="switcher">
    <button
      class="ghost trigger"
      :class="{ on: open }"
      :title="`Trocar projeto (${mod}P)\n${state.repo?.root ?? ''}`"
      @click="open = !open"
    >
      <img v-if="state.repo && projectIcons.get(state.repo.root)" :src="projectIcons.get(state.repo.root)!" class="favicon" alt="" />
      <Icon v-else name="folder" :size="15" />
      <span class="ellipsis">{{ state.repo?.name }}</span>
      <Icon name="chevron" :size="13" class="chev" />
    </button>

    <div v-if="open" class="pop" @keydown="onKey">
      <input ref="input" v-model="query" type="text" placeholder="Filtrar projetos…" spellcheck="false" />
      <ul v-if="items.length">
        <li
          v-for="(p, i) in items"
          :key="p"
          :class="{ hi: i === index, current: p === state.repo?.root }"
          :title="p"
          @mouseenter="index = i"
          @click="choose(p)"
        >
          <img v-if="projectIcons.get(p)" :src="projectIcons.get(p)!" class="favicon big" alt="" />
          <span v-else class="folder"><Icon name="folder" :size="15" /></span>
          <span class="txt">
            <span class="name ellipsis">
              {{ baseName(p) }}
              <Icon v-if="p === state.repo?.root" name="check" :size="12" class="cur" />
            </span>
            <span class="path faint ellipsis">
              <template v-if="overview.get(p)?.branch">{{ overview.get(p)!.branch }} · </template>{{ p }}
            </span>
            <span v-if="badges(p).length" class="badges">
              <span v-for="b in badges(p)" :key="b.t" class="bd" :class="b.c">{{ b.t }}</span>
            </span>
          </span>
          <button
            v-if="p !== state.repo?.root"
            class="ghost remove"
            title="Remover da lista"
            @click.stop="forgetProject(p)"
          >
            <Icon name="x" :size="12" />
          </button>
        </li>
      </ul>
      <p v-else class="faint empty">Nenhum projeto encontrado.</p>
      <button class="ghost browse clone" @click="(open = false), (state.showClone = true)">
        <Icon name="down" :size="14" />
        Clonar repositório…
      </button>
      <button class="ghost browse" @click="browse">
        <Icon name="folder" :size="14" />
        Abrir outra pasta…
        <span class="kbd faint">{{ mod }}O</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.switcher { position: relative; -webkit-app-region: no-drag; min-width: 0; }
.trigger { max-width: min(280px, 34vw); padding: 0 8px 0 10px; font-weight: 600; gap: 7px; }
.trigger.on { background: var(--hover); }
.chev { transform: rotate(90deg); color: var(--faint); }
.pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40;
  width: min(420px, calc(100vw - 24px)); padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  animation: drop 0.12s ease-out;
}
input { height: 32px; margin-bottom: 4px; }
ul { list-style: none; margin: 0; padding: 0; max-height: 380px; overflow: auto; }
li {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px; border-radius: 7px; cursor: pointer;
}
li.hi { background: var(--hover); }
.favicon { width: 16px; height: 16px; object-fit: contain; border-radius: 3px; flex: none; }
.favicon.big { width: 22px; height: 22px; margin: 0 2px; }
.folder { width: 26px; display: flex; justify-content: center; color: var(--faint); flex: none; }
.cur { color: var(--accent); vertical-align: -1px; margin-left: 3px; }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name { font-weight: 600; }
li.current .name { color: var(--accent); }
.path { font-size: 11px; }
.badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.bd { font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
.bd.warn { color: var(--mod, #d7a13b); background: color-mix(in srgb, var(--mod, #d7a13b) 14%, transparent); }
.bd.acc { color: var(--accent); background: var(--accent-soft); }
.bd.bad { color: var(--del); background: var(--del-bg); }
.bd.agent { color: var(--add); background: var(--add-bg); }
.remove { width: 22px; height: 22px; padding: 0; opacity: 0; flex: none; }
li:hover .remove { opacity: 1; }
.empty { margin: 8px 10px; font-size: 12px; }
.browse.clone { margin-top: 4px; border-top: 1px solid var(--border); border-radius: 0; }
.browse.clone + .browse { margin-top: 0; border-top: 0; }
.browse {
  width: 100%; justify-content: flex-start; margin-top: 4px; height: 32px; padding: 0 8px;
  border-top: 1px solid var(--border); border-radius: 0 0 7px 7px;
}
.kbd { margin-left: auto; font-size: 11px; }
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
</style>
