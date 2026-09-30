<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { loadProject, loadProjectIcon, loadSourceFiles, openNewAgent, openSource, projectIcons, setPane, state } from '../store'
import FileIcon from './FileIcon.vue'
import Icon from './Icon.vue'

/**
 * Buscador (Shift Shift, de qualquer lugar do app): arquivos do projeto e repositórios recentes, na mesma lista.
 * Sem digitar: os arquivos abertos há pouco, os alterados e os outros repositórios; digitando: os que batem melhor
 * primeiro. Enter abre o arquivo no editor ou troca de repositório. Sem resultado, oferece perguntar ao agente.
 */
const emit = defineEmits<{ close: [] }>()
const query = ref('')
const index = ref(0)
const input = ref<HTMLInputElement>()
const listEl = ref<HTMLElement>()

interface Item {
  path: string
  /** Rótulo da situação no git (M, A…) */
  status?: string
  /** Repositório (pasta de projeto), não arquivo */
  repo?: boolean
}
/** Outros repositórios abertos antes (o atual fica de fora) */
const repos = computed(() => (state.settings?.recentProjects ?? []).filter((p) => p !== state.repo?.root))
const repoItem = (path: string): Item => ({ path, repo: true })
const KIND_LETTER: Record<string, string> = { added: 'A', untracked: 'A', modified: 'M', deleted: 'D', renamed: 'R', conflict: '!', typechange: 'T' }
const changed = computed(() => new Map((state.repo?.files ?? []).map((f) => [f.path, KIND_LETTER[f.kind] ?? 'M'])))
const item = (path: string): Item => ({ path, status: changed.value.get(path) })

/** Recentes: os abertos há pouco no editor (a lista fica guardada) */
const RECENT_KEY = 'ovseer.recentFiles'
const recentVersion = ref(0)
const recent = computed<string[]>(() => {
  recentVersion.value // muda quando a lista é limpa
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]
    return list.filter((p) => state.sourceList.includes(p) || changed.value.has(p))
  } catch {
    return []
  }
})
function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    /* sem armazenamento */
  }
  recentVersion.value++
  index.value = 0
}
type Group = { label: string; items: Item[] }
/** Estado vazio: recentes e alterados (sem repetir) */
const groups = computed<Group[]>(() => {
  const q = query.value.trim()
  if (q) {
    const files = search(q)
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    // repositórios: pelo nome da pasta (o caminho inteiro faria "flexi" bater com tudo dentro de ~/Flexi)
    const rs = repos.value.filter((p) => words.every((w) => base(p).toLowerCase().includes(w))).slice(0, 6).map(repoItem)
    return [...(files.length ? [{ label: 'Arquivos', items: files }] : []), ...(rs.length ? [{ label: 'Repositórios', items: rs }] : [])]
  }
  const seen = new Set<string>()
  const take = (paths: string[], max: number) => paths.filter((p) => !seen.has(p) && seen.add(p)).slice(0, max).map(item)
  const rec = take(recent.value, 6)
  const alt = take([...changed.value.keys()].sort(), 8)
  const rs = repos.value.slice(0, 6).map(repoItem)
  return [
    ...(rec.length ? [{ label: 'Recentes', items: rec }] : []),
    ...(alt.length ? [{ label: 'Alterados', items: alt }] : []),
    ...(rs.length ? [{ label: 'Repositórios', items: rs }] : [])
  ]
})
const flat = computed(() => groups.value.flatMap((g) => g.items))
const noResult = computed(() => !!query.value.trim() && !flat.value.length)
const placeholder = computed(() => (state.repo ? 'Buscar arquivo ou repositório' : 'Buscar repositório'))

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
/**
 * Pontuação simples: nome começando pelo texto vale mais; depois nome contendo; depois todas as palavras no
 * caminho (em qualquer ordem). Caminhos mais curtos desempatam.
 */
