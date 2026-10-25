<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AgentAttachment, AgentEffort, AgentMode, AgentSnapshot, CliProvider, KnownModels, QueueTask } from '@shared/types'
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
const props = defineProps<{ agent?: AgentSnapshot; manager?: boolean; cwd?: string; extraDirs?: string[]; known: KnownModels | null; placeholder?: string; autoSendDictation?: boolean; voiceSpeaking?: boolean; voicePhase?: 'idle' | 'generating' | 'playing' }>()
const emit = defineEmits<{ send: [text: string, opts: { model: string; effort: AgentEffort; mode: AgentMode }, attachments: AgentAttachment[]]; managerTask: [task: QueueTask]; endConversation: []; voiceState: [state: 'listening' | 'transcribing' | 'thinking' | 'responding' | 'muted' | 'typing'] }>()
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
const waitingForVoice = ref(false)
const voiceStarted = ref(false)
const muted = ref(false)
const typing = ref(false)
const elapsed = ref(0)
let sessionStarted = 0
let elapsedTimer: ReturnType<typeof setInterval> | undefined
const elapsedLabel = computed(() => `${Math.floor(elapsed.value / 60)}:${String(elapsed.value % 60).padStart(2, '0')}`)
const voiceState = computed<'listening' | 'transcribing' | 'thinking' | 'responding' | 'muted' | 'typing'>(() => {
  if (typing.value) return 'typing'
  if (dictation.phase.value === 'transcribing') return 'transcribing'
  if (props.voicePhase === 'playing') return 'responding'
  if (waitingForVoice.value || props.voicePhase === 'generating') return 'thinking'
  if (muted.value) return 'muted'
  return 'listening'
})
let resumeTimer: ReturnType<typeof setTimeout> | undefined
function resumeListening() {
  clearTimeout(resumeTimer)
  if (!props.autoSendDictation || !canDictate || muted.value || typing.value || waitingForVoice.value || props.voiceSpeaking || dictation.phase.value !== 'idle') return
  resumeTimer = setTimeout(() => {
    if (props.autoSendDictation && !muted.value && !typing.value && !waitingForVoice.value && !props.voiceSpeaking && dictation.phase.value === 'idle') {
      void dictation.start().then(() => {
        if (props.autoSendDictation && dictation.phase.value === 'idle' && !dictation.error.value) resumeListening()
      })
    }
  }, 350)
}
const dictation = useDictation((words) => {
  text.value = text.value.trim() ? text.value.replace(/\s+$/, '') + ' ' + words : words
  nextTick(() => { autosize(); box.value?.focus() })
  if (props.autoSendDictation) {
    waitingForVoice.value = true
    nextTick(() => void send())
  }
}, () => !!props.autoSendDictation)
watch(voiceState, (phase) => { if (props.autoSendDictation) emit('voiceState', phase) }, { immediate: true })
watch(() => props.autoSendDictation, (active) => {
  clearTimeout(resumeTimer)
  clearInterval(elapsedTimer)
  if (active) {
    muted.value = false
    typing.value = false
    sessionStarted = Date.now()
    elapsed.value = 0
    elapsedTimer = setInterval(() => (elapsed.value = Math.floor((Date.now() - sessionStarted) / 1000)), 1000)
    emit('voiceState', voiceState.value)
    resumeListening()
  }
  else {
    waitingForVoice.value = false
    voiceStarted.value = false
    dictation.cancel()
  }
}, { immediate: true })
watch(() => dictation.phase.value, (phase) => { if (phase === 'idle') resumeListening() })
watch(() => props.voiceSpeaking, (speaking) => {
  if (speaking) {
    voiceStarted.value = true
    dictation.cancel()
  } else if (voiceStarted.value) {
    voiceStarted.value = false
    if (!sending.value) {
      waitingForVoice.value = false
      resumeListening()
    }
  }
})
watch(() => dictation.error.value, (error) => { if (error && props.autoSendDictation) emit('endConversation') })
function toggleMute() {
  muted.value = !muted.value
  if (muted.value) dictation.cancel()
  else resumeListening()
}
function toggleTyping() {
  typing.value = !typing.value
  if (typing.value) {
    dictation.cancel()
    nextTick(() => box.value?.focus())
  } else resumeListening()
}
function stopReply() { void api.voiceCancel('__manager__').catch(() => undefined) }

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
    sending.value = true
    try {
      if (props.autoSendDictation) {
        waitingForVoice.value = true
        dictation.cancel()
      }
      if (props.autoSendDictation) await api.voiceCancel('__manager__').catch(() => undefined)
      const tasks = await api.queueAdd({ text: t || (attachments.length === 1 ? 'Veja o arquivo anexado.' : 'Veja os arquivos anexados.'), cwd: props.cwd, extraDirs: props.extraDirs ? [...props.extraDirs] : undefined, managed: true, attachments, config: { provider: provider.value, model: model.value, effort: effort.value, mode: mode.value } })
      const task = tasks.at(-1)
      if (task) emit('managerTask', task)
      if (props.autoSendDictation) typing.value = false
      try {
        localStorage.setItem(AGENT_PREFS, JSON.stringify({ ...prefs, provider: provider.value, model: { ...prefs.model, [provider.value]: model.value }, effort: { ...prefs.effort, [provider.value]: effort.value }, mode: mode.value } satisfies AgentPrefs))
      } catch { /* preferência local indisponível: o pedido já foi salvo */ }
    } catch (e) {
      attachError.value = clean(e)
      waitingForVoice.value = false
      resumeListening()
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
  clearTimeout(resumeTimer)
  clearInterval(elapsedTimer)
  for (const a of pending) if (a.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
})
</script>

