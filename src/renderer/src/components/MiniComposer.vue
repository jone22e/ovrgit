<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AgentAttachment, AgentEffort, AgentMode, AgentSnapshot, CliProvider, KnownModels } from '@shared/types'
import { MODES } from '@shared/models'
import { readAgentPrefs, AGENT_PREFS, type AgentPrefs } from '../agentPrefs'
import { useDictation } from '../dictation'
import Icon from './Icon.vue'
import ModelPicker from './ModelPicker.vue'

/**
 * Campo de instrução do gerenciador de agentes, com a cara e os recursos do composer da janela do agente: texto
 * de várias linhas, anexos (botão, arrastar, colar), texto grande colado como cartão, modelo e esforço, modo e o
 * botão redondo de enviar. No gerenciador, usa as preferências salvas; numa conversa, acompanha o agente.
 */
const props = defineProps<{ agent?: AgentSnapshot; manager?: boolean; cwd?: string; extraDirs?: string[]; known: KnownModels | null; placeholder?: string; autoSendDictation?: boolean }>()
const emit = defineEmits<{ send: [text: string, opts: { model: string; effort: AgentEffort; mode: AgentMode }, attachments: AgentAttachment[]] }>()
const api = window.ovseer
const prefs = readAgentPrefs()
const pickerDefaults = Object.fromEntries((['claude', 'codex', 'agy'] as CliProvider[]).map((p) => [p, { model: prefs.model[p], effort: prefs.effort[p] }]))

const text = ref('')
const box = ref<HTMLTextAreaElement>()
const provider = ref(props.agent?.provider ?? prefs.provider)
const model = ref(props.agent?.modelId ?? prefs.model[prefs.provider])
const effort = ref<AgentEffort>(props.agent?.effort ?? prefs.effort[prefs.provider])
const mode = ref<AgentMode>(props.agent?.mode ?? prefs.mode)
// a janela mudou de modelo/modo (ou é outro agente): o campo acompanha
watch(
  () => props.agent ? [props.agent.uid, props.agent.modelId, props.agent.effort, props.agent.mode] as const : null,
  (current) => {
    if (!current) return
    model.value = current[1]
    effort.value = current[2]
    mode.value = current[3]
  }
)
const modeOpen = ref(false)
const modeRoot = ref<HTMLElement>()
const currentMode = computed(() => MODES.find((m) => m.id === mode.value) ?? MODES[MODES.length - 1])
const canSend = computed(() => !!(text.value.trim() || pending.length || pastes.length))
const sending = ref(false)
const canDictate = api.platform === 'darwin'
const dictation = useDictation((words) => {
  text.value = text.value.trim() ? text.value.replace(/\s+$/, '') + ' ' + words : words
  nextTick(() => { autosize(); box.value?.focus() })
  if (props.autoSendDictation) nextTick(() => void send())
})

