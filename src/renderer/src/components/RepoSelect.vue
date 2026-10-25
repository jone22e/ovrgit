<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, loadProjectIcon, projectIcons, saveSettings, state } from '../store'
import { groupMatches, groupMembers, groupOf, repoMatches, searchWords } from '@shared/repoGroups'
import type { RepoGroup } from '@shared/types'
import Icon from './Icon.vue'
import RepoIcon from './RepoIcon.vue'
import RepoIconPicker from './RepoIconPicker.vue'

/**
 * Seletor de repositório: o ícone do projeto e o nome num botão; a lista (grupos salvos, projeto aberto e recentes,
 * com ícones) abre embaixo. `any`: oferece "Qualquer repositório" (valor vazio). Um grupo define o principal (o
 * primeiro repositório dele) e os outros vão em `extra`; o botão mostra o nome do grupo.
 */
const model = defineModel<string>({ required: true })
const extra = defineModel<string[]>('extra', { default: () => [] })
const props = defineProps<{ any?: boolean; anyLabel?: string }>()
const groups = computed(() => state.settings?.repoGroups ?? [])
const group = computed(() => (model.value ? groupOf(groups.value, model.value, extra.value) : undefined))
function chooseGroup(g: RepoGroup) {
  model.value = g.dirs[0] ?? ''
  extra.value = g.dirs.slice(1)
  open.value = false
}
const open = ref(false)
const root = ref<HTMLElement>()
const popEl = ref<HTMLElement>()
/** O menu é desenhado no corpo da página (fora de diálogos e colunas que recortam), na posição do botão */
const popStyle = ref<Record<string, string>>({})
function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const width = Math.max(r.width, 300)
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
  // abre para baixo; sem espaço, para cima
  const below = window.innerHeight - r.bottom - 12
  const height = Math.min(320, Math.max(120, below >= 200 ? below : r.top - 12))
  const up = below < 200 && r.top > below
  popStyle.value = { left: `${left}px`, width: `${width}px`, maxHeight: `${height}px`, ...(up ? { bottom: `${window.innerHeight - r.top + 6}px` } : { top: `${r.bottom + 6}px` }) }
}
function toggle() {
  open.value = !open.value
  if (open.value) {
    query.value = ''
    place()
    nextTick(() => searchInput.value?.focus())
  }
}
const projects = ref<string[]>([])
const options = computed(() => [...new Set([state.repo?.root ?? '', ...projects.value].filter(Boolean))])
const query = ref('')
const searchInput = ref<HTMLInputElement>()
const words = computed(() => searchWords(query.value))
const shownGroups = computed(() => groups.value.filter((g) => groupMatches(words.value, g)))
const shownOptions = computed(() => options.value.filter((p) => repoMatches(words.value, p)))
function chooseFirst() {
  if (!query.value.trim()) return
  if (shownGroups.value[0]) chooseGroup(shownGroups.value[0])
  else if (shownOptions.value[0]) choose(shownOptions.value[0])
}
function onSearchEsc() {
  if (query.value) query.value = ''
  else open.value = false
}
const name = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const dir = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const icon = (p: string) => projectIcons.get(p) ?? null
const custom = (p: string) => state.settings?.repoIcons?.[p] ?? null
const editingIcon = ref<{ kind: 'repo' | 'group'; id: string; name: string } | null>(null)
function editIcon(kind: 'repo' | 'group', id: string, name: string) {
  open.value = false
  editingIcon.value = { kind, id, name }
}
const currentIcon = computed(() => editingIcon.value?.kind === 'group' ? groups.value.find((g) => g.id === editingIcon.value?.id)?.icon : editingIcon.value ? custom(editingIcon.value.id) : null)
async function chooseIcon(icon: string | null) {
  const target = editingIcon.value
  if (!target) return
  try {
    const s = await api.getSettings()
    if (target.kind === 'group') {
      await saveSettings({ repoGroups: s.repoGroups.map((g) => g.id === target.id ? { ...g, icon: icon ?? undefined } : g) })
    } else {
      const repoIcons = { ...(s.repoIcons ?? {}) }
      if (icon) repoIcons[target.id] = icon
      else delete repoIcons[target.id]
      await saveSettings({ repoIcons })
    }
    editingIcon.value = null
  } catch (e) {
    state.error = String((e as Error).message)
  }
}