<template>
  <div class="mini" :class="{ drop: dragging, conversation: autoSendDictation }" @click.stop @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div v-if="dragging" class="drop-hint"><Icon name="paperclip" :size="14" /> Solte para anexar</div>
    <div v-if="autoSendDictation" class="voice-stage" :class="voiceState">
      <span class="voice-grip" aria-hidden="true" />
      <small class="voice-session"><i class="voice-led" /> CONVERSA POR VOZ · {{ elapsedLabel }}</small>
      <div v-if="!typing" class="voice-focus" :class="voiceState" aria-hidden="true">
        <span class="voice-ring outer" /><span class="voice-ring inner" />
        <span class="voice-core">
          <span v-if="voiceState === 'responding'" class="voice-bars"><i v-for="n in 7" :key="n" /></span>
          <Icon v-else-if="muted || !canDictate" name="micOff" :size="29" />
          <Icon v-else-if="voiceState === 'listening'" name="mic" :size="29" />
          <span v-else class="voice-dots"><i v-for="n in 3" :key="n" /></span>
        </span>
      </div>
      <div class="voice-description" aria-live="polite">
        <strong>{{ voiceState === 'responding' ? 'Respondendo' : voiceState === 'thinking' ? 'Pensando' : voiceState === 'transcribing' ? 'Transcrevendo' : voiceState === 'muted' ? 'Microfone mudo' : voiceState === 'typing' ? 'Digite sua mensagem' : canDictate ? 'Ouvindo' : 'Microfone indisponível' }}</strong>
        <span>{{ voiceState === 'responding' ? 'Use Parar para interromper' : voiceState === 'thinking' ? 'Preparando resposta' : voiceState === 'transcribing' ? 'Entendendo sua fala' : voiceState === 'muted' ? 'Toque em Ativar para voltar a falar' : voiceState === 'typing' ? 'Envie o texto abaixo' : canDictate ? 'Pause para enviar' : 'Use Digitar para conversar' }}</span>
      </div>
      <div class="voice-controls">
        <button type="button" class="voice-action" :disabled="!canDictate" :title="muted ? 'Ativar microfone' : 'Deixar microfone mudo'" @click="toggleMute"><span class="voice-action-icon"><Icon :name="muted ? 'mic' : 'micOff'" :size="18" /></span><small>{{ muted ? 'Ativar' : 'Mudo' }}</small></button>
        <button type="button" class="voice-action end" title="Encerrar conversa por voz" @click="dictation.cancel(); emit('endConversation')"><span class="voice-action-icon"><Icon name="x" :size="23" /></span><small>Encerrar</small></button>
        <button v-if="voiceState === 'responding'" type="button" class="voice-action" title="Parar resposta em voz" @click="stopReply"><span class="voice-action-icon"><Icon name="stop" :size="18" /></span><small>Parar</small></button>
        <button v-else type="button" class="voice-action" :title="typing ? 'Voltar à conversa por voz' : 'Escrever uma mensagem'" @click="toggleTyping"><span class="voice-action-icon"><Icon :name="typing ? 'mic' : 'keyboard'" :size="18" /></span><small>{{ typing ? 'Voltar' : 'Digitar' }}</small></button>
      </div>
    </div>
    <div v-show="!autoSendDictation || typing" class="compose-body">
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
      <div v-if="canDictate && !autoSendDictation" class="dictate">
        <button v-if="dictation.phase.value === 'recording'" type="button" class="ghost icon" title="Descartar gravação" @click="dictation.cancel"><Icon name="x" :size="12" /></button>
        <button type="button" class="ghost icon" :disabled="dictation.phase.value === 'transcribing'" :title="dictation.phase.value === 'recording' ? 'Terminar e transcrever' : 'Ditar'" @click="dictation.toggle"><Icon :name="dictation.phase.value === 'recording' ? 'stop' : 'mic'" :size="15" /></button>
      </div>
      <span class="spacer" />
      <button type="button" class="icon send primary" title="Enviar (Enter)" :disabled="!canSend || sending" @click="send"><Icon name="up" :size="16" /></button>
    </div>
    </div>
    <p v-if="autoSendDictation && !typing && (attachError || dictation.error.value)" class="att-err">{{ attachError || dictation.error.value }}</p>
  </div>
