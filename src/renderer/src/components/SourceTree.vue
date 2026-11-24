<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { fileMap, loadSourceFiles, openResolvedSource, openSource, state, toggleSourceDir } from '../store'
import FileIcon from './FileIcon.vue'
import Icon from './Icon.vue'
import NewFileMenu from './NewFileMenu.vue'

/**
 * Todos os arquivos do projeto (versionados e novos não ignorados), em árvore com as pastas fechadas.
 * Com texto no filtro, vira uma lista dos caminhos que batem. Clique abre o arquivo no editor à direita.
 */
type Row =
  | { kind: 'dir'; key: string; depth: number; name: string; path: string }
  | { kind: 'file'; key: string; depth: number; path: string }

interface Dir {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: string[]
}

const filter = ref('')
const rootOpen = ref(true)
const project = computed(() => state.repo?.root.split(/[/\\]/).filter(Boolean).pop() ?? '')
const changeMark: Record<string, string> = { added: 'A', untracked: 'U', modified: 'M', deleted: 'D', renamed: 'R', conflict: '!', typechange: 'T' }
function collapseAll() {
  state.sourceOpen = new Set()
}
const resolved = ref<{ root: string; path: string } | null>(null)
const pathQuery = (q: string) => q.includes('/') || /^[a-z]:[\\/]/i.test(q)
let pathTimer: ReturnType<typeof setTimeout> | undefined
let pathRequest = 0
watch(filter, (q) => {
  clearTimeout(pathTimer)
  resolved.value = null
  const request = ++pathRequest
  if (!pathQuery(q)) return
  pathTimer = setTimeout(() => {
    window.ovseer.sourceResolvePath(q).then((found) => { if (request === pathRequest) resolved.value = found }).catch(() => undefined)
  }, 120)
})
onUnmounted(() => clearTimeout(pathTimer))
const MAX_MATCHES = 300

const tree = computed(() => {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const p of state.sourceList) {
    const parts = p.split('/')
    let cur = root
    for (const part of parts.slice(0, -1)) {
      const path = cur.path ? `${cur.path}/${part}` : part
      if (!cur.dirs.has(part)) cur.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      cur = cur.dirs.get(part)!
      }
    cur.files.push(p)
  }
  return root
})

/** Todas as palavras do filtro aparecem no caminho, em qualquer ordem */
const matches = computed(() => {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const out: string[] = []
  for (const p of state.sourceList) {
    const l = p.toLowerCase()
    if (words.every((w) => l.includes(w))) out.push(p)
    if (out.length > MAX_MATCHES) break
  }
  return out
})
const direct = computed(() => resolved.value && (resolved.value.root !== state.repo?.root || !matches.value?.includes(resolved.value.path)) ? resolved.value : null)
async function openDirect(found: { root: string; path: string }) {
  try { await openResolvedSource(found) }
  catch (e) { state.error = String((e as Error).message) }
}

const rows = computed<Row[]>(() => {
  if (matches.value) return matches.value.slice(0, MAX_MATCHES).map((p) => ({ kind: 'file', key: p, depth: 0, path: p }))
  const out: Row[] = []
  const walk = (d: Dir, depth: number) => {
    for (const child of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      // pastas de filho único compactadas ("src/renderer/src"), como no VS Code
      let node = child
      let name = child.name
      while (node.files.length === 0 && node.dirs.size === 1) {
        node = [...node.dirs.values()][0]
        name = `${name}/${node.name}`
      }
      out.push({ kind: 'dir', key: `d:${node.path}`, depth, name, path: node.path })
      if (state.sourceOpen.has(node.path)) walk(node, depth + 1)
    }
    for (const f of [...d.files].sort((a, b) => a.localeCompare(b))) out.push({ kind: 'file', key: f, depth, path: f })
  }
  walk(tree.value, 0)
  return out
})

const changeOf = (p: string) => fileMap.value.get(p)?.kind
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)