onMounted(async () => {
  projects.value = await api.agentProjects().catch(() => [])
  for (const p of options.value) loadProjectIcon(p)
})
watch(options, (l) => l.forEach(loadProjectIcon))
function choose(p: string) {
  model.value = p
  extra.value = []
  open.value = false
}
const onDoc = (e: MouseEvent) => {
  const t = e.target as Node
  if (open.value && root.value && !root.value.contains(t) && !popEl.value?.contains(t)) open.value = false
}
/** A página rolou ou mudou de tamanho: o menu (posicionado na tela) fecha; rolar dentro dele não conta */
const onMove = (e?: Event) => {
  if (e && popEl.value && e.target instanceof Node && popEl.value.contains(e.target)) return
  open.value = false
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onMove)
  window.addEventListener('scroll', onMove, true)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onMove)
  window.removeEventListener('scroll', onMove, true)
})
</script>

<template>
  <span ref="root" class="repo-select" :class="{ on: open }">
    <button type="button" class="sel" :title="group ? [model, ...extra].join('\n') : model || (props.any ? props.anyLabel || 'Qualquer repositório' : '')" @click="toggle">
      <template v-if="group">
        <RepoIcon :icon="group.icon" group :size="16" />
        <span class="ellipsis">{{ group.name }}</span>
      </template>
      <template v-else-if="model">
        <RepoIcon :icon="custom(model)" :favicon="icon(model)" :size="16" />
        <span class="ellipsis">{{ name(model) }}</span>
      </template>
      <template v-else>
        <Icon name="layers" :size="14" class="faint" />
        <span class="ellipsis faint-text">{{ props.anyLabel || 'Qualquer repositório' }}</span>
      </template>
      <Icon name="chevron" :size="12" class="chev" />
    </button>
    <Teleport to="body">
    <div v-if="open" ref="popEl" class="repo-select-pop" role="listbox" :style="popStyle">
      <label class="search">
        <Icon name="search" :size="13" />
        <input ref="searchInput" v-model="query" type="text" placeholder="Buscar repositório ou grupo" spellcheck="false" @keydown.esc.stop.prevent="onSearchEsc" @keydown.enter.prevent="chooseFirst" />
        <button v-if="query" type="button" class="ghost clear" title="Limpar busca" @click="query = ''; searchInput?.focus()"><Icon name="x" :size="12" /></button>
      </label>
      <button v-if="props.any && !words.length" type="button" class="ghost opt" :class="{ cur: !model }" @click="choose('')">
        <Icon name="layers" :size="14" class="faint" />
        <span class="txt"><span class="nm ellipsis">{{ props.anyLabel || 'Qualquer repositório' }}</span><small class="faint ellipsis">{{ props.anyLabel ? 'Consulte todos os agentes ou indique o projeto no pedido' : 'o próximo agente em espera livre, de qualquer projeto' }}</small></span>
        <Icon v-if="!model" name="check" :size="13" class="ok" />
      </button>
      <!-- grupos salvos: o principal mais os juntados, de uma vez -->
      <template v-if="shownGroups.length">
        <h6>Grupos</h6>
        <button v-for="g in shownGroups" :key="g.id" type="button" class="ghost opt" :class="{ cur: group?.id === g.id }" :title="g.dirs.join('\n')" @click="chooseGroup(g)">
          <RepoIcon :icon="g.icon" group :size="17" />
          <span class="txt"><span class="nm ellipsis">{{ g.name }}</span><small class="faint ellipsis">{{ groupMembers(g) }}</small></span>
          <span class="edit" role="button" tabindex="0" :title="g.icon ? 'Trocar ícone do grupo' : 'Escolher ícone do grupo'" @click.stop="editIcon('group', g.id, g.name)" @keydown.enter.stop.prevent="editIcon('group', g.id, g.name)"><Icon name="sparkles" :size="12" /></span>
          <Icon v-if="group?.id === g.id" name="check" :size="13" class="ok" />
        </button>
      </template>
      <h6 v-if="groups.length && shownOptions.length">Repositórios</h6>
      <button v-for="p in shownOptions" :key="p" type="button" class="ghost opt" :class="{ cur: p === model && !group }" :title="p" @click="choose(p)">
        <RepoIcon :icon="custom(p)" :favicon="icon(p)" :size="17" />
        <span class="txt"><span class="nm ellipsis">{{ name(p) }}</span><small class="faint ellipsis">{{ dir(p) }}</small></span>
        <span class="edit" role="button" tabindex="0" :title="custom(p) ? 'Trocar ícone' : 'Escolher ícone'" @click.stop="editIcon('repo', p, name(p))" @keydown.enter.stop.prevent="editIcon('repo', p, name(p))"><Icon name="sparkles" :size="12" /></span>
        <Icon v-if="p === model && !group" name="check" :size="13" class="ok" />
      </button>
      <p v-if="words.length && !shownGroups.length && !shownOptions.length" class="none">Nenhum grupo ou repositório encontrado.</p>
    </div>
    </Teleport>
    <RepoIconPicker v-if="editingIcon" :title="editingIcon.name" :current="currentIcon" @close="editingIcon = null" @choose="chooseIcon" />
  </span>
