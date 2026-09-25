<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { FileChange } from '@shared/types'
import {
  analyze, cancelAnalysis, hasPlan, openPlan, resolveConflict, selectFile, setViewMode, state, toggleAll,
  toggleCollapsed, toggleFile, toggleFiles
} from '../store'
import Icon from './Icon.vue'

type Row =
  | { kind: 'dir'; key: string; depth: number; name: string; files: string[] }
  | { kind: 'file'; key: string; depth: number; file: FileChange }

interface Dir {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: FileChange[]
}

const files = computed(() => state.repo?.files ?? [])
const total = computed(() => files.value.length)
const allChecked = computed(() => total.value > 0 && state.selected.size === total.value)
const someChecked = computed(() => state.selected.size > 0 && !allChecked.value)

function descendants(d: Dir): string[] {
  return [...d.files.map((f) => f.path), ...[...d.dirs.values()].flatMap(descendants)]
}

/** Árvore de pastas, com pastas de filho único compactadas ("src/renderer/src"), como no VS Code. */
const rows = computed<Row[]>(() => {
  if (state.viewMode === 'list') {
    const sorted = [...files.value].sort(
      (a, b) => Number(b.kind === 'conflict') - Number(a.kind === 'conflict') || a.path.localeCompare(b.path)
    )
    return sorted.map((f) => ({ kind: 'file', key: f.path, depth: 0, file: f }))
  }
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files.value) {
    const parts = f.path.split('/')
    let cur = root
    for (const part of parts.slice(0, -1)) {
      const path = cur.path ? `${cur.path}/${part}` : part
      if (!cur.dirs.has(part)) cur.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      cur = cur.dirs.get(part)!
    }
    cur.files.push(f)
  }
  const out: Row[] = []
  const walk = (d: Dir, depth: number) => {
    for (const child of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let node = child
      let name = child.name
      while (node.files.length === 0 && node.dirs.size === 1) {
        node = [...node.dirs.values()][0]
        name = `${name}/${node.name}`
      }
      out.push({ kind: 'dir', key: `d:${node.path}`, depth, name, files: descendants(node) })
      if (!state.collapsed.has(node.path)) walk(node, depth + 1)
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path)))
      out.push({ kind: 'file', key: f.path, depth, file: f })
  }
  walk(root, 0)
  return out
})

function dirState(paths: string[]) {
  const n = paths.filter((p) => state.selected.has(p)).length
  return { checked: n === paths.length, indeterminate: n > 0 && n < paths.length }
}

const KIND_LETTER: Record<string, string> = {
  added: 'A', untracked: 'A', modified: 'M', deleted: 'D', renamed: 'R', conflict: '!', typechange: 'T'
}
const KIND_LABEL: Record<string, string> = {
  added: 'adicionado', untracked: 'novo', modified: 'modificado', deleted: 'removido', renamed: 'renomeado',
  conflict: 'em conflito', typechange: 'tipo alterado'
}

