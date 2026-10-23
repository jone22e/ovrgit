<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { RepoGroup } from '@shared/types'
import { groupMatches, groupMembers, groupOf, repoMatches, repoName, saveGroup, searchWords } from '@shared/repoGroups'
import Icon from './Icon.vue'
import RepoIcon from './RepoIcon.vue'
import RepoIconPicker from './RepoIconPicker.vue'

/**
 * Repositórios da conversa do agente: um chip em destaque com a pasta principal e, se houver, os outros do
 * espaço de trabalho ("flexi2 + separador"). A lista de repositórios recentes (os do seletor de projeto) troca
 * o principal enquanto a conversa não começou, e adiciona ou tira os outros a qualquer momento.
 *
 * Um conjunto que se repete pode ser salvo como grupo, com nome: quando o espaço de trabalho é exatamente um
 * grupo salvo, o chip mostra o nome do grupo no lugar dos chips, e a lista aplica qualquer grupo com um clique.
 *
 * Um campo de busca no topo filtra grupos e repositórios; Enter escolhe o primeiro da lista.
 */
const props = defineProps<{
  /** Pasta atual */
  cwd: string
  /** Nome exibido (a pasta) */
  project: string
  /** Pode trocar: a conversa ainda não recebeu a primeira mensagem */
  switchable: boolean
  /** Outros repositórios do espaço de trabalho */
  extra?: string[]
  /** Pode adicionar e tirar outros repositórios */
  extensible?: boolean
  /** Lista centralizada abaixo do chip (estado vazio); senão alinhada à esquerda (cabeçalho) */
  center?: boolean
  /** Chip maior, no título do estado vazio */
  big?: boolean
}>()
const emit = defineEmits<{ choose: [path: string]; pick: []; add: [path: string]; remove: [path: string]; pickExtra: []; apply: [group: RepoGroup] }>()
const api = window.ovseer

