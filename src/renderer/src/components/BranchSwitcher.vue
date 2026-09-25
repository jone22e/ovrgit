<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BranchInfo } from '@shared/types'
import { api, createBranchNamed, state, switchTo } from '../store'
import Icon from './Icon.vue'

/** Seletor de linhas de trabalho (branches), no nome da branch da barra superior. */
const open = ref(false)
const list = ref<BranchInfo[]>([])
const loading = ref(false)
const query = ref('')
const pending = ref<BranchInfo | null>(null)
const creating = ref(false)
const newName = ref('')
const root = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const newInput = ref<HTMLInputElement>()

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
function relative(iso: string) {
  const d = (new Date(iso).getTime() - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  const [u, s] = units.find(([, x]) => Math.abs(d) >= x) ?? ['minute', 60]
  return rtf.format(Math.round(d / s), u)
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return list.value.filter((b) => !b.backup && (!q || b.name.toLowerCase().includes(q)))
})
const locals = computed(() => filtered.value.filter((b) => b.where === 'local'))
const remotes = computed(() => filtered.value.filter((b) => b.where === 'remote'))
const backups = computed(() => list.value.filter((b) => b.backup).length)
const dirty = computed(() => state.repo?.files.length ?? 0)

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  pending.value = null
  creating.value = false
  query.value = ''
  loading.value = true
  try {
    list.value = await api.branches()
  } finally {
    loading.value = false
  }
  await nextTick()
  search.value?.focus()
}

function pick(b: BranchInfo) {
  if (b.current) return
  // alterações não salvas: pergunta o que fazer com elas
  if (dirty.value) pending.value = b
  else go(b, 'carry')
}

function go(b: BranchInfo, mode: 'carry' | 'stash') {
  open.value = false
  pending.value = null
  switchTo(b.name, mode)
}

async function startCreate() {
  creating.value = true
  newName.value = ''
  await nextTick()
  newInput.value?.focus()
}

function create() {
  const name = newName.value.trim().replace(/\s+/g, '-')
  if (!name) return
  open.value = false
  createBranchNamed(name)
}

