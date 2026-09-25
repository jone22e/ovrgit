<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RemoteRepo } from '@shared/types'
import { api, openCloned } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

/** Clonar repositório: escolher da lista do GitHub ou colar o endereço, e a pasta de destino. */
const emit = defineEmits<{ close: [] }>()
const repos = ref<RemoteRepo[] | null>(null)
const loadingRepos = ref(true)
const query = ref('')
const url = ref('')
const picked = ref<RemoteRepo | null>(null)
const parent = ref('')
const name = ref('')
const nameTouched = ref(false)
const running = ref(false)
const progress = ref<{ phase: string; percent: number | null } | null>(null)
const error = ref<string | null>(null)
const urlInput = ref<HTMLInputElement>()
let off: (() => void) | null = null

const clean = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const folderFrom = (u: string) => (u.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '').replace(/\.git$/, '')
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return (repos.value ?? []).filter((r) => !q || `${r.name} ${r.description ?? ''}`.toLowerCase().includes(q)).slice(0, 60)
})
const sep = computed(() => (parent.value.includes('\\') ? '\\' : '/'))
const target = computed(() => (parent.value && name.value ? `${parent.value.replace(/[\\/]+$/, '')}${sep.value}${name.value}` : ''))
const canClone = computed(() => !!url.value.trim() && !!parent.value && !!name.value.trim() && !running.value)
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
const ago = (iso: string) => {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86400000)
  return Math.abs(days) < 1 ? 'hoje' : Math.abs(days) < 30 ? rtf.format(days, 'day') : rtf.format(Math.round(days / 30), 'month')
}

watch(url, (u) => {
  if (!nameTouched.value) name.value = folderFrom(u)
  if (picked.value && u !== picked.value.httpsUrl) picked.value = null
})

function pick(r: RemoteRepo) {
  picked.value = r
  url.value = r.httpsUrl
  if (!nameTouched.value) name.value = folderFrom(r.httpsUrl)
}

async function chooseFolder() {
  const p = await api.pickFolder(parent.value)
  if (p) parent.value = p
}

onMounted(async () => {
  off = api.onCloneProgress((p) => (progress.value = p))
  parent.value = (await api.cloneDefaults()).parent
  repos.value = await api.githubRepos().catch(() => null)
  loadingRepos.value = false
  await nextTick()
  if (!repos.value) urlInput.value?.focus()
})
onUnmounted(() => {
  off?.()
  if (running.value) api.cancelClone()
})

async function start() {
  if (!canClone.value) return
  running.value = true
  error.value = null
  progress.value = { phase: 'Conectando', percent: null }
  try {
    const repo = await api.cloneRepo(url.value.trim(), parent.value, name.value.trim())
    running.value = false
    emit('close')
    await openCloned(repo)
  } catch (e) {
    error.value = clean(e)
  } finally {
    running.value = false
  }
}

async function cancel() {
  if (running.value) await api.cancelClone()
  emit('close')
}
</script>

<template>
  <Modal title="Clonar repositório" :width="600" @close="cancel">
    <p class="muted intro">Faz uma cópia de um projeto do servidor no seu computador, para você trabalhar nele.</p>

    <section v-if="loadingRepos || repos">
      <h5>Seus repositórios no GitHub</h5>
      <p v-if="loadingRepos" class="faint msg"><span class="spinner" /> Buscando…</p>
      <template v-else>
        <div class="search">
          <Icon name="search" :size="13" class="faint" />
          <input v-model="query" type="text" placeholder="Buscar repositório" spellcheck="false" :disabled="running" />
        </div>
        <ul class="repos">
          <li v-for="r in filtered" :key="r.name" :class="{ on: picked?.name === r.name }" @click="!running && pick(r)">
            <Icon :name="r.private ? 'lock' : 'folder'" :size="14" class="faint" />
            <span class="r-text">
              <strong class="ellipsis">{{ r.name }}</strong>
              <small class="faint ellipsis">{{ r.description || 'sem descrição' }} · atualizado {{ ago(r.updatedAt) }}</small>
            </span>
            <Icon v-if="picked?.name === r.name" name="check" :size="14" class="check" />
          </li>
          <li v-if="!filtered.length" class="faint empty">Nenhum repositório encontrado.</li>
        </ul>
      </template>
    </section>

    <label class="field">
      <span>{{ repos ? 'Ou cole o endereço' : 'Endereço do repositório' }}</span>
      <input ref="urlInput" v-model="url" type="text" class="mono" placeholder="https://github.com/empresa/projeto.git" spellcheck="false" :disabled="running" />
    </label>

    <div class="row">
      <label class="field grow">
        <span>Pasta de destino</span>
        <div class="folder">
          <input v-model="parent" type="text" class="mono" spellcheck="false" :disabled="running" />
          <button type="button" :disabled="running" @click="chooseFolder">Escolher…</button>
        </div>
      </label>
      <label class="field name">
        <span>Nome da pasta</span>
        <input v-model="name" type="text" class="mono" spellcheck="false" :disabled="running" @input="nameTouched = true" />
      </label>
    </div>
    <p v-if="target" class="faint mono target">{{ target }}</p>

    <div v-if="running && progress" class="progress">
      <div class="bar"><i :style="{ width: `${progress.percent ?? 8}%` }" :class="{ indet: progress.percent === null }" /></div>
      <small class="muted">{{ progress.phase }}{{ progress.percent !== null ? ` · ${progress.percent}%` : '…' }}</small>
    </div>
    <p v-if="error" class="bad">{{ error }}</p>

    <template #footer>
      <button @click="cancel">{{ running ? 'Cancelar cópia' : 'Cancelar' }}</button>
      <button class="primary" :disabled="!canClone" @click="start">
        <span v-if="running" class="spinner" /><Icon v-else name="down" :size="14" /> Clonar e abrir
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.intro { margin: -4px 0 0; font-size: 12.5px; }
section { display: flex; flex-direction: column; gap: 6px; }
h5 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.msg { margin: 6px 0; font-size: 12px; display: flex; gap: 8px; align-items: center; }
.search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.search input { border: 0; background: transparent; padding: 7px 0; }
.search input:focus { box-shadow: none; }
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.repos { list-style: none; margin: 0; padding: 4px; max-height: 210px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.repos li { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
.repos li:hover { background: var(--hover); }
.repos li.on { background: var(--accent-soft); }
.r-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.r-text strong { font-size: 12.5px; }
.r-text small { font-size: 11px; }
.check { color: var(--accent); }
.empty { cursor: default; font-size: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field > span { font-size: 12px; color: var(--muted); }
.row { display: flex; gap: 10px; }
.grow { flex: 1; }
.name { width: 170px; }
.folder { display: flex; gap: 6px; }
.folder input { flex: 1; min-width: 0; }
.target { margin: -4px 0 0; font-size: 11.5px; word-break: break-all; }
.progress { display: flex; flex-direction: column; gap: 6px; }
.bar { height: 6px; border-radius: 999px; background: var(--panel-2); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.3s; }
.bar i.indet { width: 30% !important; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
