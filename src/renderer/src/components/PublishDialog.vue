<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { PublishInfo } from '@shared/types'
import { api, publishToGitHub, publishToUrl, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const info = ref<PublishInfo | null>(null)
const mode = ref<'github' | 'url'>('github')
const name = ref('')
const isPrivate = ref(true)
const url = ref('')

onMounted(async () => {
  info.value = await api.publishInfo()
  name.value = info.value.suggestedName
  if (!info.value.ghUser) mode.value = 'url'
})

async function submit() {
  emit('close')
  if (mode.value === 'github') await publishToGitHub(name.value, isPrivate.value)
  else await publishToUrl(url.value)
}
</script>

<template>
  <Modal title="Publicar repositório" :width="500" @close="emit('close')">
    <p class="muted intro">
      Este repositório ainda não está ligado a nenhum servidor. Escolha onde publicar a branch
      <span class="mono">{{ state.repo?.branch }}</span>.
    </p>

    <div v-if="!info" class="faint loading"><span class="spinner" /> Verificando o GitHub CLI…</div>
    <template v-else>
      <div class="options">
        <button
          type="button"
          class="option"
          :class="{ active: mode === 'github' }"
          :disabled="!info.ghUser"
          @click="mode = 'github'"
        >
          <strong>Criar no GitHub</strong>
          <span v-if="info.ghUser" class="hint">como <span class="mono">{{ info.ghUser }}</span></span>
          <span v-else class="hint">Instale o GitHub CLI (gh) e rode "gh auth login"</span>
        </button>
        <button type="button" class="option" :class="{ active: mode === 'url' }" @click="mode = 'url'">
          <strong>Repositório existente</strong>
          <span class="hint">GitHub, GitLab, Bitbucket, Azure…</span>
        </button>
      </div>

      <form v-if="mode === 'github'" class="fields" @submit.prevent="submit">
        <label for="repo-name">Nome do repositório</label>
        <div class="name">
          <span class="prefix mono">{{ info.ghUser }}/</span>
          <input id="repo-name" v-model="name" type="text" class="mono" spellcheck="false" />
        </div>
        <div class="visibility">
          <label><input v-model="isPrivate" type="radio" :value="true" /> Privado</label>
          <label><input v-model="isPrivate" type="radio" :value="false" /> Público</label>
        </div>
      </form>

      <form v-else class="fields" @submit.prevent="submit">
        <label for="repo-url">URL do repositório</label>
        <input
          id="repo-url"
          v-model="url"
          type="text"
          class="mono"
          placeholder="https://github.com/empresa/projeto.git"
          spellcheck="false"
        />
        <p class="faint">Crie o repositório vazio no site do servidor e cole a URL aqui.</p>
      </form>
    </template>

    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button
        class="primary"
        :disabled="!info || (mode === 'github' ? !name.trim() : !url.trim())"
        @click="submit"
      >
        <Icon name="cloudUp" :size="15" /> Publicar
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.intro { margin: -4px 0 0; font-size: 12.5px; }
.loading { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.option {
  height: auto; padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  white-space: normal;
}
.option.active { border-color: var(--accent); background: var(--accent-soft); }
.hint { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.fields > label { font-size: 12px; color: var(--muted); }
.name { display: flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.name:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.name input:focus { box-shadow: none; }
.prefix { padding-left: 10px; color: var(--faint); font-size: 12.5px; white-space: nowrap; }
.name input { border: 0; outline: none; padding-left: 2px; background: transparent; font-size: 12.5px; }
.visibility { display: flex; gap: 16px; margin-top: 4px; }
.visibility label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.fields p { margin: 0; font-size: 12px; }
</style>