</template>

<style scoped>
.mini {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 6px; border-radius: 16px;
  background: var(--panel); border: 1px solid var(--border); min-width: 0;
}
.mini:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.compose-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mini.conversation { gap: 0; padding: 0; background: var(--panel-2); }
.mini.conversation:focus-within { border-color: var(--border); }
.mini.conversation .compose-body { padding: 0 10px 10px; }
.voice-stage { box-sizing: border-box; display: flex; flex-direction: column; align-items: center; width: 100%; height: clamp(310px, 43vh, 410px); padding: 12px 12px 16px; border-radius: 22px 22px 0 0; background: color-mix(in srgb, var(--panel-2) 80%, var(--bg)); text-align: center; }
.voice-stage.typing { height: 170px; }
.voice-grip { display: block; width: 35px; height: 4px; border-radius: 4px; background: var(--border); flex: none; }
.voice-session { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 16px; margin-top: 13px; color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .1em; }
.voice-led { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.voice-focus { position: relative; display: grid; place-items: center; width: 116px; height: 116px; flex: none; margin: auto 0 10px; }
.voice-ring { position: absolute; border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border)); border-radius: 50%; }
.voice-ring.outer { inset: 0; }
.voice-ring.inner { inset: 15px; border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.voice-core { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; color: var(--accent); background: color-mix(in srgb, var(--accent) 17%, var(--panel)); }
.voice-focus.listening .voice-core { background: var(--accent); color: var(--on-accent); box-shadow: 0 0 0 12px color-mix(in srgb, var(--accent) 13%, transparent); }
.voice-focus.listening .voice-ring.inner { animation: voice-pulse 1.8s ease-in-out infinite; }
.voice-focus.thinking .voice-ring.outer, .voice-focus.transcribing .voice-ring.outer { border-style: dashed; animation: voice-turn 9s linear infinite; }
.voice-focus.responding .voice-core { border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border)); }
.voice-focus.muted { opacity: .55; }
.voice-dots, .voice-bars { display: flex; align-items: center; justify-content: center; gap: 4px; height: 26px; }
.voice-dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: voice-dot 1.2s ease-in-out infinite; }
.voice-dots i:nth-child(2) { animation-delay: .18s; }
.voice-dots i:nth-child(3) { animation-delay: .36s; }
.voice-bars i { width: 3px; height: 10px; border-radius: 3px; background: var(--accent); animation: voice-wave .7s ease-in-out infinite alternate; }
.voice-bars i:nth-child(2), .voice-bars i:nth-child(6) { animation-delay: .1s; }
.voice-bars i:nth-child(3), .voice-bars i:nth-child(5) { animation-delay: .25s; }
.voice-bars i:nth-child(4) { animation-delay: .4s; }
.voice-description { display: flex; flex-direction: column; gap: 3px; min-height: 44px; }
.voice-description strong { color: var(--text); font-size: 16px; }
.voice-description span { color: var(--muted); font-size: 11px; }
.voice-controls { display: flex; align-items: flex-start; justify-content: center; gap: 14px; width: 100%; margin-top: auto; padding-top: 12px; }
.voice-action { display: flex; flex-direction: column; align-items: center; gap: 5px; width: 68px; padding: 0; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.voice-action:hover:not(:disabled) { color: var(--text); }
.voice-action:disabled { opacity: .45; cursor: default; }
.voice-action-icon { display: grid; place-items: center; width: 43px; height: 43px; border-radius: 50%; background: var(--panel); }
.voice-action.end .voice-action-icon { background: color-mix(in srgb, var(--del) 25%, var(--panel)); color: color-mix(in srgb, var(--del) 60%, var(--text)); }
.voice-action small { font-size: 10px; }
@keyframes voice-pulse { 50% { transform: scale(1.12); opacity: .5; } }
@keyframes voice-turn { to { transform: rotate(360deg); } }
@keyframes voice-dot { 50% { opacity: .3; transform: translateY(-3px); } }
@keyframes voice-wave { to { height: 24px; } }
@media (prefers-reduced-motion: reduce) { .voice-ring, .voice-dots i, .voice-bars i { animation: none !important; } }
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