// menu do botão direito: cria arquivos na pasta clicada (num arquivo, na pasta dele; no vazio, na raiz)
const menu = ref<{ x: number; y: number; dir: string; target?: string } | null>(null)
function onMenu(e: MouseEvent, dirPath: string, target?: string) {
  menu.value = { x: e.clientX, y: e.clientY, dir: dirPath, target }
}

// o arquivo aberto no editor fica à vista na árvore (as pastas até ele já abrem ao abrir o arquivo). Se a linha
// ainda não existe (a lista de arquivos não chegou), tenta de novo quando a árvore mudar; abrir e fechar pastas
// depois disso não mexe na rolagem
const scroller = ref<HTMLElement>()
let pending = false
async function reveal() {
  await nextTick()
  const el = scroller.value?.querySelector<HTMLElement>('.row.file.active')
  el?.scrollIntoView({ block: 'nearest' })
  pending = !el
}
watch(
  () => state.sourcePath,
  (p) => {
    if (p) { rootOpen.value = true; void reveal() }
  },
  { immediate: true }
)
watch(
  () => rows.value.length,
  () => pending && reveal()
)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') filter.value = ''
  else if (e.key === 'Enter') {
    if (direct.value) void openDirect(direct.value)
    else if (pathQuery(filter.value)) void window.ovseer.sourceResolvePath(filter.value).then((found) => {
      if (found) void openDirect(found)
      else if (matches.value?.length) openSource(matches.value[0])
    })
    else if (matches.value?.length) openSource(matches.value[0])
  }
}
</script>

<template>
  <div class="list">
    <header class="explorer-head">
      <span>EXPLORADOR</span>
      <button class="ghost icon small" title="Ações de arquivos" aria-label="Ações de arquivos" @click="onMenu($event, '')"><Icon name="ellipsis" :size="16" /></button>
    </header>
    <div class="project-bar">
      <button class="project-name" :aria-expanded="rootOpen" :title="state.repo?.root" @click="rootOpen = !rootOpen">
        <Icon name="chevron" :size="12" class="chev" :class="{ open: rootOpen }" />
        <strong class="ellipsis">{{ project }}</strong>
      </button>
      <div class="project-actions">
        <button class="ghost icon small" title="Novo arquivo…" aria-label="Novo arquivo" @click="onMenu($event, '')"><Icon name="compose" :size="14" /></button>
        <button class="ghost icon small" title="Recarregar arquivos" aria-label="Recarregar arquivos" @click="loadSourceFiles()"><span v-if="state.sourceLoading" class="spinner" /><Icon v-else name="refresh" :size="14" /></button>
        <button class="ghost icon small" title="Recolher pastas" aria-label="Recolher pastas" @click="collapseAll"><Icon name="layers" :size="14" /></button>
      </div>
    </div>
    <div v-show="rootOpen" class="toolbar">
      <label class="filter">
        <Icon name="search" :size="13" />
        <input v-model="filter" type="text" placeholder="Filtrar arquivos" spellcheck="false" @keydown="onKey" />
        <button v-if="filter" class="ghost clear" title="Limpar" @click="filter = ''"><Icon name="x" :size="12" /></button>
      </label>
    </div>

    <div v-if="rootOpen && !state.sourceLoading && !rows.length && !direct" class="empty faint">
      {{ matches ? 'Nenhum arquivo com esse nome.' : 'Nenhum arquivo no projeto.' }}
    </div>

    <div v-show="rootOpen" ref="scroller" class="scroll" @contextmenu.prevent="onMenu($event, '')">
      <div v-if="direct" class="row file" :title="`${direct.root}/${direct.path}`" @click="openDirect(direct)">
        <FileIcon :path="direct.path" />
        <span class="path ellipsis"><span class="faint">{{ direct.root }}/{{ dir(direct.path) }}</span>{{ name(direct.path) }}</span>
      </div>
      <template v-for="r in rows" :key="r.key">
        <div v-if="r.kind === 'dir'" class="row dir" :style="{ paddingLeft: `${6 + r.depth * 16}px` }" @click="toggleSourceDir(r.path)" @contextmenu.prevent.stop="onMenu($event, r.path)">
          <Icon name="chevron" :size="12" class="chev" :class="{ open: state.sourceOpen.has(r.path) }" />
          <FileIcon :path="r.path" dir :open="state.sourceOpen.has(r.path)" />
          <span class="dirname ellipsis">{{ r.name }}</span>
        </div>
        <div
          v-else
          class="row file"
          :class="{ active: state.sourcePath === r.path }"
          :style="{ paddingLeft: `${(matches ? 8 : 26) + r.depth * 16}px` }"
          :title="r.path"
          @click="openSource(r.path)"
          @dblclick="openSource(r.path, true)"
          @contextmenu.prevent.stop="onMenu($event, dir(r.path).replace(/\/$/, ''), r.path)"
        >
          <FileIcon :path="r.path" />
          <span class="path ellipsis" :class="changeOf(r.path)">
            <span v-if="matches" class="faint">{{ dir(r.path) }}</span>{{ name(r.path) }}
          </span>
          <span v-if="r.path in state.sourceDrafts" class="dirty" title="Alterações não salvas" />
          <span v-if="changeOf(r.path)" class="change-mark" :class="changeOf(r.path)">{{ changeMark[changeOf(r.path) ?? ''] }}</span>
        </div>
      </template>
      <p v-if="matches && matches.length > MAX_MATCHES" class="more faint">Mostrando os primeiros {{ MAX_MATCHES }}. Refine o filtro.</p>
    </div>
    <NewFileMenu v-if="menu" v-bind="menu" @close="menu = null" />
  </div>
