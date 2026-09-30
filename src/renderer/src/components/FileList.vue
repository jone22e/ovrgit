<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FileChange } from '@shared/types'
import {
  discardFiles, hasPlan, isPartial, openPlan, refresh, resolveWithAi, resolveConflict, selectFile, setViewMode, state, toggleAll,
  toggleCollapsed, toggleFile, toggleFiles
} from '../store'
import { isTestFile } from '@shared/parse'
import Icon from './Icon.vue'
import PaneSwitch from './PaneSwitch.vue'

type Row =
  | { kind: 'dir'; key: string; depth: number; name: string; files: string[] }
  /** Subpasta dentro de um grupo: só um rótulo (caminho relativo ao grupo), sem caixa nem recolher */
  | { kind: 'sub'; key: string; prefix: string; last: string }
  | { kind: 'file'; key: string; depth: number; file: FileChange }

/** Filtro da lista: todos, só código ou só testes (a escolha fica guardada) */
type Filter = 'all' | 'code' | 'tests'
const FILTER_KEY = 'ovseer.changesFilter'
const readFilter = (): Filter => {
  try {
    const v = localStorage.getItem(FILTER_KEY)
    return v === 'code' || v === 'tests' ? v : 'all'
  } catch {
    return 'all'
  }
}
const filter = ref<Filter>(readFilter())
function setFilter(f: Filter) {
  filter.value = f
  try {
    localStorage.setItem(FILTER_KEY, f)
  } catch {
    /* só nesta sessão */
  }
}

interface Dir {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: FileChange[]
}