function split(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

// cronômetro da análise
const elapsed = ref(0)
let tick: ReturnType<typeof setInterval> | undefined
watch(
  () => state.busy === 'analyze',
  (on) => {
    clearInterval(tick)
    elapsed.value = 0
    if (on) tick = setInterval(() => (elapsed.value = Math.round((Date.now() - state.analyzeStartedAt) / 1000)), 500)
  }
)
onUnmounted(() => clearInterval(tick))
</script>

<template>
  <div class="list">
    <div class="toolbar">
      <label class="all" :title="allChecked ? 'Desmarcar tudo' : 'Marcar tudo'">
        <input type="checkbox" :checked="allChecked" :indeterminate="someChecked" @change="toggleAll" />
        <strong>{{ total }}</strong>
        <span class="muted label-long">arquivo{{ total === 1 ? '' : 's' }} alterado{{ total === 1 ? '' : 's' }}</span>
      </label>

      <div class="seg" role="group" aria-label="Modo de exibição">
        <button :class="{ on: state.viewMode === 'tree' }" title="Agrupar por pasta" @click="setViewMode('tree')">
          <Icon name="folder" :size="14" />
        </button>
        <button :class="{ on: state.viewMode === 'list' }" title="Lista única" @click="setViewMode('list')">
          <Icon name="list" :size="14" />
        </button>
      </div>

      <template v-if="state.busy === 'analyze'">
        <span class="analyzing"><span class="spinner" /> Analisando… {{ elapsed }}s</span>
        <button class="small" title="Cancelar a análise" @click="cancelAnalysis">Cancelar</button>
      </template>
      <template v-else>
        <button
          v-if="hasPlan"
          class="small plan"
          :class="{ stale: state.planStale }"
          :title="state.planStale ? 'Commits sugeridos pela IA (os arquivos mudaram desde a análise)' : 'Ver os commits sugeridos pela IA'"
          @click="openPlan"
        >
          <Icon name="layers" :size="14" /> {{ state.groups.length }} commit{{ state.groups.length === 1 ? '' : 's' }}
        </button>
        <button
          class="small ai"
          :disabled="!total || !!state.busy || !!state.repo?.operation"
          :title="hasPlan ? 'Pedir uma nova análise à IA' : 'A IA separa as alterações em commits organizados (Ctrl/⌘+I)'"
          @click="analyze(hasPlan)"
        >
          <Icon name="sparkles" :size="14" />
          <span class="lbl">{{ hasPlan ? 'Reanalisar' : 'Analisar com IA' }}</span>
        </button>
      </template>

    </div>

    <div v-if="!total" class="empty">
      <Icon name="check" :size="28" />
      <p>Nenhuma alteração pendente.</p>
      <p v-if="state.repo?.ahead" class="faint">{{ state.repo.ahead }} commit(s) local(is) aguardando Enviar.</p>
    </div>

    <div class="scroll">
      <template v-for="r in rows" :key="r.key">
        <div
          v-if="r.kind === 'dir'"
          class="row dir"
          :style="{ paddingLeft: `${10 + r.depth * 16}px` }"
          @click="toggleCollapsed(r.key.slice(2))"
        >
          <input
            type="checkbox"
            :checked="dirState(r.files).checked"
            :indeterminate="dirState(r.files).indeterminate"
            @click.stop
            @change="toggleFiles(r.files)"
          />
          <Icon name="chevron" :size="13" class="chev" :class="{ open: !state.collapsed.has(r.key.slice(2)) }" />
          <span class="dirname ellipsis">{{ r.name }}</span>
          <span class="faint n">{{ r.files.length }}</span>
        </div>

        <div
          v-else
          class="row file"
          :class="{ active: state.activeFile?.path === r.file.path, conflict: r.file.kind === 'conflict' }"
          :style="{ paddingLeft: `${(state.viewMode === 'tree' ? 29 : 10) + r.depth * 16}px` }"
          :title="`${r.file.origPath ? `${r.file.origPath} → ` : ''}${r.file.path} (${KIND_LABEL[r.file.kind]})`"
          @click="selectFile(r.file)"
        >
          <input type="checkbox" :checked="state.selected.has(r.file.path)" @click.stop @change="toggleFile(r.file.path)" />
          <span class="kind" :class="r.file.kind">{{ KIND_LETTER[r.file.kind] }}</span>
          <span class="path ellipsis">
            <template v-if="state.viewMode === 'list'"><span class="faint">{{ split(r.file.path).dir }}</span></template>{{ split(r.file.path).name }}
          </span>
          <span v-if="r.file.kind === 'conflict'" class="resolve" @click.stop>
            <button class="small" :disabled="!!state.busy" title="Ficar com a minha versão (local)" @click="resolveConflict(r.file.path, 'mine')">Minha</button>
            <button class="small" :disabled="!!state.busy" title="Ficar com a versão que veio do remoto" @click="resolveConflict(r.file.path, 'theirs')">Remota</button>
            <button class="small" :disabled="!!state.busy" title="Já editei o arquivo e resolvi os marcadores <<<<<<< / >>>>>>>" @click="resolveConflict(r.file.path, 'resolved')">Resolvido</button>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.list { display: flex; flex-direction: column; min-height: 0; height: 100%; container-type: inline-size; }
.toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--border);
}
.all { display: flex; align-items: center; gap: 8px; flex: 1; cursor: pointer; min-width: 0; white-space: nowrap; }
.seg { display: flex; padding: 2px; gap: 2px; background: var(--panel-2); border-radius: 8px; }
.seg button { height: 24px; width: 28px; padding: 0; border: 0; background: transparent; color: var(--muted); border-radius: 6px; }
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.ai { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.plan { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.plan.stale { background: transparent; border-color: var(--border); color: var(--muted); }
.analyzing { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); font-size: 12px; font-variant-numeric: tabular-nums; }
.scroll { overflow: auto; flex: 1; padding: 6px 6px 12px; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 48px 16px; color: var(--muted); gap: 4px; }
.empty p { margin: 0; }
.row { display: flex; align-items: center; gap: 8px; height: 28px; padding-right: 8px; border-radius: 6px; cursor: pointer; }
.row:hover { background: var(--hover); }
.dir .chev { color: var(--faint); transition: transform 0.12s; margin: 0 -3px; }
.dir .chev.open { transform: rotate(90deg); }
.dirname { font-weight: 600; font-size: 12.5px; }
.n { font-size: 11.5px; margin-left: auto; }
.file.active { background: var(--accent-soft); }
.file.conflict { background: var(--del-bg); height: 32px; }
.path { font-size: 12.5px; min-width: 0; }
.resolve { display: flex; gap: 4px; margin-left: auto; flex: none; }
.resolve button { height: 22px; padding: 0 8px; font-size: 11.5px; }
/* adapta à largura do painel (que encolhe quando o diff está aberto), não só da janela */
@container (max-width: 560px) {
  .label-long { display: none; }
}
@container (max-width: 400px) {
  .lbl { display: none; }
  .toolbar { gap: 6px; padding: 8px 10px; }
}
</style>
