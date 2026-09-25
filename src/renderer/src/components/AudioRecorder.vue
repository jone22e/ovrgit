<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { api } from '../store'
import Icon from './Icon.vue'

/** Gravação da explicação em áudio (opcional), no mesmo fluxo do Ovseer: escolher microfone, gravar, ouvir. */
const model = defineModel<File | null>({ default: null })

type Phase = 'idle' | 'setup' | 'recording' | 'done'
const phase = ref<Phase>(model.value ? 'done' : 'idle')
const devices = ref<MediaDeviceInfo[]>([])
const deviceId = ref('')
const seconds = ref(0)
const levels = ref<number[]>(Array(28).fill(0.08))
const error = ref<string | null>(null)
const url = ref<string | null>(model.value ? URL.createObjectURL(model.value) : null)

const MAX_SECONDS = 10 * 60
let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let timer: ReturnType<typeof setInterval> | undefined
let raf = 0
let audioCtx: AudioContext | null = null

const time = computed(() => {
  const s = seconds.value
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
})

function extension(mime: string) {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

function stopStream() {
  cancelAnimationFrame(raf)
  audioCtx?.close().catch(() => undefined)
  audioCtx = null
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

async function openSetup() {
  error.value = null
  if (!(await api.requestMicrophone())) {
    error.value = 'Acesso ao microfone negado. Libere em Ajustes do Sistema → Privacidade → Microfone.'
    return
  }
  try {
    // pede acesso uma vez para os nomes dos microfones aparecerem
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((t) => t.stop())
    devices.value = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    deviceId.value = devices.value.find((d) => d.deviceId === 'default')?.deviceId ?? devices.value[0]?.deviceId ?? ''
    phase.value = 'setup'
  } catch {
    error.value = 'Nenhum microfone disponível.'
  }
}

function meter(s: MediaStream) {
  audioCtx = new AudioContext()
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 64
  audioCtx.createMediaStreamSource(s).connect(analyser)
  const data = new Uint8Array(analyser.frequencyBinCount)
  const tick = () => {
    analyser.getByteFrequencyData(data)
    levels.value = levels.value.map((_, i) => Math.max(0.08, (data[i % data.length] ?? 0) / 255))
    raf = requestAnimationFrame(tick)
  }
  tick()
}

async function start() {
  error.value = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId.value ? { deviceId: { exact: deviceId.value } } : true
    })
  } catch {
    error.value = 'Não foi possível usar esse microfone.'
    return
  }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t))
  recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
  chunks = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  recorder.onstop = () => {
    const mime = recorder?.mimeType || chunks[0]?.type || 'audio/webm'
    const blob = new Blob(chunks, { type: mime })
    const file = new File([blob], `explicacao.${extension(mime)}`, { type: mime })
    setFile(file)
    stopStream()
    phase.value = 'done'
  }
  recorder.start(250)
  meter(stream)
  seconds.value = 0
  timer = setInterval(() => {
    seconds.value += 1
    if (seconds.value >= MAX_SECONDS) stop()
  }, 1000)
  phase.value = 'recording'
}

function stop() {
  clearInterval(timer)
  if (recorder?.state === 'recording') recorder.stop()
}

function setFile(file: File | null) {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = file ? URL.createObjectURL(file) : null
  model.value = file
}

function discard() {
  setFile(null)
  phase.value = 'idle'
}

function cancelSetup() {
  stop()
  stopStream()
  phase.value = model.value ? 'done' : 'idle'
}

watch(model, (f) => {
  if (!f && phase.value === 'done') phase.value = 'idle'
})

onUnmounted(() => {
  clearInterval(timer)
  if (recorder?.state === 'recording') {
    recorder.onstop = null
    recorder.stop()
  }
  stopStream()
  if (url.value) URL.revokeObjectURL(url.value)
})
</script>

<template>
  <div class="audio" :class="phase">
    <div class="head">
      <Icon name="mic" :size="15" class="accent" />
      <strong>Explicação em áudio</strong>
      <span class="opt">opcional</span>
      <span class="spacer" />
      <button v-if="phase === 'idle'" type="button" class="small" @click="openSetup">
        <Icon name="mic" :size="14" /> Gravar áudio
      </button>
      <button v-else-if="phase === 'done'" type="button" class="small ghost danger" @click="discard">Remover</button>
    </div>
    <p v-if="phase === 'idle'" class="muted hint">Grave uma explicação complementar sobre o que será feito.</p>

    <template v-if="phase === 'setup' || phase === 'recording'">
      <label class="mic">
        <Icon name="mic" :size="14" class="faint" />
        <select v-model="deviceId" :disabled="phase === 'recording'">
          <option v-for="d in devices" :key="d.deviceId" :value="d.deviceId">{{ d.label || 'Microfone' }}</option>
        </select>
      </label>
      <div class="stage">
        <template v-if="phase === 'setup'">
          <span class="bubble"><Icon name="mic" :size="22" /></span>
          <strong>Pronto para gravar</strong>
          <span class="muted">Fale normalmente. Você poderá ouvir antes de enviar.</span>
        </template>
        <template v-else>
          <div class="bars">
            <i v-for="(l, i) in levels" :key="i" :style="{ transform: `scaleY(${l})` }" />
          </div>
          <span class="rec"><span class="dot" /> Gravando · {{ time }}</span>
        </template>
      </div>
      <div class="actions">
        <button type="button" class="small" @click="cancelSetup">Cancelar</button>
        <button v-if="phase === 'setup'" type="button" class="small primary" @click="start">
          <Icon name="mic" :size="14" /> Iniciar gravação
        </button>
        <button v-else type="button" class="small primary stop" @click="stop"><span class="sq" /> Parar</button>
      </div>
    </template>

    <div v-if="phase === 'done' && url" class="done">
      <audio :src="url" controls class="player" />
      <span v-if="seconds" class="dur mono">{{ time }}</span>
    </div>
    <p v-if="error" class="bad">{{ error }}</p>
  </div>
</template>

<style scoped>
.audio { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); }
.head { display: flex; align-items: center; gap: 8px; }
.head strong { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.accent { color: var(--accent); }
.opt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; background: var(--panel); color: var(--muted); padding: 1px 7px; border-radius: 999px; font-weight: 600; }
.spacer { flex: 1; }
.hint { margin: -4px 0 0; font-size: 12px; }
.danger:hover { color: var(--del); background: var(--del-bg) !important; }
.mic { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.mic select { border: 0; background: transparent; padding: 8px 0; }
.stage {
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 22px 12px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--panel); text-align: center;
}
.stage .muted { font-size: 12px; }
.bubble { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); margin-bottom: 6px; }
.bars { display: flex; align-items: center; gap: 3px; height: 48px; }
.bars i { width: 4px; height: 100%; border-radius: 2px; background: var(--accent); transform-origin: center; transition: transform 0.08s linear; }
.rec { display: flex; align-items: center; gap: 8px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 6px; }
.rec .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--del); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.sq { width: 9px; height: 9px; border-radius: 2px; background: currentColor; }
.done { display: flex; align-items: center; gap: 10px; }
.player { flex: 1; height: 36px; min-width: 0; }
.dur { font-size: 12px; color: var(--muted); flex: none; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
