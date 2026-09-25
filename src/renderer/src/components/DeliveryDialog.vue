<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { OvseerDeliveryCommit } from '@shared/types'
import { api, loadTasks, state, toast } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const task = state.deliveryTask!
const emit = defineEmits<{ close: [] }>()

const adherence = ref<'as_planned' | 'changed'>('as_planned')
const summary = ref('')
const commits = ref<OvseerDeliveryCommit[]>([])
const hasCommit = ref(false)
const commitId = ref('')
const manualCommit = ref('')
const hasPr = ref(false)
const prUrl = ref('')
const prDetected = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

const clean = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ERRORS: Record<string, string> = {
  'completion-summary-required': 'Descreva o que mudou em relação ao plano.',
  'invalid-commit-url': 'A URL do commit precisa ser https://…/commit/<sha>.',
  'invalid-pull-request-url': 'A URL do PR precisa ser https://…/pull/<número>.',
  'plan-not-approved': 'O plano desta tarefa ainda não foi aprovado.',
  'completion-review-pending': 'Esta tarefa já tem uma entrega em validação.',
  forbidden: 'Só o executor da tarefa pode enviar a entrega.'
}

onMounted(async () => {
  try {
    const d = await api.ovseerDelivery(task.id)
    commits.value = d.commits
    // commit vinculado pelo OvrGit: já vem relacionado
    if (d.commits.length) {
      hasCommit.value = true
      commitId.value = d.commits[0].id
    }
    if (d.pullRequestUrl) {
      hasPr.value = true
      prUrl.value = d.pullRequestUrl
      prDetected.value = true
    }
  } catch (e) {
    error.value = clean(e)
  } finally {
    loading.value = false
  }
})

const selectedCommit = computed(() => commits.value.find((c) => c.id === commitId.value) ?? null)
const commitUrl = computed(() => (commits.value.length ? selectedCommit.value?.url ?? '' : manualCommit.value.trim()))
const canSubmit = computed(
  () =>
    !saving.value &&
    !loading.value &&
    (adherence.value === 'as_planned' || summary.value.trim()) &&
    (!hasCommit.value || commitUrl.value) &&
    (!hasPr.value || prUrl.value.trim())
)

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  try {
    await api.ovseerSubmitDelivery(task.id, {
      adherence: adherence.value,
      summary: adherence.value === 'changed' ? summary.value.trim() : undefined,
      commitUrl: hasCommit.value ? commitUrl.value : undefined,
      commitEventId: hasCommit.value && selectedCommit.value ? selectedCommit.value.id : undefined,
      pullRequestUrl: hasPr.value ? prUrl.value.trim() : undefined
    })
    toast(`Entrega de ${task.key} enviada para validação.`)
    loadTasks(true)
    emit('close')
  } catch (e) {
    const msg = clean(e)
    error.value = ERRORS[msg] ?? msg
  } finally {
    saving.value = false
  }
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
</script>

<template>
  <Modal :title="`Preparar entrega · ${task.key}`" :width="560" @close="emit('close')">
    <p class="muted sub">{{ task.title }}</p>

    <section>
      <h5>Como ficou em relação ao plano?</h5>
      <div class="choices">
        <button type="button" class="choice" :class="{ on: adherence === 'as_planned' }" @click="adherence = 'as_planned'">
          <span class="radio" /> Exatamente como planejado
        </button>
        <button type="button" class="choice" :class="{ on: adherence === 'changed' }" @click="adherence = 'changed'">
          <span class="radio" /> Houve mudanças
        </button>
      </div>
      <textarea
        v-if="adherence === 'changed'"
        v-model="summary"
        rows="3"
        placeholder="O que foi realizado e o que mudou em relação ao plano"
      />
    </section>

    <section>
      <h5>Evidências técnicas <span class="opt">opcional</span></h5>
      <div class="choices">
        <button type="button" class="choice evidence" :class="{ on: hasCommit }" @click="hasCommit = !hasCommit">
          <Icon name="commit" :size="16" />
          <span><strong>Relacionar commit</strong><small>Commit principal da entrega</small></span>
          <span class="check"><Icon v-if="hasCommit" name="check" :size="12" /></span>
        </button>
        <button type="button" class="choice evidence" :class="{ on: hasPr }" @click="hasPr = !hasPr">
          <Icon name="branch" :size="16" />
          <span><strong>Relacionar Pull Request</strong><small>PR principal da entrega</small></span>
          <span class="check"><Icon v-if="hasPr" name="check" :size="12" /></span>
        </button>
      </div>

      <div v-if="hasCommit" class="box">
        <p v-if="loading" class="faint"><span class="spinner" /> Carregando commits…</p>
        <template v-else-if="commits.length">
          <label v-for="c in commits" :key="c.id" class="commit" :class="{ on: commitId === c.id }">
            <input v-model="commitId" type="radio" :value="c.id" />
            <span class="c-main">
              <span class="ellipsis">{{ c.title.replace(/^Commit: /, '') }}</span>
              <small class="faint mono">{{ c.url.split('/').pop()?.slice(0, 7) }} · {{ c.repository }} · {{ when(c.occurred_at) }}</small>
            </span>
          </label>
        </template>
        <template v-else>
          <p class="faint">Nenhum commit vinculado a esta tarefa. Informe a URL do commit:</p>
          <input v-model="manualCommit" type="text" class="mono" placeholder="https://github.com/…/commit/…" spellcheck="false" />
        </template>
      </div>

      <div v-if="hasPr" class="box">
        <input v-model="prUrl" type="text" class="mono" placeholder="https://github.com/…/pull/123" spellcheck="false" />
        <p v-if="prDetected" class="faint">PR encontrado para a branch atual.</p>
      </div>
    </section>

    <p v-if="error" class="bad">{{ error }}</p>

    <template #footer>
      <span class="note faint">Vai para aprovação de um admin ou dono.</span>
      <button type="button" @click="emit('close')">Cancelar</button>
      <button type="button" class="primary" :disabled="!canSubmit" @click="submit">
        <span v-if="saving" class="spinner" /> Enviar para validação
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sub { margin: -8px 0 0; font-size: 12.5px; }
section { display: flex; flex-direction: column; gap: 8px; }
h5 { margin: 4px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); display: flex; gap: 8px; align-items: center; }
.opt { font-size: 10px; background: var(--panel-2); padding: 1px 6px; border-radius: 4px; letter-spacing: 0.04em; }
.choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.choice { height: auto; min-height: 42px; justify-content: flex-start; gap: 10px; padding: 8px 12px; text-align: left; white-space: normal; }
.choice.on { border-color: var(--accent); background: var(--accent-soft); }
.radio { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--faint); flex: none; }
.choice.on .radio { border-color: var(--accent); background: radial-gradient(var(--accent) 45%, transparent 50%); }
.evidence span:not(.check) { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.evidence small { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.check { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--faint); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.choice.on .check { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.box { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.box p { margin: 0; font-size: 12px; display: flex; gap: 8px; align-items: center; }
.commit { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.commit.on { background: var(--accent-soft); }
.c-main { display: flex; flex-direction: column; min-width: 0; font-size: 12.5px; }
.c-main small { font-size: 11px; }
textarea { font-size: 13px; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
.note { margin-right: auto; font-size: 12px; align-self: center; }
</style>