const open = ref(false)
const root = ref<HTMLElement>()
const popEl = ref<HTMLElement>()
/** A lista vai para o body (a janela do agente rola e cortava o menu); a posição sai do chip */
const popStyle = ref<Record<string, string>>({})
function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const width = Math.min(400, Math.max(240, window.innerWidth - 16))
  const anchor = props.center ? r.left + r.width / 2 - width / 2 : r.left
  const left = Math.max(8, Math.min(anchor, window.innerWidth - width - 8))
  const below = window.innerHeight - r.bottom - 12
  const above = r.top - 12
  const up = below < 240 && above > below
  popStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(440, Math.max(120, up ? above : below))}px`,
    ...(up ? { bottom: `${window.innerHeight - r.top + 6}px` } : { top: `${r.bottom + 6}px` })
  }
}
const projects = ref<string[]>([])
const icons = reactive(new Map<string, string | null>())
const customIcons = ref<Record<string, string>>({})
const custom = (p: string) => customIcons.value[p] ?? null
function loadIcon(p: string) {
  if (icons.has(p)) return
  icons.set(p, null)
  api.projectIcon(p).then((i) => icons.set(p, i)).catch(() => undefined)
}
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
      const repoGroups = (s.repoGroups ?? []).map((g) => g.id === target.id ? { ...g, icon: icon ?? undefined } : g)
      const next = await api.saveSettings({ repoGroups })
      groups.value = next.repoGroups
    } else {
      const repoIcons = { ...(s.repoIcons ?? {}) }
      if (icon) repoIcons[target.id] = icon
      else delete repoIcons[target.id]
      const next = await api.saveSettings({ repoIcons })
      customIcons.value = next.repoIcons
    }
    editingIcon.value = null
  } catch (e) {
    alert(`Não foi possível salvar o ícone: ${String((e as Error).message)}`)
  }
}

/* busca: filtra grupos e pastas pelo nome; consultas com / ou \\ procuram no caminho */
const query = ref('')
const searchInput = ref<HTMLInputElement>()
const words = computed(() => searchWords(query.value))
const shownProjects = computed(() => projects.value.filter((p) => repoMatches(words.value, p)))
const base = repoName
const dir = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')

const extras = computed(() => props.extra ?? [])
/** No cabeçalho (chip pequeno) um juntado aparece com nome; mais que isso viram "+N outros" */
const HEAD_MAX = 1
const shownExtra = computed(() => (props.big || extras.value.length <= HEAD_MAX ? extras.value : []))
const hiddenExtra = computed(() => extras.value.length - shownExtra.value.length)

/* grupos salvos (configurações): o chip vira o nome do grupo quando o espaço de trabalho é exatamente um deles */
const groups = ref<RepoGroup[]>([])
async function loadGroups() {
  const s = await api.getSettings().catch(() => null)
  groups.value = s?.repoGroups ?? []
  customIcons.value = s?.repoIcons ?? {}
}
const shownGroups = computed(() => (props.extensible ? groups.value.filter((g) => groupMatches(words.value, g)) : []))
const group = computed(() => groupOf(groups.value, props.cwd, extras.value))
const isCur = (g: RepoGroup) => group.value?.id === g.id
const chipTitle = computed(() => {
  const what = props.switchable ? 'Clique para trocar o repositório, juntar outros ou escolher um grupo' : props.extensible ? 'Clique para juntar outros repositórios à conversa ou escolher um grupo' : ''
  const where = group.value ? [props.cwd, ...extras.value].join('\n') : props.cwd
  return [where, what].filter(Boolean).join('\n')
})
/** Dá para salvar: há juntados e o conjunto ainda não é um grupo salvo */
const canSave = computed(() => !!props.extensible && extras.value.length > 0 && !group.value)
const naming = ref(false)
const nameDraft = ref('')
const nameInput = ref<HTMLInputElement>()
function startNaming() {
  naming.value = true
  nameDraft.value = ''
  nextTick(() => nameInput.value?.focus())
}
async function saveAsGroup() {
  const name = nameDraft.value.trim()
  if (!name) return nameInput.value?.focus()
  // lê as configurações de novo: outra janela pode ter salvo um grupo enquanto esta lista estava aberta
  const s = await api.getSettings().catch(() => null)
  const next = saveGroup(s?.repoGroups ?? groups.value, name, [props.cwd, ...extras.value])
  groups.value = next
  naming.value = false
  open.value = false
  await api.saveSettings({ repoGroups: next }).catch(() => undefined)
}
async function removeGroup(g: RepoGroup) {
  if (!confirm(`Tirar o grupo "${g.name}" da lista? Os repositórios continuam na conversa.`)) return
  const s = await api.getSettings().catch(() => null)
  const next = (s?.repoGroups ?? groups.value).filter((x) => x.id !== g.id)
  groups.value = next
  await api.saveSettings({ repoGroups: next }).catch(() => undefined)
}
function apply(g: RepoGroup) {
  open.value = false
  if (!isCur(g)) emit('apply', g)
}

const canOpen = () => props.switchable || !!props.extensible
const inExtra = (p: string) => extras.value.includes(p)
async function toggle() {
  if (!canOpen()) return
  open.value = !open.value
  naming.value = false
  if (!open.value) return
  query.value = ''
  place()
  nextTick(() => searchInput.value?.focus())
  loadGroups()
  projects.value = await api.agentProjects().catch(() => [])
  for (const p of projects.value) loadIcon(p)
}
function choose(p: string) {
  if (p === props.cwd) return (open.value = false)
  if (props.switchable) {
    open.value = false
    emit('choose', p)
  } else if (props.extensible) toggleExtra(p)
}
/** Entra ou sai do espaço de trabalho (a lista fica aberta para marcar vários) */
function toggleExtra(p: string) {
  if (!props.extensible || p === props.cwd) return
  if (inExtra(p)) emit('remove', p)
  else emit('add', p)
}
function pickExtra() {
  open.value = false
  emit('pickExtra')
}
/** Esc na busca: limpa; já vazia, fecha a lista */
function onSearchEsc() {
  if (query.value) query.value = ''
  else open.value = false
}
/** Enter na busca: o primeiro da lista (grupo ou repositório) */
function chooseFirst() {
  if (!query.value.trim()) return
  const g = shownGroups.value[0]
  if (g) return apply(g)
  const p = shownProjects.value[0]
  if (p) choose(p)
}
function pick() {
  open.value = false
  emit('pick')
}
const onDoc = (e: MouseEvent) => {
  const t = e.target as Node
  if (open.value && root.value && !root.value.contains(t) && !popEl.value?.contains(t)) open.value = false
}
const onResize = () => open.value && place()
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) open.value = false
}
watch(() => props.switchable || !!props.extensible, (s) => !s && (open.value = false))
let offSettings: (() => void) | undefined
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  loadGroups()
  loadIcon(props.cwd)
  extras.value.forEach(loadIcon)
  offSettings = api.onSettingsChanged((s) => { groups.value = s.repoGroups ?? []; customIcons.value = s.repoIcons ?? {} })
})
watch(() => props.cwd, loadIcon)
watch(extras, (dirs) => dirs.forEach(loadIcon))
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  offSettings?.()
})
</script>

<template>
  <span ref="root" class="repo-menu" :class="{ big, center }">
    <button
      type="button"
      class="repo"
      :class="{ on: open, static: !canOpen(), grp: !!group }"
      :disabled="!canOpen()"
      :title="chipTitle"
      @click="toggle"
    >
      <RepoIcon :icon="group ? group.icon : custom(cwd)" :favicon="group ? null : icons.get(cwd)" :group="!!group" :size="big ? 19 : 14" />
      <span class="ellipsis">{{ group ? group.name : project }}</span>
      <Icon v-if="canOpen() && (group || !extras.length)" name="chevron" :size="big ? 12 : 10" class="chev" />
    </button>
    <template v-if="!group">
      <!-- os outros repositórios do espaço de trabalho: "+ nome", cada um com um × para tirar -->
      <!-- cada "+ nome" é uma unidade: quebra linha junto -->
      <span v-for="p in shownExtra" :key="p" class="pair">
        <span class="plus" aria-hidden="true">+</span>
        <span class="repo more" :class="{ static: !extensible }" :title="p">
          <RepoIcon :icon="custom(p)" :favicon="icons.get(p)" :size="big ? 18 : 13" />
          <span class="ellipsis">{{ base(p) }}</span>
          <button v-if="extensible" type="button" class="rm" title="Tirar este repositório da conversa" @click.stop="emit('remove', p)"><Icon name="x" :size="big ? 11 : 9" /></button>
        </span>
      </span>
      <!-- no cabeçalho, muitos juntados viram um só chip; a lista mostra e tira cada um -->
      <span v-if="hiddenExtra" class="pair">
        <span class="plus" aria-hidden="true">+</span>
        <button type="button" class="repo more count" :class="{ on: open, static: !canOpen() }" :disabled="!canOpen()" :title="`${extras.join('\n')}\nClique para ver ou tirar`" @click="toggle">
          <span class="ellipsis">{{ hiddenExtra }} outros</span>
        </button>
      </span>
    </template>
    <!-- o grupo, no estado vazio: os repositórios que ele reúne, numa linha própria -->
    <small v-if="group && big" class="members faint" :title="[cwd, ...extras].join('\n')">{{ groupMembers(group) }}</small>
    <Teleport to="body">
      <div v-if="open" ref="popEl" class="pop" :class="{ big }" role="menu" :style="popStyle">
      <label class="search">
        <Icon name="search" :size="13" />
        <input ref="searchInput" v-model="query" type="text" :placeholder="groups.length && extensible ? 'Buscar repositório ou grupo' : 'Buscar repositório'" spellcheck="false" @keydown.esc.stop="onSearchEsc" @keydown.enter.prevent="chooseFirst" />
        <button v-if="query" type="button" class="ghost clear" title="Limpar" @click="query = ''"><Icon name="x" :size="12" /></button>
      </label>
      <div class="results">
      <template v-if="shownGroups.length">
        <h6>Grupos</h6>
        <div class="list groups">
          <button v-for="g in shownGroups" :key="g.id" type="button" class="ghost opt grp-opt" :class="{ cur: isCur(g) }" :title="g.dirs.join('\n')" @click="apply(g)">
            <RepoIcon :icon="g.icon" group :size="17" />
            <span class="opt-text">
              <strong class="ellipsis">{{ g.name }}</strong>
              <small class="ellipsis">{{ groupMembers(g) }}</small>
            </span>
            <span class="add edit" role="button" tabindex="0" :title="g.icon ? 'Trocar ícone do grupo' : 'Escolher ícone do grupo'" @click.stop="editIcon('group', g.id, g.name)" @keydown.enter.stop.prevent="editIcon('group', g.id, g.name)"><Icon name="sparkles" :size="12" /></span>
            <span class="add del" title="Tirar o grupo da lista" @click.stop="removeGroup(g)"><Icon name="trash" :size="12" /></span>
            <Icon v-if="isCur(g)" name="check" :size="14" class="ok" />
          </button>
        </div>
        <hr class="sep" />
      </template>
      <h6>{{ switchable ? 'Repositório principal' : 'Repositórios da conversa' }}</h6>
      <div class="list">
        <button v-for="p in shownProjects" :key="p" type="button" class="ghost opt" :class="{ cur: p === cwd, in: inExtra(p) }" :title="p" @click="choose(p)">
          <RepoIcon :icon="custom(p)" :favicon="icons.get(p)" :size="17" />
          <span class="opt-text">
            <strong class="ellipsis">{{ base(p) }}</strong>
            <small class="ellipsis">{{ dir(p) }}</small>
          </span>
          <span class="add edit" role="button" tabindex="0" :title="custom(p) ? 'Trocar ícone' : 'Escolher ícone'" @click.stop="editIcon('repo', p, base(p))" @keydown.enter.stop.prevent="editIcon('repo', p, base(p))"><Icon name="sparkles" :size="12" /></span>
          <Icon v-if="p === cwd" name="check" :size="14" class="ok" />
          <span v-else-if="extensible" class="add" :class="{ on: inExtra(p) }" :title="inExtra(p) ? 'Tirar da conversa' : 'Juntar à conversa'" @click.stop="toggleExtra(p)">
            <Icon :name="inExtra(p) ? 'check' : 'plus'" :size="12" />
          </span>
        </button>
        <p v-if="!projects.length" class="faint none">Nenhum repositório recente.</p>
        <p v-else-if="!shownProjects.length" class="faint none">Nenhum repositório com “{{ query.trim() }}”.</p>
      </div>
      </div>
      <template v-if="!query.trim()">
      <hr class="sep" />
      <button v-if="switchable" type="button" class="ghost opt" @click="pick"><Icon name="folder" :size="14" class="faint" /><strong>Outra pasta como principal…</strong></button>
      <button v-if="extensible" type="button" class="ghost opt" @click="pickExtra"><Icon name="plus" :size="14" class="faint" /><strong>Juntar outra pasta…</strong></button>
      <!-- o conjunto atual vira um grupo com nome; da próxima vez, um clique junta todos -->
      <template v-if="canSave">
        <button v-if="!naming" type="button" class="ghost opt" @click="startNaming"><Icon name="layers" :size="14" class="faint" /><strong>Salvar estes {{ extras.length + 1 }} repositórios como grupo…</strong></button>
        <form v-else class="naming" @submit.prevent="saveAsGroup">
          <Icon name="layers" :size="14" class="faint" />
          <input ref="nameInput" v-model="nameDraft" type="text" maxlength="60" placeholder="Nome do grupo" @keydown.esc.stop="naming = false" />
          <button type="submit" class="primary small" :disabled="!nameDraft.trim()">Salvar</button>
        </form>
      </template>
      </template>
      </div>
    </Teleport>
    <RepoIconPicker v-if="editingIcon" :title="editingIcon.name" :current="currentIcon" @close="editingIcon = null" @choose="chooseIcon" />
  </span>
</template>

<style scoped>
.repo-menu { position: relative; display: inline-flex; align-items: center; gap: 4px; min-width: 0; vertical-align: baseline; -webkit-app-region: no-drag; }
/* no estado vazio os chips quebram linha em vez de sair da janela */
.repo-menu.big { display: flex; flex-wrap: wrap; justify-content: center; max-width: 100%; row-gap: 8px; }
.pair { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.plus { color: var(--faint); font-weight: 600; }
.big .plus { font-size: 17px; }
.repo.more { gap: 3px; padding-right: 4px; }
.repo.more.static, .repo.count { padding-right: 6px; }
.rm { display: grid; place-items: center; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--faint); cursor: pointer; }
.rm:hover { color: var(--del); background: color-mix(in srgb, var(--del) 15%, transparent); }
.big .rm { width: 18px; height: 18px; }
.members { flex-basis: 100%; text-align: center; font-size: 12.5px; line-height: 1.4; }
.opt.in { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.add { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--faint); flex: none; }
.add:hover { color: var(--accent); background: var(--accent-soft); }
.add.on { color: var(--accent); }
.add.edit { cursor: pointer; }
.add.edit:hover, .add.edit:focus-visible { color: var(--accent); background: var(--accent-soft); }
/* a lixeira do grupo só aparece ao passar o mouse na linha */
.add.del { opacity: 0; }
.grp-opt:hover .add.del, .add.del:focus-visible { opacity: 1; }
.add.del:hover { color: var(--del); background: color-mix(in srgb, var(--del) 15%, transparent); }
.naming { display: flex; align-items: center; gap: 8px; padding: 4px 10px 6px; }
.naming input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; font-size: 12.5px; }
/* o chip: leve destaque sobre o resto do subtítulo */
.repo {
  display: inline-flex; align-items: center; gap: 4px; height: 16px; padding: 0 6px; margin: 0 1px; min-width: 0; max-width: 100%;
  border: 0; border-radius: 6px; font: inherit; font-size: inherit; font-weight: 600; line-height: 1;
  color: var(--text); background: color-mix(in srgb, var(--text) 9%, transparent); cursor: pointer;
}
.repo:disabled, .repo.static { cursor: default; opacity: 1; }
.repo:not(.static):hover, .repo.on { background: var(--accent-soft); color: var(--accent); }
.repo .chev { transform: rotate(90deg); opacity: 0.7; flex: none; }
.repo svg:first-child { flex: none; }
/* o nome não encolhe antes do resto do subtítulo (só corta em nomes muito longos) */
.repo .ellipsis { flex: none; max-width: 220px; }
.big .repo { height: 30px; padding: 0 10px 0 8px; gap: 6px; margin: 0; border-radius: 9px; font-size: 17px; font-weight: 700; }
.big .repo.more { padding: 0 6px 0 10px; }
.big .repo .ellipsis { max-width: 320px; }
/* a lista vive no body (Teleport), com posição fixa calculada a partir do chip */
.pop {
  position: fixed; z-index: 60; width: 300px; padding: 6px; box-sizing: border-box;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px; text-align: left; font-size: 13px; font-weight: 400; line-height: 1.3; animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; } }
h6 { margin: 6px 10px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); flex: none; }
/* a busca: campo discreto no topo, no mesmo estilo do filtro da árvore de arquivos */
.search {
  flex: none; display: flex; align-items: center; gap: 6px; height: 28px; margin: 2px 4px 4px; padding: 0 6px 0 9px;
  border: 1px solid var(--border); border-radius: 7px; color: var(--faint); background: var(--bg);
}
.search:focus-within { border-color: var(--accent); }
.search input, .search input[type='text']:focus { flex: 1; min-width: 0; border: 0; outline: 0; box-shadow: none; background: transparent; padding: 0; height: 100%; border-radius: 0; font-size: 12.5px; color: var(--text); }
.search .clear { width: 20px; height: 20px; padding: 0; flex: none; }
.results { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.pop > .opt, .pop > .sep, .pop > .naming { flex: none; }
.list { display: flex; flex-direction: column; gap: 2px; flex: none; }
.list .opt { flex: none; }
.opt { justify-content: flex-start; gap: 10px; height: auto; padding: 7px 10px; width: 100%; text-align: left; color: var(--text); }
.opt.cur { background: var(--accent-soft); }
.opt-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.opt-text strong { font-size: 12.5px; }
.opt-text small { font-size: 11px; color: var(--muted); }
.opt .ok { color: var(--accent); flex: none; }
.opt strong { font-size: 12.5px; }
.fav { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.sep { border: 0; border-top: 1px solid var(--border); margin: 4px 6px; }
.none { margin: 6px 10px 8px; font-size: 12px; }
</style>
