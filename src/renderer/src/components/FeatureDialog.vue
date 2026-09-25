<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { slugify } from '@shared/parse'
import type { FeaturePreview } from '@shared/types'
import { api, createFeature, planGroups, state, suggestedBranch } from '../store'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const preview = ref<FeaturePreview | null>(null)
const error = ref<string | null>(null)
const name = ref(suggestedBranch.value)
const input = ref<HTMLInputElement>()
const slug = computed(() => slugify(name.value))
const groupCount = computed(() => planGroups.value.length)
// com um plano da IA, o padrão é a feature já nascer com os commits organizados
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

async function submit() {
  if (!slug.value || state.busy) return
  emit('close')
  await createFeature(slug.value, commitFirst.value && groupCount.value > 0)
}
</script>

<template>
  <Modal title="Criar feature" @close="emit('close')">
    <form @submit.prevent="submit">
      <label for="feat-name">Nome</label>
      <div class="name">
        <span class="prefix mono">feature/</span>
        <input id="feat-name" ref="input" v-model="name" type="text" class="mono" placeholder="nome-da-feature" spellcheck="false" />
      </div>
      <p v-if="name && slug !== name" class="faint hint mono">feature/{{ slug || '…' }}</p>
    </form>

    <label v-if="groupCount" class="commit-first">
      <input v-model="commitFirst" type="checkbox" />
      <span>
        Antes, criar os <strong>{{ groupCount }} commit{{ groupCount === 1 ? '' : 's' }} sugeridos pela IA</strong>
        <span class="faint list">
          <span v-for="g in planGroups" :key="g.id" class="mono">{{ g.commit }}</span>
        </span>
      </span>
    </label>

    <div v-if="error" class="warn">{{ error }}</div>
    <div v-else-if="!preview" class="faint loading"><span class="spinner" /> Buscando a versão atual do remoto…</div>
    <div v-else class="summary">
      <p>
        Seu trabalho: <strong>{{ preview.localCommits }} commit(s) local(is)</strong> e
        <strong>{{ preview.changedFiles }} arquivo(s) alterado(s)</strong>.
        <template v-if="preview.baseRef && preview.remoteNew">
          O remoto tem <strong>{{ preview.remoteNew }} commit(s) novo(s)</strong> em
          <span class="mono">{{ preview.baseRef }}</span>.
        </template>
      </p>
      <ol>
        <li>Backup <span class="mono">backup/auto-…</span> de tudo como está.</li>
        <li v-if="commitFirst && groupCount">Os {{ groupCount }} commits sugeridos pela IA são criados.</li>
        <li>Seu trabalho vai para <span class="mono">feature/{{ slug || '…' }}</span>.</li>
        <template v-if="preview.baseRef">
          <li>
            <span class="mono">{{ preview.branch }}</span> é atualizada com a versão atual de
            <span class="mono">{{ preview.baseRef }}</span>.
          </li>
          <li v-if="preview.remoteNew">
            Seus commits são reaplicados <strong>em cima da main atualizada</strong>, para a feature já nascer sem
            atraso. Se houver conflito, o app para e mostra os arquivos.
          </li>
        </template>
        <li v-else><span class="mono">{{ preview.branch }}</span> não existe no remoto e fica como está.</li>
        <li v-if="preview.hasRemote">A feature é enviada para <span class="mono">origin</span>.</li>
      </ol>
      <p class="ok">A branch remota <span class="mono">{{ preview.baseRef ?? preview.branch }}</span> não será alterada.</p>
    </div>

    <template #footer>
      <button type="button" @click="emit('close')">Cancelar</button>
      <button type="button" class="primary" :disabled="!slug || !preview || !!state.busy" @click="submit">Criar Feature</button>
    </template>
  </Modal>
</template>

<style scoped>
label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
.name { display: flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.name:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.prefix { padding-left: 10px; color: var(--faint); font-size: 12.5px; }
.name input { border: 0; outline: none; padding-left: 2px; font-size: 12.5px; background: transparent; }
.hint { margin: 6px 0 0; font-size: 12px; }
.summary p { margin: 0 0 8px; }
ol { margin: 0 0 10px; padding-left: 20px; color: var(--muted); }
li { margin: 3px 0; }
.ok { color: var(--add); }
.warn { color: var(--del); }
.loading { display: flex; align-items: center; gap: 8px; padding: 12px 0; }
.commit-first {
  display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
  padding: 10px 12px; border-radius: var(--radius); background: var(--panel-2); color: var(--text); font-size: 13px;
}
.commit-first input { margin-top: 3px; }
.list { display: flex; flex-direction: column; margin-top: 4px; font-size: 11.5px; max-height: 110px; overflow: auto; }
</style>
