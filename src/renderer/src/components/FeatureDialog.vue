<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { slugify } from '@shared/parse'
import type { FeaturePreview } from '@shared/types'
import { api, createFeature, planGroups, saveSettings, state, suggestedBranch } from '../store'
import Modal from './Modal.vue'

const PREFIXES = ['feature', 'fix', 'hotfix', 'chore', 'refactor', 'release']
const OTHER = '__other__'

const emit = defineEmits<{ close: [] }>()
const preview = ref<FeaturePreview | null>(null)
const error = ref<string | null>(null)
const name = ref(suggestedBranch.value)
const input = ref<HTMLInputElement>()

const saved = state.settings?.branchPrefix ?? 'feature'
const prefixChoice = ref(PREFIXES.includes(saved) ? saved : OTHER)
const customPrefix = ref(PREFIXES.includes(saved) ? '' : saved)
const prefix = computed(() =>
  (prefixChoice.value === OTHER ? customPrefix.value : prefixChoice.value).trim().toLowerCase().replace(/\/+$/, '')
)
const prefixValid = computed(() => /^[a-z0-9][a-z0-9._-]*$/.test(prefix.value))
const slug = computed(() => slugify(name.value))
const branch = computed(() => `${prefix.value || '…'}/${slug.value || '…'}`)

const groupCount = computed(() => planGroups.value.length)
// com um plano da IA, o padrão é a branch já nascer com os commits organizados
const commitFirst = ref(groupCount.value > 0)

onMounted(async () => {
  try {
    preview.value = await api.featurePreview()
  } catch (e) {
    error.value = (e as Error).message
  }
  await nextTick()
  input.value?.focus()
  input.value?.select()
})

const canSubmit = computed(() => !!slug.value && prefixValid.value && !!preview.value && !state.busy)

async function submit() {
  if (!canSubmit.value) return
  emit('close')
  if (prefix.value !== state.settings?.branchPrefix) saveSettings({ branchPrefix: prefix.value })
  await createFeature(slug.value, prefix.value, commitFirst.value && groupCount.value > 0)
}
</script>

<template>
  <Modal title="Criar branch" :width="480" @close="emit('close')">
    <form class="name-row" @submit.prevent="submit">
      <select v-model="prefixChoice" class="mono prefix" title="Prefixo da branch">
        <option v-for="p in PREFIXES" :key="p" :value="p">{{ p }}/</option>
        <option :value="OTHER">outro…</option>
      </select>
      <input
        v-if="prefixChoice === OTHER"
        v-model="customPrefix"
        type="text"
        class="mono custom"
        placeholder="prefixo"
        spellcheck="false"
      />
      <input ref="input" v-model="name" type="text" class="mono" placeholder="nome-da-branch" spellcheck="false" />
    </form>
    <p class="faint mono branch">{{ branch }}</p>

    <label v-if="groupCount" class="commit-first">
      <input v-model="commitFirst" type="checkbox" />
      Antes, criar os {{ groupCount }} commit{{ groupCount === 1 ? '' : 's' }} sugeridos pela IA
    </label>

    <p v-if="error" class="warn">{{ error }}</p>
    <p v-else-if="!preview" class="faint loading"><span class="spinner" /> Buscando a versão atual do remoto…</p>
    <p v-else class="muted summary">
      {{ preview.localCommits }} commit(s)<template v-if="preview.changedFiles">
        e {{ preview.changedFiles }} arquivo(s)</template> vão para a nova branch<template
        v-if="preview.baseRef"
      >, sobre a versão atual de <span class="mono">{{ preview.baseRef }}</span><template v-if="preview.remoteNew">
          ({{ preview.remoteNew }} novo(s))</template></template>. Um backup é criado antes.
    </p>

    <template #footer>
      <button type="button" @click="emit('close')">Cancelar</button>
      <button type="button" class="primary" :disabled="!canSubmit" @click="submit">Criar</button>
    </template>
  </Modal>
</template>

<style scoped>
.name-row { display: flex; gap: 6px; }
.prefix { width: auto; flex: none; font-size: 12.5px; }
.custom { width: 110px; flex: none; font-size: 12.5px; }
.name-row input:last-child { flex: 1; font-size: 12.5px; }
.branch { margin: -4px 0 0; font-size: 12px; }
.commit-first { display: flex; gap: 8px; align-items: center; font-size: 13px; cursor: pointer; }
.summary, .loading, .warn { margin: 0; font-size: 12.5px; }
.loading { display: flex; align-items: center; gap: 8px; }
.warn { color: var(--del); }
</style>