function openCleanup() {
  open.value = false
  state.showCleanup = true
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
watch(() => state.repo?.root, () => (open.value = false))
</script>

<template>
  <div ref="root" class="branch-switcher">
    <button
      class="badge accent branch"
      :class="{ on: open }"
      :title="`Linha de trabalho atual (branch). Clique para trocar ou criar outra.${state.repo?.upstream ? `\nNo servidor: ${state.repo.upstream}` : ''}`"
      @click="toggle"
    >
      <Icon name="branch" :size="13" />
      <span>{{ state.repo?.branch ?? 'sem linha' }}</span>
      <Icon name="chevron" :size="11" class="chev" />
    </button>

    <div v-if="open" class="pop" @keydown.esc="open = false">
      <!-- escolha quando há alterações não salvas -->
      <div v-if="pending" class="ask">
        <strong>Você tem {{ dirty }} alteração(ões) não salva(s)</strong>
        <p class="muted">O que fazer com elas ao ir para <span class="mono">{{ pending.name }}</span>?</p>
        <button class="choice" @click="go(pending, 'carry')">
          <Icon name="branch" :size="15" />
          <span><strong>Levar junto</strong><small>As alterações continuam na lista, na outra linha.</small></span>
        </button>
        <button class="choice" @click="go(pending, 'stash')">
          <Icon name="archive" :size="15" />
          <span><strong>Guardar e trocar</strong><small>Ficam guardadas aqui e voltam quando você retornar a esta linha.</small></span>
        </button>
        <button class="ghost small back" @click="pending = null">Voltar</button>
      </div>

      <template v-else>
        <div class="search">
          <Icon name="search" :size="13" class="faint" />
          <input ref="search" v-model="query" type="text" placeholder="Buscar linha de trabalho" spellcheck="false" />
        </div>
        <p v-if="loading" class="faint msg"><span class="spinner" /> Carregando…</p>
        <div v-else class="lists">
          <h6 v-if="locals.length">No seu computador</h6>
          <button v-for="b in locals" :key="b.name" class="item" :class="{ current: b.current }" @click="pick(b)">
            <Icon :name="b.current ? 'check' : 'branch'" :size="13" class="ic" />
            <span class="txt">
              <span class="name ellipsis">{{ b.name }}</span>
              <small class="faint ellipsis">{{ relative(b.date) }} · {{ b.subject }}</small>
            </span>
            <span v-if="!b.published" class="tag" title="Ainda não foi enviada ao servidor">só aqui</span>
            <span v-else-if="b.behind" class="tag" :title="`${b.behind} versão(ões) nova(s) no servidor`">↓{{ b.behind }}</span>
          </button>
          <h6 v-if="remotes.length">Só no servidor</h6>
          <button v-for="b in remotes" :key="b.name" class="item" @click="pick(b)">
            <Icon name="cloud" :size="13" class="ic" />
            <span class="txt">
              <span class="name ellipsis">{{ b.name }}</span>
              <small class="faint ellipsis">{{ relative(b.date) }} · {{ b.subject }}</small>
            </span>
          </button>
          <p v-if="!locals.length && !remotes.length" class="faint msg">Nenhuma linha encontrada.</p>
        </div>

        <form v-if="creating" class="create" @submit.prevent="create">
          <input ref="newInput" v-model="newName" type="text" class="mono" placeholder="nome-da-nova-linha" spellcheck="false" />
          <button type="submit" class="small primary" :disabled="!newName.trim()">Criar</button>
        </form>
        <div class="foot">
          <button v-if="!creating" class="ghost small" title="Cria uma linha nova a partir desta, levando suas alterações" @click="startCreate">
            <Icon name="plus" :size="13" /> Nova linha
          </button>
          <span class="spacer" />
          <button class="ghost small" title="Remover cópias de segurança antigas e linhas já incorporadas à principal" @click="openCleanup">
            <Icon name="trash" :size="13" /> Limpar<span v-if="backups" class="faint"> ({{ backups }} cópias)</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.branch-switcher { position: relative; -webkit-app-region: no-drag; min-width: 0; }
.branch { border: 0; height: 24px; gap: 5px; cursor: pointer; max-width: 260px; min-width: 0; }
.branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch:hover, .branch.on { filter: brightness(1.15); }
.chev { transform: rotate(90deg); opacity: 0.7; }
.pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; width: min(400px, calc(100vw - 24px)); padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.search input { border: 0; background: transparent; padding: 7px 0; }
.search input:focus { box-shadow: none; }
.lists { max-height: 340px; overflow: auto; margin-top: 4px; }
h6 { margin: 10px 8px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.item { width: 100%; height: auto; justify-content: flex-start; gap: 10px; padding: 7px 8px; border: 0; background: transparent; text-align: left; font-weight: 400; }
.item:hover { background: var(--hover); }
.item.current { background: var(--accent-soft); }
.item .ic { color: var(--muted); flex: none; }
.item.current .ic { color: var(--accent); }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name { font-weight: 600; font-size: 12.5px; }
.txt small { font-size: 11px; }
.tag { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: var(--panel-2); color: var(--muted); flex: none; }
.msg { margin: 10px; font-size: 12px; display: flex; gap: 8px; align-items: center; }
.create { display: flex; gap: 6px; padding: 6px 2px 0; }
.create input { height: 30px; font-size: 12.5px; }
.foot { display: flex; align-items: center; gap: 4px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
.spacer { flex: 1; }
.ask { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.ask p { margin: -4px 0 2px; font-size: 12.5px; }
.choice { height: auto; justify-content: flex-start; gap: 12px; padding: 10px 12px; text-align: left; white-space: normal; }
.choice:hover { border-color: var(--accent); }
.choice > svg { color: var(--accent); flex: none; }
.choice span { display: flex; flex-direction: column; font-weight: 600; }
.choice small { font-weight: 400; color: var(--muted); font-size: 12px; }
.back { align-self: flex-start; }
</style>