</template>

<style scoped>
.list { display: flex; flex-direction: column; min-height: 0; height: 100%; container-type: inline-size; background: var(--panel); }
.explorer-head { display: flex; align-items: center; justify-content: space-between; height: 35px; padding: 0 12px 0 20px; flex: none; font-size: 11px; letter-spacing: .04em; }
.project-bar { display: flex; align-items: center; gap: 4px; height: 27px; padding: 0 6px; flex: none; }
.project-name { flex: 1; min-width: 0; justify-content: flex-start; gap: 4px; height: 25px; padding: 0; border: 0; border-radius: 0; background: transparent; text-align: left; }
.project-name strong { font-size: 11px; text-transform: uppercase; }
.project-actions { display: flex; gap: 1px; }
.chev { transition: transform .12s; flex: none; }
.chev.open { transform: rotate(90deg); }
.toolbar {
  display: flex; align-items: center; flex: none; box-sizing: border-box;
  height: 34px; padding: 0 12px 6px;
}
.filter {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 8px;
  border: 1px solid var(--border); border-radius: 3px; color: var(--faint); background: var(--bg);
}
.filter:focus-within { border-color: var(--accent); }
.filter input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; height: 100%; font-size: 12.5px; color: var(--text); }
.clear { width: 20px; height: 20px; padding: 0; }
.icon.small { width: 23px; height: 23px; flex: none; padding: 0; border-radius: 3px; color: var(--muted); }
.scroll { overflow: auto; flex: 1; padding: 0 0 12px; }
.empty { padding: 32px 16px; text-align: center; }
.row { display: flex; align-items: center; gap: 6px; height: 22px; padding-right: 12px; cursor: pointer; user-select: none; }
.row:hover { background: var(--hover); }
.dir .chev { color: var(--faint); margin-right: -2px; }
.dir .chev.open { transform: rotate(90deg); }
.dirname { font-size: 13px; }
.file.active { background: var(--accent-soft); outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: -1px; }
.path { font-size: 13px; min-width: 0; flex: 1; }
.path.modified, .path.typechange, .change-mark.modified, .change-mark.typechange { color: #5c8fd6; }
.path.added, .path.untracked, .change-mark.added, .change-mark.untracked { color: var(--add); }
.path.conflict, .change-mark.conflict, .change-mark.deleted { color: var(--del); }
.change-mark { margin-left: auto; flex: none; font-size: 11px; font-weight: 600; }
.dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--text); opacity: 0.7; flex: none; }
.more { margin: 8px 10px; font-size: 12px; }
</style>
