<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { OvseerMember, OvseerNewTask } from '@shared/types'
import { api, createTask, ovseerWorkspace, state, toast } from '../store'
import AudioRecorder from './AudioRecorder.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const MAX_BYTES = 25 * 1024 * 1024

const title = ref('')
const plan = ref('')
const planTab = ref<'write' | 'preview'>('write')
const priority = ref<OvseerNewTask['priority']>('medium')
const ownerId = ref('')
const members = ref<OvseerMember[]>([])
const memberOpen = ref(false)
const hasDue = ref(false)
const dueDate = ref('')
const audio = ref<File | null>(null)
const files = ref<File[]>([])
const dragging = ref(false)
const useInCommit = ref(true)
const saving = ref(false)
const progress = ref<string | null>(null)
const error = ref<string | null>(null)
const created = ref<{ id: string; code: string } | null>(null)
const titleInput = ref<HTMLInputElement>()
const fileInput = ref<HTMLInputElement>()

const PRIORITIES: { id: OvseerNewTask['priority']; label: string }[] = [
  { id: 'low', label: 'Baixa' },
  { id: 'medium', label: 'Média' },
  { id: 'high', label: 'Alta' },
  { id: 'urgent', label: 'Urgente' }
]

const clean = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const owner = computed(() => members.value.find((m) => m.id === ownerId.value) ?? null)
const planHtml = computed(() => DOMPurify.sanitize(marked.parse(plan.value || '*Nada para pré-visualizar.*', { async: false })))
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const today = new Date().toISOString().slice(0, 10)

