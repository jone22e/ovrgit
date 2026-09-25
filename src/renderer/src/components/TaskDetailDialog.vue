<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, onMounted, ref, watch } from 'vue'
import type { OvseerComment, OvseerTaskDetail } from '@shared/types'
import { api, beginTask, ovseerTaskUrl, setTaskStatus, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const detail = ref<OvseerTaskDetail | null>(null)
const comments = ref<OvseerComment[]>([])
const error = ref<string | null>(null)
const audioUrl = ref<string | null>(null)
const guidanceAudio = ref<string | null>(null)

const task = computed(() => state.tasks.find((t) => t.id === state.detailTaskId) ?? null)
const planHtml = computed(() => DOMPurify.sanitize(marked.parse(detail.value?.plan || '*Sem plano.*', { async: false })))
const clean = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const using = computed(() => state.commitTaskId === detail.value?.id)
const size = (n: number | null) => (!n ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

async function load() {
  if (!state.detailTaskId) return
  error.value = null
  try {
    detail.value = await api.ovseerTaskDetail(state.detailTaskId)
    comments.value = await api.ovseerComments(state.detailTaskId).catch(() => [])
    // áudio de explicação do plano: carrega o endereço para tocar aqui mesmo
    const planAudio = detail.value.attachments.find((a) => a.audio)
    audioUrl.value = planAudio ? await api.ovseerAttachmentUrl(detail.value.id, planAudio.index).catch(() => null) : null
    guidanceAudio.value = detail.value.planReview.hasAudio ? await api.ovseerApprovalAudioUrl(detail.value.id).catch(() => null) : null
  } catch (e) {
    error.value = clean(e)
  }
}
onMounted(load)
// a tarefa mudou no Ovseer (tempo real): recarrega os detalhes
watch(() => task.value?.status + '|' + task.value?.section, (v, old) => v !== old && load())

const canStart = computed(() => !!detail.value?.isExecutor && detail.value.planReview.status === 'approved' && ['todo', 'paused'].includes(detail.value.status) && detail.value.completion.status !== 'pending')
const canPause = computed(() => !!detail.value?.isExecutor && detail.value.status === 'doing')
const guidance = computed(() => (detail.value?.planReview.guidanceNeedsAck ? detail.value.planReview.note || 'Há uma orientação em áudio de quem aprovou o plano.' : null))

async function start() {
  if (detail.value) await setTaskStatus(detail.value, 'doing', guidance.value)
  await load()
}
async function pause() {
  if (detail.value) await setTaskStatus(detail.value, 'paused')
  await load()
}
async function begin() {
  // guarda antes de fechar: ao fechar, a tarefa aberta deixa de existir no estado
  const t = task.value
  const d = detail.value
  if (!t || !d) return
  emit('close')
  await beginTask(t, d)
}
function openDelivery() {
  const t = task.value
  emit('close')
  state.deliveryTask = t
}
function toggleUse() {
  if (!detail.value) return
  state.commitTaskId = using.value ? null : detail.value.id
}
function openFile(index: number) {
  if (detail.value) api.ovseerAttachmentUrl(detail.value.id, index) // abre no navegador/visualizador do sistema
}
</script>

<template>
  <Modal :title="detail ? `${detail.key} · ${detail.title}` : 'Tarefa'" :width="680" @close="emit('close')">
    <p v-if="error" class="bad">{{ error }}</p>
    <p v-else-if="!detail" class="faint"><span class="spinner" /> Carregando…</p>
    <template v-else>
      <div class="top">
        <span class="pill">{{ task?.statusLabel ?? detail.status }}</span>
        <span v-if="detail.owner" class="owner">
          <img v-if="detail.owner.avatarUrl" :src="detail.owner.avatarUrl" class="av" alt="" />
          {{ detail.owner.name }}
        </span>
        <span v-if="detail.dueDate" class="faint">prazo {{ new Date(detail.dueDate).toLocaleDateString('pt-BR') }}</span>
        <span class="grow" />
        <button class="small ghost" @click="api.openExternal(ovseerTaskUrl(detail.key))"><Icon name="external" :size="13" /> Abrir no Ovseer</button>
      </div>

      <div class="actions">
        <button
          class="small primary"
          title="Cria a linha de trabalho desta tarefa, vincula os próximos commits a ela e marca como em execução"
          :disabled="!!state.busy || !state.repo"
          @click="begin"
        >
          <Icon name="branch" :size="13" /> Começar a trabalhar
        </button>
        <button v-if="canStart" class="small" @click="start">
          <Icon name="play" :size="13" /> {{ detail.status === 'paused' ? 'Retomar' : 'Iniciar' }}
        </button>
        <button v-if="canPause" class="small" @click="pause"><Icon name="pause" :size="13" /> Pausar</button>
        <button class="small" :class="{ on: using }" @click="toggleUse">
          <Icon name="commit" :size="13" /> {{ using ? 'Vinculada aos commits' : 'Usar nos commits' }}
        </button>
        <button v-if="task?.canDeliver" class="small" @click="openDelivery">Entregar</button>
      </div>

      <div v-if="detail.planReview.status === 'rejected' && detail.planReview.rejectionReason" class="note bad-note">
        <strong>Plano recusado:</strong> {{ detail.planReview.rejectionReason }}
      </div>
      <div v-if="detail.completion.status === 'rejected' && detail.completion.rejectionReason" class="note bad-note">
        <strong>Entrega devolvida:</strong> {{ detail.completion.rejectionReason }}
      </div>
      <div v-if="detail.planReview.note || guidanceAudio" class="note">
        <strong>Orientação de quem aprovou</strong>
        <p v-if="detail.planReview.note">{{ detail.planReview.note }}</p>
        <audio v-if="guidanceAudio" :src="guidanceAudio" controls />
      </div>

      <section>
        <h5>Plano</h5>
        <audio v-if="audioUrl" :src="audioUrl" controls class="plan-audio" />
        <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitizado com DOMPurify -->
        <div class="md" v-html="planHtml" />
      </section>

      <section v-if="detail.attachments.filter((a) => !a.audio).length">
        <h5>Anexos</h5>
        <ul class="files">
          <li v-for="a in detail.attachments.filter((x) => !x.audio)" :key="a.index">
            <Icon name="paperclip" :size="13" class="faint" />
            <span class="ellipsis">{{ a.name }}</span>
            <small class="faint">{{ size(a.size) }}</small>
            <button class="small ghost" @click="openFile(a.index)">Abrir</button>
          </li>
        </ul>
      </section>

      <section v-if="comments.length">
        <h5>Comentários</h5>
        <ul class="comments">
          <li v-for="c in comments" :key="c.id">
            <strong>{{ c.author }}</strong> <small class="faint">{{ when(c.date) }}</small>
            <p>{{ c.text }}</p>
          </li>
        </ul>
      </section>
    </template>
  </Modal>
</template>

<style scoped>
.top { display: flex; align-items: center; gap: 10px; margin-top: -6px; flex-wrap: wrap; }
.pill { font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.owner { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }
.av { width: 20px; height: 20px; border-radius: 50%; }
.grow { flex: 1; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.actions .on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.note { padding: 10px 12px; border-radius: 10px; background: var(--panel-2); font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; gap: 6px; }
.note p { margin: 0; }
.bad-note { background: var(--del-bg); }
section { display: flex; flex-direction: column; gap: 8px; }
h5 { margin: 4px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.md { font-size: 13px; line-height: 1.6; max-height: 36vh; overflow: auto; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; user-select: text; }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { font-size: 14px; margin: 0.6em 0 0.3em; }
.md :deep(code) { font-family: var(--mono); font-size: 12px; background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.plan-audio, audio { width: 100%; height: 36px; }
.files, .comments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.files li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; background: var(--panel-2); font-size: 12.5px; }
.files small { margin-left: auto; }
.comments li { padding: 8px 10px; border-radius: 8px; background: var(--panel-2); font-size: 12.5px; }
.comments p { margin: 4px 0 0; white-space: pre-wrap; user-select: text; }
.bad { color: var(--del); }
</style>