function search(q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const first = words[0] ?? ''
  const all = [...new Set([...state.sourceList, ...changed.value.keys()])]
  const scored: { path: string; score: number }[] = []
  for (const p of all) {
    const low = p.toLowerCase()
    if (!words.every((w) => low.includes(w))) continue
    const name = base(low)
    const score = name.startsWith(first) ? 3 : name.includes(first) ? 2 : 1
    scored.push({ path: p, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, 40)
    .map((s) => item(s.path))
}

function open(path: string) {
  try {
    const list = [path, ...recent.value.filter((p) => p !== path)].slice(0, 12)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* só nesta sessão */
  }
  state.tab = 'changes'
  setPane('files')
  openSource(path)
  emit('close')
}
function ask() {
  const q = query.value.trim()
  emit('close')
  openNewAgent(null, { label: `Perguntar: ${q}`, message: q })
}
async function switchRepo(path: string) {
  emit('close')
  await loadProject(path)
}
function choose() {
  if (noResult.value) return ask()
  const it = flat.value[index.value]
  if (!it) return
  if (it.repo) switchRepo(it.path)
  else open(it.path)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') return emit('close')
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = flat.value.length
    if (!n) return
    index.value = (index.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    nextTick(() => listEl.value?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }))
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    choose()
  }
}
watch(query, () => (index.value = 0))
onMounted(() => {
  if (state.repo && !state.sourceList.length) loadSourceFiles()
  repos.value.forEach(loadProjectIcon)
  input.value?.focus()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')">
    <div class="palette" role="dialog" aria-modal="true">
      <label class="field">
        <Icon name="search" :size="15" class="faint" />
        <input ref="input" v-model="query" type="text" :placeholder="placeholder" spellcheck="false" autocomplete="off" />
        <kbd class="faint">esc</kbd>
      </label>
      <div ref="listEl" class="results">
        <template v-if="noResult">
          <p class="faint none">Nenhum arquivo com esse nome.</p>
          <button class="ghost row cur" @click="ask">
            <Icon name="sparkles" :size="14" class="accent" />
            <span class="name">Perguntar ao agente: "{{ query.trim() }}"</span>
            <kbd class="faint">↵</kbd>
          </button>
        </template>
        <template v-else-if="flat.length">
          <template v-for="g in groups" :key="g.label">
            <h6>
              {{ g.label }}
              <button v-if="g.label === 'Recentes'" class="ghost clear" title="Limpar os recentes" @click="clearRecent">limpar</button>
            </h6>
            <button
              v-for="it in g.items"
              :key="it.path"
              class="ghost row"
              :class="{ cur: flat[index]?.path === it.path }"
              :title="it.path"
              @mouseenter="index = flat.indexOf(it)"
              @click="it.repo ? switchRepo(it.path) : open(it.path)"
            >
              <template v-if="it.repo">
                <img v-if="projectIcons.get(it.path)" :src="projectIcons.get(it.path)!" class="fav" alt="" />
                <Icon v-else name="folder" :size="15" class="faint" />
              </template>
              <FileIcon v-else :path="it.path" :size="15" />
              <span class="name ellipsis">{{ base(it.path) }}</span>
              <span v-if="dir(it.path)" class="dir faint ellipsis">{{ dir(it.path) }}</span>
              <span v-if="it.status" class="status" :class="{ add: it.status === 'A', del: it.status === 'D' || it.status === '!' }">{{ it.status }}</span>
            </button>
          </template>
        </template>
        <p v-else class="faint none">{{ state.sourceLoading ? 'Carregando a lista de arquivos…' : 'Digite o nome de um arquivo ou de um repositório.' }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.35); display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; animation: fade 0.1s ease-out; }
@keyframes fade { from { opacity: 0; } }
.palette {
  width: min(560px, calc(100vw - 32px)); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
}
.field { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 46px; border-bottom: 1px solid var(--border); }
.field input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; font-size: 15px; color: var(--text); }
.field input:focus { box-shadow: none; }
kbd { font-family: var(--mono); font-size: 11px; }
.results { overflow: auto; padding: 6px; }
h6 { margin: 8px 8px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); display: flex; align-items: center; justify-content: space-between; }
/* só aparece ao passar o mouse pelo grupo */
.clear { height: 18px; padding: 0 6px; font-size: 10.5px; text-transform: none; letter-spacing: 0; color: var(--faint); opacity: 0; }
.results:hover .clear { opacity: 1; }
.clear:hover { color: var(--text); }
.row { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border-radius: 8px; justify-content: flex-start; color: var(--text); font-size: 13px; text-align: left; }
.row.cur { background: var(--accent-soft); }
.name { flex: none; max-width: 60%; }
.dir { flex: 1; min-width: 0; font-size: 12px; }
.status { flex: none; font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--mod); }
.status.add { color: var(--add); }
.status.del { color: var(--del); }
.accent { color: var(--accent); }
.none { margin: 10px 8px; font-size: 12.5px; }
.fav { width: 15px; height: 15px; border-radius: 3px; flex: none; }
</style>