</template>

<style scoped>
.repo-select { position: relative; display: inline-flex; min-width: 0; }
.sel { display: inline-flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 13px; font-weight: 500; text-align: left; min-width: 0; }
.sel:hover, .repo-select.on .sel { border-color: color-mix(in srgb, var(--text) 25%, var(--border)); background: var(--hover); }
.sel .ellipsis { flex: 1; min-width: 0; }
.faint-text { color: var(--muted); font-weight: 400; }
.fav { width: 16px; height: 16px; border-radius: 4px; flex: none; }
.chev { color: var(--faint); transform: rotate(90deg); flex: none; }
.repo-select-pop { position: fixed; z-index: 90; box-sizing: border-box; overflow: hidden auto; padding: 6px; border-radius: 12px; background: var(--panel); border: 1px solid var(--border); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); display: flex; flex-direction: column; gap: 2px; animation: drop 0.12s ease-out; }
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
.search { position: sticky; top: 0; z-index: 1; flex: none; display: flex; align-items: center; gap: 6px; height: 30px; margin: 2px 4px 4px; padding: 0 7px 0 9px; border: 1px solid var(--border); border-radius: 7px; color: var(--faint); background: var(--bg); }
.search:focus-within { border-color: var(--accent); }
.search input, .search input[type='text']:focus { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; border-radius: 0; box-shadow: none; background: transparent; color: var(--text); font-size: 12.5px; }
.search .clear { width: 20px; height: 20px; padding: 0; flex: none; }
.none { margin: 8px 10px; color: var(--muted); font-size: 12px; }
.opt { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 10px; justify-content: flex-start; color: var(--text); min-width: 0; flex: none; }
.opt.cur { background: var(--accent-soft); }
.txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; text-align: left; }
.nm { font-size: 13px; font-weight: 500; }
.txt small { font-size: 11px; }
.ok { color: var(--accent); flex: none; }
.grp { color: var(--accent); flex: none; }
.edit { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: var(--faint); flex: none; cursor: pointer; }
.edit:hover, .edit:focus-visible { color: var(--accent); background: var(--accent-soft); }
h6 { margin: 6px 10px 2px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
</style>
