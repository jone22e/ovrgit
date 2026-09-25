<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, onMounted, ref } from 'vue'
import { api, loadPr, state, toast } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const title = ref('')
const body = ref('')
const base = ref('main')
const draft = ref(false)
const tab = ref<'write' | 'preview'>('write')
const writing = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

const task = computed(() => state.tasks.find((t) => t.id === state.commitTaskId) ?? null)
const clean = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const html = computed(() => DOMPurify.sanitize(marked.parse(body.value || '*Sem descrição.*', { async: false })))

async function write() {
  writing.value = true
  error.value = null
  try {
    const d = await api.draftPullRequest(task.value ? `${task.value.key} · ${task.value.title}` : null)
    title.value = d.title || title.value
    body.value = d.body || body.value
    base.value = d.base || base.value
  } catch (e) {
    const msg = clean(e)
    if (!/CANCELADO/.test(msg)) error.value = `A IA não conseguiu escrever: ${msg}. Você pode escrever à mão.`
  } finally {
    writing.value = false
  }
}

onMounted(() => {
  title.value = state.repo?.branch?.replace(/^[a-z]+\//, '').replace(/[-_]/g, ' ') ?? ''
  if (state.settings?.provider !== 'none') write()
})

async function submit() {
  saving.value = true
  error.value = null
  try {
    const r = await api.createPullRequest({ title: title.value, body: body.value, base: base.value, draft: draft.value })
    if (!r.ok) {
      error.value = r.error ?? 'Não foi possível criar o PR.'
      return
    }
    toast(draft.value ? 'PR criado como rascunho.' : 'Revisão pedida: PR criado.')
    await loadPr(true)
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal title="Pedir revisão (Pull Request)" :width="640" @close="emit('close')">
    <p class="muted intro">
      Um PR avisa a equipe que o trabalho da linha <span class="mono">{{ state.repo?.branch }}</span> está pronto para ser
      revisado e juntado na <span class="mono">{{ base }}</span>.
    </p>
    <div class="row">
      <input v-model="title" type="text" class="title" placeholder="Título do PR" :disabled="writing" />
      <button type="button" class="small ai" :disabled="writing" title="A IA escreve título e descrição a partir das versões desta linha" @click="write">
        <span v-if="writing" class="spinner" /><Icon v-else name="sparkles" :size="14" /> {{ writing ? 'Escrevendo…' : 'Escrever com IA' }}
      </button>
    </div>
    <div class="md">
      <div class="md-bar">
        <span class="faint small-label">Descrição</span>
        <span class="spacer" />
        <div class="seg">
          <button type="button" :class="{ on: tab === 'write' }" @click="tab = 'write'">Escrever</button>
          <button type="button" :class="{ on: tab === 'preview' }" @click="tab = 'preview'">Pré-visualizar</button>
        </div>
      </div>
      <textarea v-if="tab === 'write'" v-model="body" rows="10" :disabled="writing" placeholder="O que muda e como testar" />
      <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitizado com DOMPurify -->
      <div v-else class="preview" v-html="html" />
    </div>
    <div class="opts">
      <label>Juntar em <input v-model="base" type="text" class="mono base" spellcheck="false" /></label>
      <label class="check"><input v-model="draft" type="checkbox" /> Rascunho (ainda não está pronto)</label>
    </div>
    <p v-if="task" class="faint small">Tarefa vinculada: <span class="mono">{{ task.key }}</span> · {{ task.title }}</p>
    <p v-if="error" class="bad">{{ error }}</p>
    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" :disabled="!title.trim() || saving || writing" @click="submit">
        <span v-if="saving" class="spinner" /> Pedir revisão
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.intro { margin: -4px 0 0; font-size: 12.5px; }
.row { display: flex; gap: 8px; }
.title { flex: 1; font-size: 14px; font-weight: 600; }
.ai { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); flex: none; }
.md { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--panel); }
.md:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.md-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--border); background: var(--panel-2); }
.small-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.spacer { flex: 1; }
.seg { display: flex; gap: 2px; padding: 2px; background: var(--panel); border-radius: 8px; }
.seg button { height: 24px; padding: 0 10px; border: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; background: transparent; color: var(--muted); }
.seg button.on { background: var(--accent-soft); color: var(--accent); }
textarea { border: 0; border-radius: 0; font-size: 13px; line-height: 1.55; resize: vertical; min-height: 200px; }
textarea:focus { box-shadow: none; }
.preview { padding: 12px 14px; min-height: 200px; max-height: 320px; overflow: auto; font-size: 13px; line-height: 1.6; user-select: text; }
.preview :deep(h2) { font-size: 14px; margin: 0.8em 0 0.3em; }
.preview :deep(ul) { padding-left: 20px; }
.preview :deep(code) { font-family: var(--mono); font-size: 12px; background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.opts { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; font-size: 13px; }
.opts label { display: flex; align-items: center; gap: 8px; }
.base { width: 140px; height: 30px; font-size: 12.5px; }
.check { cursor: pointer; }
.small { margin: 0; font-size: 12px; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