function addFiles(list: FileList | File[] | null | undefined) {
  for (const f of Array.from(list ?? [])) {
    if (f.size > MAX_BYTES) {
      error.value = `${f.name} passa de 25 MB.`
      continue
    }
    if (!files.value.some((x) => x.name === f.name && x.size === f.size)) files.value.push(f)
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false
  addFiles(e.dataTransfer?.files)
}

/** Colar arquivos (ex.: print da tela) em qualquer lugar do formulário */
function onPaste(e: ClipboardEvent) {
  const pasted = Array.from(e.clipboardData?.files ?? [])
  if (!pasted.length) return
  e.preventDefault()
  addFiles(
    pasted.map((f) =>
      f.name && f.name !== 'image.png'
        ? f
        : new File([f], `colado-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, { type: f.type })
    )
  )
}

onMounted(async () => {
  window.addEventListener('paste', onPaste)
  await nextTick()
  titleInput.value?.focus()
  try {
    members.value = await api.ovseerMembers(ovseerWorkspace.value!.id)
    ownerId.value = members.value.find((m) => m.me)?.id ?? members.value[0]?.id ?? ''
  } catch (e) {
    error.value = clean(e)
  }
})
onUnmounted(() => window.removeEventListener('paste', onPaste))

const canSubmit = computed(
  () => !!title.value.trim() && !!plan.value.trim() && !!ownerId.value && (!hasDue.value || !!dueDate.value) && !saving.value
)

async function upload(taskId: string, file: File, purpose?: 'plan_audio') {
  await api.ovseerUpload(taskId, { name: file.name, type: file.type, data: await file.arrayBuffer() }, purpose)
}

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  const total = (audio.value ? 1 : 0) + files.value.length
  let done = 0
  try {
    // se uma tentativa anterior já criou a tarefa, só termina os envios que faltaram
    if (!created.value) {
      progress.value = 'Criando tarefa…'
      created.value = await createTask({
        title: title.value.trim(),
        plan: plan.value.trim(),
        ownerId: ownerId.value,
        priority: priority.value,
        dueDate: hasDue.value ? dueDate.value : null
      })
      if (useInCommit.value) state.commitTaskId = created.value.id
    }
    const task = created.value
    if (audio.value) {
      progress.value = `Enviando arquivos ${++done}/${total}…`
      const ext = audio.value.name.split('.').pop() ?? 'webm'
      await upload(task.id, new File([audio.value], `explicacao-${task.code.toLowerCase()}.${ext}`, { type: audio.value.type }), 'plan_audio')
      audio.value = null
    }
    while (files.value.length) {
      progress.value = `Enviando arquivos ${++done}/${total}…`
      await upload(task.id, files.value[0])
      files.value.shift()
    }
    toast(`${task.code} criada e enviada para aprovação.`)
    emit('close')
  } catch (e) {
    error.value = created.value
      ? `${created.value.code} foi criada, mas um envio falhou: ${clean(e).replace(/\.$/, "")}. Tente de novo para enviar o que faltou.`
      : clean(e)
  } finally {
    saving.value = false
    progress.value = null
  }
}
</script>

<template>
  <Modal :title="created ? `Nova tarefa · ${created.code}` : 'Nova tarefa'" :width="640" @close="emit('close')">
    <div
      class="form"
      :class="{ locked: !!created }"
      @dragover.prevent="dragging = true"
      @dragleave.self="dragging = false"
      @drop.prevent="onDrop"
    >
      <label class="field">
        <span class="lbl">Título <b>*</b></span>
        <input ref="titleInput" v-model="title" type="text" class="title" maxlength="300" :disabled="!!created" />
      </label>

      <AudioRecorder v-model="audio" />

      <div class="field">
        <span class="lbl">Plano em Markdown <b>*</b></span>
        <div class="md">
          <div class="md-bar">
            <span class="mono faint">markdown</span>
            <span class="spacer" />
            <div class="seg">
              <button type="button" :class="{ on: planTab === 'write' }" @click="planTab = 'write'">Escrever</button>
              <button type="button" :class="{ on: planTab === 'preview' }" @click="planTab = 'preview'">Pré-visualizar</button>
            </div>
          </div>
          <textarea
            v-if="planTab === 'write'"
            v-model="plan"
            rows="7"
            placeholder="Descreva o que precisa ser feito e o resultado esperado."
            :disabled="!!created"
          />
          <!-- eslint-disable-next-line vue/no-v-html -- HTML sanitizado com DOMPurify -->
          <div v-else class="preview" v-html="planHtml" />
        </div>
      </div>

      <div class="row">
        <div class="field">
          <span class="lbl">Executor <b>*</b></span>
          <div class="member-picker">
            <button type="button" class="member-btn" :disabled="!!created" @click="memberOpen = !memberOpen">
              <img v-if="owner?.avatarUrl" :src="owner.avatarUrl" class="av" alt="" />
              <span v-else class="av initials">{{ initials(owner?.name ?? '?') }}</span>
              <span class="who">
                <strong class="ellipsis">{{ owner?.name ?? 'Carregando…' }}</strong>
                <small v-if="owner?.me">Eu mesmo</small>
              </span>
              <Icon name="chevron" :size="13" class="chev" />
            </button>
            <ul v-if="memberOpen" class="members">
              <li
                v-for="m in members"
                :key="m.id"
                :class="{ on: m.id === ownerId }"
                @click="(ownerId = m.id), (memberOpen = false)"
              >
                <img v-if="m.avatarUrl" :src="m.avatarUrl" class="av" alt="" />
                <span v-else class="av initials">{{ initials(m.name) }}</span>
                <span class="ellipsis">{{ m.name }}</span>
                <small v-if="m.me" class="faint">você</small>
              </li>
            </ul>
          </div>
        </div>
        <div class="field">
          <span class="lbl">Prioridade</span>
          <div class="prio">
            <button
              v-for="p in PRIORITIES"
              :key="p.id"
              type="button"
              :class="[p.id, { on: priority === p.id }]"
              :disabled="!!created"
              @click="priority = p.id"
            >
              <i />{{ p.label }}
            </button>
          </div>
        </div>
      </div>

      <label class="check">
        <input v-model="hasDue" type="checkbox" :disabled="!!created" /> Definir um prazo
        <input v-if="hasDue" v-model="dueDate" type="date" class="date" :min="today" :disabled="!!created" />
      </label>

      <div class="attach">
        <div class="head">
          <Icon name="paperclip" :size="15" class="accent" />
          <strong>Anexos</strong>
        </div>
        <button type="button" class="drop" :class="{ over: dragging }" @click="fileInput?.click()">
          <span class="up"><Icon name="up" :size="16" /></span>
          <span>
            <strong>Selecionar arquivos</strong>
            <small class="muted">Arraste ou cole arquivos aqui. Cada arquivo pode ter até 25 MB.</small>
          </span>
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="addFiles(($event.target as HTMLInputElement).files)" />
        <ul v-if="files.length" class="files">
          <li v-for="(f, i) in files" :key="f.name + f.size">
            <Icon name="paperclip" :size="13" class="faint" />
            <span class="ellipsis">{{ f.name }}</span>
            <small class="faint">{{ size(f.size) }}</small>
            <button type="button" class="ghost icon tiny" title="Remover" @click="files.splice(i, 1)"><Icon name="x" :size="12" /></button>
          </li>
        </ul>
      </div>

      <label class="check"><input v-model="useInCommit" type="checkbox" :disabled="!!created" /> Usar nos próximos commits</label>
      <p v-if="error" class="bad">{{ error }}</p>
    </div>

    <template #footer>
      <span v-if="progress" class="progress muted"><span class="spinner" /> {{ progress }}</span>
      <button type="button" @click="emit('close')">{{ created ? 'Fechar' : 'Cancelar' }}</button>
      <button type="button" class="primary" :disabled="!canSubmit" @click="submit">
        <Icon name="send" :size="14" /> {{ created ? 'Enviar o que faltou' : 'Enviar para aprovação' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 14px; max-height: 68vh; overflow: auto; padding: 4px; margin: -4px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.lbl b { color: var(--del); font-weight: 600; }
.title { font-size: 14px; padding: 9px 12px; }
.md { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--panel); transition: border-color 0.12s, box-shadow 0.12s; }
.md:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.md textarea:focus { box-shadow: none; }
.md-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--border); background: var(--panel-2); }
.md-bar .mono { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.spacer { flex: 1; }
.seg { display: flex; gap: 2px; padding: 2px; background: var(--panel); border-radius: 8px; }
.seg button { height: 24px; padding: 0 10px; border: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: transparent; color: var(--muted); }
.seg button.on { background: var(--accent-soft); color: var(--accent); }
.md textarea { border: 0; border-radius: 0; font-size: 13px; line-height: 1.55; resize: vertical; min-height: 150px; }
.preview { padding: 12px 14px; min-height: 150px; font-size: 13px; line-height: 1.6; user-select: text; overflow: auto; }
.preview :deep(h1), .preview :deep(h2), .preview :deep(h3) { margin: 0.6em 0 0.3em; line-height: 1.3; }
.preview :deep(h1) { font-size: 18px; }
.preview :deep(h2) { font-size: 16px; }
.preview :deep(h3) { font-size: 14px; }
.preview :deep(p) { margin: 0.4em 0; }
.preview :deep(code) { font-family: var(--mono); font-size: 12px; background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.preview :deep(pre) { background: var(--panel-2); padding: 10px; border-radius: 8px; overflow: auto; }
.preview :deep(pre code) { background: none; padding: 0; }
.preview :deep(a) { color: var(--accent); }
.preview :deep(table) { border-collapse: collapse; }
.preview :deep(th), .preview :deep(td) { border: 1px solid var(--border); padding: 4px 8px; }
.preview :deep(blockquote) { margin: 0.4em 0; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.member-picker { position: relative; }
.member-btn { width: 100%; height: 48px; justify-content: flex-start; gap: 10px; padding: 0 12px; }
.av { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex: none; }
.initials { display: inline-flex; align-items: center; justify-content: center; background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: 700; }
.who { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; flex: 1; line-height: 1.2; }
.who small { color: var(--accent); font-size: 11px; font-weight: 600; }
.chev { transform: rotate(90deg); color: var(--faint); }
.members {
  position: absolute; z-index: 10; left: 0; right: 0; top: calc(100% + 4px); margin: 0; padding: 4px; list-style: none;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  max-height: 220px; overflow: auto;
}
.members li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.members li:hover { background: var(--hover); }
.members li.on { background: var(--accent-soft); }
.prio { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); height: 48px; }
.prio button { height: 100%; border: 1px solid transparent; background: transparent; padding: 0 4px; gap: 6px; font-size: 12px; }
.prio i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.prio .low i { background: #3b9ff6; }
.prio .medium i { background: #f5a524; }
.prio .high i { background: #f97316; }
.prio .urgent i { background: #f43f5e; }
.prio button.on { background: var(--panel-2); border-color: var(--border); }
.prio .medium.on { border-color: #f5a52466; }
.prio .high.on { border-color: #f9731666; }
.prio .urgent.on { border-color: #f43f5e66; }
.prio .low.on { border-color: #3b9ff666; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.date { width: auto; height: 30px; padding: 0 8px; margin-left: 6px; }
.attach { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); }
.attach .head { display: flex; align-items: center; gap: 8px; }
.attach .head strong { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.accent { color: var(--accent); }
.drop {
  height: auto; padding: 16px; gap: 12px; border: 1px dashed var(--border); border-radius: 10px; background: var(--panel);
  justify-content: center; text-align: left; white-space: normal;
}
.drop.over { border-color: var(--accent); background: var(--accent-soft); }
.drop > span:last-child { display: flex; flex-direction: column; }
.drop small { font-weight: 400; font-size: 12px; }
.up { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); flex: none; }
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.files li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; background: var(--panel); font-size: 12.5px; }
.files small { margin-left: auto; flex: none; }
.tiny { width: 22px; height: 22px; padding: 0; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
.progress { display: flex; align-items: center; gap: 8px; margin-right: auto; font-size: 12px; }
.locked .field input, .locked textarea { opacity: 0.7; }
</style>