// ---------- anexos: os mesmos caminhos da janela do agente (os arquivos ficam guardados para a janela `uid`) ----------
type Shown = AgentAttachment & { preview?: string }
const pending = reactive<Shown[]>([])
const attachError = ref<string | null>(null)
const dragging = ref(false)
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const isImage = (type: string, name: string) => /^image\//.test(type) || /\.(png|jpe?g|gif|webp)$/i.test(name)
const sizeOf = (n: number) => (!n ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const PREVIEW_MAX = 25 * 1024 * 1024
function pushPending(a: Shown) {
  if (pending.some((x) => x.path === a.path)) return
  if (pending.length >= 20) {
    attachError.value = 'Máximo de 20 anexos por mensagem.'
    return
  }
  pending.push(a)
}
async function pickFiles() {
  attachError.value = null
  try {
    for (const a of props.manager ? await api.queuePickFiles(props.cwd) : await api.agentPickFiles(props.agent!.uid)) {
      pushPending(a)
      const added = pending.find((x) => x.path === a.path)
      if (added && added.kind === 'image' && !added.preview) api.agentImage(a.path).then((url) => url && (added.preview = url)).catch(() => undefined)
    }
  } catch (e) {
    attachError.value = clean(e)
  }
}
/** Arquivos arrastados (têm caminho) ou colados (só bytes): os sem caminho são guardados pelo app */
async function addFiles(files: File[]) {
  attachError.value = null
  for (const f of files) {
    try {
      const preview = isImage(f.type, f.name) && f.size <= PREVIEW_MAX ? URL.createObjectURL(new Blob([await f.arrayBuffer()], { type: f.type || 'image/png' })) : undefined
      const real = api.filePath(f)
      if (real) pushPending({ ...(props.manager ? await api.queueKeepFile(real) : await api.agentKeepFile(props.agent!.uid, real)), preview })
      else {
        const name = f.name && f.name !== 'image.png' ? f.name : `colado-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
        const blob = { name, type: f.type, data: await f.arrayBuffer() }
        pushPending({ ...(props.manager ? await api.queueSaveBlob(blob) : await api.agentSaveBlob(props.agent!.uid, blob)), preview })
      }
    } catch (e) {
      attachError.value = clean(e)
    }
  }
}
function removePending(i: number) {
  const [a] = pending.splice(i, 1)
  if (a?.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
}
function onDrop(e: DragEvent) {
  dragging.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) addFiles(files)
}
/** Texto colado grande vira um cartão, em vez de tomar o campo inteiro */
const PASTE_CHARS = 1200
const PASTE_LINES = 12
const pastes = reactive<{ id: string; text: string; lines: number }[]>([])
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
  if (files.length) {
    e.preventDefault()
    addFiles(files)
    return
  }
  const t = e.clipboardData?.getData('text/plain') ?? ''
  const lines = t.split('\n').length
  if (t.length > PASTE_CHARS || lines > PASTE_LINES) {
    e.preventDefault()
    pastes.push({ id: crypto.randomUUID(), text: t, lines })
  }
}
const pastePreview = (t: string) => t.trim().split('\n')[0].slice(0, 60)

function autosize() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}
async function send() {
  if (!canSend.value || sending.value) return
  const pasted = pastes.map((p) => p.text.trim()).filter(Boolean)
  const t = [text.value.trim(), ...pasted].filter(Boolean).join('\n\n')
  // a prévia é só desta tela; a ação vai para a outra janela sem ela
  const attachments = pending.map(({ preview: _p, ...a }) => a)
  if (props.manager) {
    if (!props.cwd) return void (attachError.value = 'Escolha um repositório para o pedido.')
    sending.value = true
    try {
      await api.queueAdd({ text: t || (attachments.length === 1 ? 'Veja o arquivo anexado.' : 'Veja os arquivos anexados.'), cwd: props.cwd, extraDirs: props.extraDirs ? [...props.extraDirs] : undefined, managed: true, attachments, config: { provider: provider.value, model: model.value, effort: effort.value, mode: mode.value } })
      try {
        localStorage.setItem(AGENT_PREFS, JSON.stringify({ ...prefs, provider: provider.value, model: { ...prefs.model, [provider.value]: model.value }, effort: { ...prefs.effort, [provider.value]: effort.value }, mode: mode.value } satisfies AgentPrefs))
      } catch { /* preferência local indisponível: o pedido já foi salvo */ }
    } catch (e) {
      attachError.value = clean(e)
      return
    } finally {
      sending.value = false
    }
  } else emit('send', t, { model: model.value, effort: effort.value, mode: mode.value }, attachments)
  for (const a of pending) if (a.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
  pending.splice(0)
  pastes.splice(0)
  text.value = ''
  attachError.value = null
  nextTick(autosize)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
const onDoc = (e: MouseEvent) => {
  if (modeOpen.value && modeRoot.value && !modeRoot.value.contains(e.target as Node)) modeOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  for (const a of pending) if (a.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
})
</script>

<template>
  <div class="mini" :class="{ drop: dragging }" @click.stop @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div v-if="dragging" class="drop-hint"><Icon name="paperclip" :size="14" /> Solte para anexar</div>
    <div v-if="pending.length || pastes.length" class="pending">
      <template v-for="(a, i) in pending" :key="a.path">
        <span v-if="a.preview" class="thumb" :title="`${a.name}${a.size ? ` · ${sizeOf(a.size)}` : ''}`">
          <img :src="a.preview" :alt="a.name" />
          <button type="button" class="thumb-rm" title="Remover" @click.stop="removePending(i)"><Icon name="x" :size="11" /></button>
        </span>
        <span v-else class="att" :title="`${a.path}${a.size ? ` · ${sizeOf(a.size)}` : ''}`">
          <Icon :name="a.kind === 'image' ? 'panel' : a.kind === 'audio' ? 'mic' : 'paperclip'" :size="12" />
          <span class="ellipsis">{{ a.name }}</span>
          <button type="button" class="ghost rm" title="Remover" @click="removePending(i)"><Icon name="x" :size="11" /></button>
        </span>
      </template>
      <span v-for="(p, i) in pastes" :key="p.id" class="att" :title="p.text.slice(0, 600)">
        <Icon name="clipboard" :size="12" />
        <span class="ellipsis">{{ pastePreview(p.text) }} · {{ p.lines }} linhas</span>
        <button type="button" class="ghost rm" title="Remover" @click="pastes.splice(i, 1)"><Icon name="x" :size="11" /></button>
      </span>
    </div>
    <p v-if="attachError" class="att-err">{{ attachError }}</p>
    <p v-if="dictation.error.value" class="att-err">{{ dictation.error.value }}</p>
    <textarea ref="box" v-model="text" rows="1" :placeholder="placeholder ?? 'Próxima instrução para este agente…'" maxlength="4000" @input="autosize" @keydown="onKey" @paste="onPaste" />
    <slot name="scope" />
    <div class="row">
      <button type="button" class="ghost icon attach" title="Anexar arquivos (ou arraste/cole aqui)" @click="pickFiles"><Icon name="paperclip" :size="15" /></button>
      <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" providers :lock-provider="!!agent" :known="known" :defaults="pickerDefaults" />
      <div ref="modeRoot" class="mode-menu">
        <button type="button" class="chip mode-chip" :class="[`m-${mode}`, { on: modeOpen }]" :title="`${currentMode.label}: ${currentMode.hint}`" :aria-label="currentMode.label" @click="modeOpen = !modeOpen">
          <Icon :name="currentMode.icon" :size="13" />
        </button>
        <div v-if="modeOpen" class="pop">
          <button v-for="m in MODES" :key="m.id" type="button" class="ghost opt" :class="{ cur: mode === m.id }" @click="(mode = m.id), (modeOpen = false)">
            <Icon :name="m.icon" :size="13" />
            <span class="opt-text"><strong>{{ m.label }}</strong><small>{{ m.hint }}</small></span>
            <Icon v-if="mode === m.id" name="check" :size="13" class="ok" />
          </button>
        </div>
      </div>
      <slot name="actions" />
      <div v-if="canDictate" class="dictate">
        <button v-if="dictation.phase.value === 'recording'" type="button" class="ghost icon" title="Descartar gravação" @click="dictation.cancel"><Icon name="x" :size="12" /></button>
        <button type="button" class="ghost icon" :disabled="dictation.phase.value === 'transcribing'" :title="dictation.phase.value === 'recording' ? 'Terminar e transcrever' : 'Ditar'" @click="dictation.toggle"><Icon :name="dictation.phase.value === 'recording' ? 'stop' : 'mic'" :size="15" /></button>
      </div>
      <span class="spacer" />
      <button type="button" class="icon send primary" title="Enviar (Enter)" :disabled="!canSend || sending || (manager && !cwd)" @click="send"><Icon name="up" :size="16" /></button>
    </div>
  </div>
</template>

<style scoped>
.mini {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 6px; border-radius: 16px;
  background: var(--panel); border: 1px solid var(--border); min-width: 0;
}
.mini:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
textarea { border: 0; background: transparent; padding: 4px 6px 2px; font-size: 13px; line-height: 1.45; max-height: 160px; overflow-y: auto; resize: none; width: 100%; }
textarea:focus { box-shadow: none; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.spacer { flex: 1 1 auto; }
.dictate { display: flex; align-items: center; flex: none; }
.chip { height: 30px; padding: 0 10px; gap: 6px; border-radius: 999px; font-size: 12px; color: var(--muted); flex: none; }
.chip.mode-chip { width: 30px; padding: 0; justify-content: center; }
.chip.m-full { color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); }
.chip.m-plan, .chip.m-checklist { color: var(--hunk); border-color: color-mix(in srgb, var(--hunk) 45%, var(--border)); }
.chip.on { background: var(--hover); }
.mode-menu { position: relative; flex: none; }
.pop {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30; width: 300px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.opt { justify-content: flex-start; gap: 10px; height: auto; padding: 8px 10px; text-align: left; white-space: normal; color: var(--text); }
.opt.cur { background: var(--accent-soft); }
.opt-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.opt-text strong { font-size: 12.5px; }
.opt-text small { font-size: 11px; color: var(--muted); line-height: 1.35; }
.opt .ok { color: var(--accent); flex: none; }
.send { width: 32px; height: 32px; border-radius: 50%; flex: none; }
/* anexos: os mesmos elementos do composer da janela do agente */
.mini.drop { border-color: var(--accent); background: var(--accent-soft); }
.drop-hint { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 4px; color: var(--accent); font-weight: 600; font-size: 12px; }
.attach { width: 30px; height: 30px; border-radius: 50%; color: var(--muted); flex: none; }
.pending { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px 0; }
.att {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px 0 6px; max-width: 240px;
  border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); font-size: 12px; color: var(--muted);
}
.att .rm { width: 18px; height: 18px; padding: 0; color: var(--faint); flex: none; }
.att-err { margin: 0 6px; font-size: 12px; color: var(--del); }
.thumb { position: relative; display: block; width: 56px; height: 56px; flex: none; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); background: var(--panel-2); }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-rm { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); color: #fff; cursor: pointer; }
.thumb-rm:hover { background: rgba(0, 0, 0, 0.85); }
</style>
