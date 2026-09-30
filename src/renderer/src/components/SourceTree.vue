<script setup lang="ts">
import { computed, ref } from 'vue'
import { fileMap, loadSourceFiles, openSource, state, toggleSourceDir } from '../store'
import FileIcon from './FileIcon.vue'
import Icon from './Icon.vue'
import NewFileMenu from './NewFileMenu.vue'
import PaneSwitch from './PaneSwitch.vue'

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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') filter.value = ''
  else if (e.key === 'Enter' && matches.value?.length) openSource(matches.value[0])
}
</script>

<template>
  <div class="list">
    <div class="toolbar">
      <PaneSwitch />
      <label class="filter">
        <Icon name="search" :size="13" />
        <input v-model="filter" type="text" placeholder="Filtrar arquivos" spellcheck="false" @keydown="onKey" />
        <button v-if="filter" class="ghost clear" title="Limpar" @click="filter = ''"><Icon name="x" :size="12" /></button>
      </label>
      <button class="ghost icon small" title="Recarregar a lista" @click="loadSourceFiles()">
        <span v-if="state.sourceLoading" class="spinner" />
        <Icon v-else name="refresh" :size="14" />
      </button>
    </div>

    <div v-if="!state.sourceLoading && !rows.length" class="empty faint">
      {{ matches ? 'Nenhum arquivo com esse nome.' : 'Nenhum arquivo no projeto.' }}
    </div>

    <div class="scroll" @contextmenu.prevent="onMenu($event, '')">
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
        </div>
      </template>
      <p v-if="matches && matches.length > MAX_MATCHES" class="more faint">Mostrando os primeiros {{ MAX_MATCHES }}. Refine o filtro.</p>
    </div>
    <NewFileMenu v-if="menu" v-bind="menu" @close="menu = null" />
  </div>
</template>

<style scoped>
.list { display: flex; flex-direction: column; min-height: 0; height: 100%; container-type: inline-size; }
.toolbar {
  display: flex; align-items: center; gap: 8px; flex: none; box-sizing: border-box;
  height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border);
}
.filter {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 9px;
  border: 1px solid var(--border); border-radius: 7px; color: var(--faint); background: var(--panel);
}
.filter:focus-within { border-color: var(--accent); }
.filter input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; height: 100%; font-size: 12.5px; color: var(--text); }
.clear { width: 20px; height: 20px; padding: 0; }
.icon.small { width: 28px; height: 28px; flex: none; }
.scroll { overflow: auto; flex: 1; padding: 6px 6px 12px; }
.empty { padding: 32px 16px; text-align: center; }
.row { display: flex; align-items: center; gap: 6px; height: 24px; padding-right: 8px; border-radius: 5px; cursor: pointer; user-select: none; }
.row:hover { background: var(--hover); }
.dir .chev { color: var(--faint); transition: transform 0.12s; flex: none; margin-right: -2px; }
.dir .chev.open { transform: rotate(90deg); }
.dirname { font-size: 13px; }
.file.active { background: var(--accent-soft); }
.path { font-size: 13px; min-width: 0; flex: 1; }
/* como no JetBrains: o nome do arquivo alterado ganha a cor da alteração */
.path.modified, .path.typechange { color: #5c8fd6; }
.path.added, .path.untracked { color: var(--add); }
.path.conflict { color: var(--del); }
.dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--text); opacity: 0.7; flex: none; }
.more { margin: 8px 10px; font-size: 12px; }
</style>