const allFiles = computed(() => state.repo?.files ?? [])
const testCount = computed(() => allFiles.value.filter((f) => isTestFile(f.path)).length)
const codeCount = computed(() => allFiles.value.length - testCount.value)
const FILTERS = computed<{ id: Filter; label: string; n: number | null }[]>(() => [
  { id: 'all', label: 'Todos', n: null },
  { id: 'code', label: 'Código', n: codeCount.value },
  { id: 'tests', label: 'Testes', n: testCount.value }
])
/** Arquivos mostrados: os do filtro (com o filtro sem resultado, cai para todos) */
const files = computed(() => {
  const all = allFiles.value
  if (filter.value === 'all') return all
  const sel = all.filter((f) => isTestFile(f.path) === (filter.value === 'tests'))
  return sel.length ? sel : all
})
const total = computed(() => allFiles.value.length)
/** Soma das linhas adicionadas e removidas dos arquivos mostrados */
const totals = computed(() => files.value.reduce((t, f) => ({ add: t.add + (f.stats?.add ?? 0), del: t.del + (f.stats?.del ?? 0) }), { add: 0, del: 0 }))
/** Proporção adicionado/removido em cinco blocos, como no GitHub */
function blocks(f: FileChange): ('add' | 'del' | 'none')[] {
  const st = f.stats
  if (!st || st.add + st.del === 0) return Array(5).fill('none')
  let a = Math.round((5 * st.add) / (st.add + st.del))
  if (st.del && a === 5) a = 4
  if (st.add && a === 0) a = 1
  return [...Array(a).fill('add'), ...Array(5 - a).fill('del')]
}
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
  const byPath = (a: FileChange, b: FileChange) => a.path.localeCompare(b.path)
  // arquivos na raiz do projeto: sem grupo
  for (const f of [...root.files].sort(byPath)) out.push({ kind: 'file', key: f.path, depth: 0, file: f })
  // um grupo por pasta de primeiro nível (compactada enquanto tiver um filho só); dentro dele, as subpastas
  // viram rótulos com o caminho relativo ao grupo, e os arquivos ficam todos no mesmo nível
  for (const child of [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    let node = child
    let name = child.name
    while (node.files.length === 0 && node.dirs.size === 1) {
      node = [...node.dirs.values()][0]
      name = `${name}/${node.name}`
    }
    out.push({ kind: 'dir', key: `d:${node.path}`, depth: 0, name, files: descendants(node) })
    if (state.collapsed.has(node.path)) continue
    const leaves: { rel: string; files: FileChange[] }[] = []
    const collect = (d: Dir, rel: string) => {
      if (d.files.length) leaves.push({ rel, files: [...d.files].sort(byPath) })
      for (const sd of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) collect(sd, rel ? `${rel}/${sd.name}` : sd.name)
    }
    collect(node, '')
    for (const leaf of leaves) {
      if (leaf.rel) {
        const i = leaf.rel.lastIndexOf('/')
        out.push({ kind: 'sub', key: `s:${node.path}/${leaf.rel}`, prefix: i < 0 ? '' : leaf.rel.slice(0, i + 1), last: leaf.rel.slice(i + 1) })
      }
      for (const f of leaf.files) out.push({ kind: 'file', key: f.path, depth: 1, file: f })
    }
  }
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

</script>

<template>
  <div class="list">
    <div class="toolbar">
      <PaneSwitch />
      <span class="spacer" />
      <button
        v-if="state.selected.size && !state.repo?.operation"
        class="ghost icon small discard-sel"
        :title="`Descartar as alterações dos ${state.selected.size} arquivo(s) marcados. Dá para recuperar depois.`"
        @click="discardFiles([...state.selected])"
      >
        <Icon name="trash" :size="14" />
      </button>
      <div class="seg" role="group" aria-label="Modo de exibição">
        <button :class="{ on: state.viewMode === 'tree' }" title="Agrupar por pasta" @click="setViewMode('tree')">
          <Icon name="folder" :size="14" />
        </button>
        <button :class="{ on: state.viewMode === 'list' }" title="Lista única" @click="setViewMode('list')">
          <Icon name="list" :size="14" />
        </button>
      </div>
      <button class="ghost icon small reload" title="Atualizar (Ctrl/⌘+R)" :disabled="state.busy === 'load'" @click="refresh()">
        <Icon name="refresh" :size="14" />
      </button>

      <button
        v-if="hasPlan && state.busy !== 'analyze'"
        class="small plan"
        :class="{ stale: state.planStale }"
        :title="state.planStale ? 'Versões sugeridas pela IA (os arquivos mudaram desde a análise)' : 'Ver as versões sugeridas pela IA'"
        @click="openPlan"
      >
        <Icon name="layers" :size="14" /> {{ state.groups.length }} {{ state.groups.length === 1 ? 'versão' : 'versões' }}
      </button>

    </div>
    <!-- resumo e filtro: linha própria abaixo da barra -->
    <div v-if="total" class="summary">
      <label class="all" :title="allChecked ? 'Desmarcar tudo' : 'Marcar tudo'">
        <input type="checkbox" :checked="allChecked" :indeterminate="someChecked" @change="toggleAll" />
        <strong>{{ state.selected.size }} de {{ total }}</strong>
        <span class="muted label-long">arquivo{{ total === 1 ? '' : 's' }}</span>
        <span v-if="totals.add || totals.del" class="totals label-long"><b class="add">+{{ totals.add }}</b> <b class="del">−{{ totals.del }}</b></span>
      </label>
      <div v-if="testCount && codeCount" class="seg filters" role="group" aria-label="Filtro">
        <button v-for="f in FILTERS" :key="f.id" :class="{ on: filter === f.id }" :title="f.id === 'all' ? 'Todos os arquivos' : f.id === 'code' ? 'Só os arquivos de código' : 'Só os arquivos de teste'" @click="setFilter(f.id)">
          {{ f.label }}<span v-if="f.n !== null" class="fn">{{ f.n }}</span>
        </button>
      </div>

    </div>

    <div v-if="!total" class="empty">
      <Icon name="check" :size="28" />
      <p>Nenhuma alteração pendente.</p>
      <p v-if="state.repo?.ahead" class="faint">{{ state.repo.ahead }} versão(ões) salva(s) esperando você Enviar.</p>
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
          <button
            v-if="!state.repo?.operation"
            class="ghost row-act"
            :title="`Descartar as alterações desta pasta (${r.files.length} arquivo(s)). Dá para recuperar depois.`"
            @click.stop="discardFiles(r.files)"
          >
            <Icon name="trash" :size="13" />
          </button>
          <span class="faint n">{{ r.files.length }}</span>
        </div>

        <div v-else-if="r.kind === 'sub'" class="row sub">
          <span class="ellipsis"><span class="faint">{{ r.prefix }}</span><b>{{ r.last }}</b></span>
        </div>

        <div
          v-else
          class="row file"
          :class="{ active: state.activeFile?.path === r.file.path, conflict: r.file.kind === 'conflict' }"
          :style="{ paddingLeft: `${(state.viewMode === 'tree' ? 29 : 10) + r.depth * 16}px` }"
          :title="`${r.file.origPath ? `${r.file.origPath} → ` : ''}${r.file.path} (${KIND_LABEL[r.file.kind]})`"
          @click="selectFile(r.file)"
        >
          <input
            type="checkbox"
            :checked="state.selected.has(r.file.path)"
            :indeterminate="isPartial(r.file.path)"
            :title="isPartial(r.file.path) ? 'Só alguns trechos deste arquivo vão para a versão (veja no diff)' : undefined"
            @click.stop
            @change="toggleFile(r.file.path)"
          />
          <span class="kind" :class="r.file.kind">{{ KIND_LETTER[r.file.kind] }}</span>
          <span class="path ellipsis">
            <template v-if="state.viewMode === 'list'"><span class="faint">{{ split(r.file.path).dir }}</span></template>{{ split(r.file.path).name }}
          </span>
          <span v-if="isTestFile(r.file.path)" class="tbadge" title="Arquivo de teste">T</span>
          <span v-if="r.file.stats && r.file.kind !== 'conflict'" class="stats" :title="`${r.file.stats.add} linha(s) adicionada(s), ${r.file.stats.del} removida(s)`">
            <b class="add">+{{ r.file.stats.add }}</b><b class="del">−{{ r.file.stats.del }}</b>
            <span class="bar"><i v-for="(b, i) in blocks(r.file)" :key="i" :class="b" /></span>
          </span>
          <button
            v-if="r.file.kind !== 'conflict' && !state.repo?.operation"
            class="ghost row-act"
            title="Descartar as alterações deste arquivo (volta a ficar como estava). Dá para recuperar depois."
            @click.stop="discardFiles([r.file.path])"
          >
            <Icon name="trash" :size="13" />
          </button>
          <span v-if="r.file.kind === 'conflict'" class="resolve" @click.stop>
            <button class="small" :disabled="!!state.busy" title="Ficar com a minha versão (local)" @click="resolveConflict(r.file.path, 'mine')">Minha</button>
            <button class="small" :disabled="!!state.busy" title="Ficar com a versão que veio do remoto" @click="resolveConflict(r.file.path, 'theirs')">Remota</button>
            <button class="small" :disabled="!!state.busy" title="Já editei o arquivo e resolvi os marcadores <<<<<<< / >>>>>>>" @click="resolveConflict(r.file.path, 'resolved')">Resolvido</button>
            <button class="small ai-fix" :disabled="!!state.busy" title="A IA propõe como combinar as duas versões; você confere antes de usar" @click="resolveWithAi(r.file.path)"><Icon name="sparkles" :size="12" /> IA</button>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.list { display: flex; flex-direction: column; min-height: 0; height: 100%; container-type: inline-size; }
.toolbar {
  display: flex; align-items: center; gap: 8px; flex: none; box-sizing: border-box;
  height: var(--pane-header); padding: 0 12px; border-bottom: 1px solid var(--border);
}
.all { display: flex; align-items: center; gap: 8px; flex: 1; cursor: pointer; min-width: 0; white-space: nowrap; overflow: hidden; }
.spacer { flex: 1; }
.summary {
  display: flex; align-items: center; gap: 8px; flex: none; box-sizing: border-box; height: 36px; padding: 0 12px;
  border-bottom: 1px solid var(--border); font-size: 12.5px;
}
.seg { display: flex; padding: 2px; gap: 2px; background: var(--panel-2); border-radius: 8px; }
.seg button { height: 24px; width: 28px; padding: 0; border: 0; background: transparent; color: var(--muted); border-radius: 6px; }
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.plan { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.plan.stale { background: transparent; border-color: var(--border); color: var(--muted); }
.scroll { overflow: auto; flex: 1; padding: 6px 6px 12px; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 48px 16px; color: var(--muted); gap: 4px; }
.empty p { margin: 0; }
.row { display: flex; align-items: center; gap: 8px; height: 28px; padding-right: 8px; border-radius: 6px; cursor: pointer; }
.row:hover { background: var(--hover); }
.row-act { width: 24px; height: 22px; padding: 0; opacity: 0; flex: none; margin-left: auto; color: var(--muted); }
.row:hover .row-act { opacity: 1; }
.row-act:hover, .discard-sel:hover { color: var(--del); background: var(--del-bg) !important; }
.row.dir .row-act + .n { margin-left: 0; }
.discard-sel, .reload { width: 28px; height: 28px; color: var(--muted); }
.dir .chev { color: var(--faint); transition: transform 0.12s; margin: 0 -3px; }
.dir .chev.open { transform: rotate(90deg); }
.dirname { font-weight: 600; font-size: 12.5px; }
/* subpasta dentro do grupo: rótulo discreto, com o caminho relativo e a última pasta em destaque */
.row.sub { height: 24px; padding-left: 30px; cursor: default; font-size: 12px; color: var(--muted); margin-top: 2px; }
.row.sub:hover { background: transparent; }
.row.sub b { font-weight: 600; color: var(--text); }
.tbadge { flex: none; font-size: 10px; font-weight: 700; line-height: 1; padding: 3px 5px; border-radius: 4px; color: var(--add); background: color-mix(in srgb, var(--add) 16%, transparent); }
/* linhas adicionadas/removidas e a barrinha de proporção, à direita */
.stats { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex: none; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.stats .add, .totals .add { color: var(--add); font-weight: 600; }
.stats .del, .totals .del { color: var(--del); font-weight: 600; }
.stats .del { margin-left: 2px; }
.bar { display: inline-flex; gap: 1px; margin-left: 4px; }
.bar i { width: 7px; height: 7px; border-radius: 1.5px; background: var(--faint); opacity: 0.35; }
.bar i.add { background: var(--add); opacity: 1; }
.bar i.del { background: var(--del); opacity: 1; }
.stats + .row-act, .tbadge + .row-act { margin-left: 0; }
.totals { font-size: 12px; margin-left: 2px; }
.filters button { width: auto; padding: 0 9px; font-size: 12px; gap: 4px; }
.filters .fn { color: var(--faint); font-variant-numeric: tabular-nums; }
.filters button.on .fn { color: var(--muted); }
.n { font-size: 11.5px; margin-left: auto; }
.file.active { background: var(--accent-soft); }
.file.conflict { background: var(--del-bg); height: 32px; }
.path { font-size: 12.5px; min-width: 0; }
.resolve { display: flex; gap: 4px; margin-left: auto; flex: none; }
.resolve button { height: 22px; padding: 0 8px; font-size: 11.5px; }
.resolve .ai-fix { color: var(--accent); gap: 4px; }
/* adapta à largura do painel (que encolhe quando o diff está aberto), não só da janela */
@container (max-width: 700px) {
  .bar { display: none; }
}
@container (max-width: 520px) {
  .label-long { display: none; }
  .filters .fn { display: none; }
}
@container (max-width: 400px) {
  .toolbar, .summary { gap: 6px; padding: 0 10px; }
}
@container (max-width: 380px) {
  .totals { display: none; }
}
/* painel bem estreito: o atualizar fica só pelo atalho */
@container (max-width: 340px) {
  .reload { display: none; }
}
</style>
