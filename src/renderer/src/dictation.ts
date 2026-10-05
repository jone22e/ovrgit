import { computed, onUnmounted, ref } from 'vue'
import { DICTATION_RATE, encodeWav } from '@shared/transcribe'

/**
 * Ditado no compositor: grava o microfone e devolve o texto transcrito (o áudio é transcrito neste computador
 * e descartado). Um clique começa, outro termina; `cancel` descarta a gravação.
 */
const MAX_SECONDS = 10 * 60
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function useDictation(onText: (text: string) => void) {
  const api = window.ovseer
  const phase = ref<'idle' | 'recording' | 'transcribing'>('idle')
  const seconds = ref(0)
  const error = ref<string | null>(null)
  const time = computed(() => `${Math.floor(seconds.value / 60)}:${String(seconds.value % 60).padStart(2, '0')}`)
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let discard = false

  function release() {
    clearInterval(timer)
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    recorder = null
  }

  /** O que foi gravado (webm/opus) vira WAV mono de 16 kHz, que é o que o transcritor lê */
  async function toWav(blob: Blob): Promise<Uint8Array> {
    const ctx = new AudioContext()
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
      const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * DICTATION_RATE)), DICTATION_RATE)
      const src = offline.createBufferSource()
      src.buffer = decoded
      src.connect(offline.destination)
      src.start()
      return encodeWav((await offline.startRendering()).getChannelData(0), DICTATION_RATE)
    } finally {
      ctx.close().catch(() => undefined)
    }
  }

  async function finish() {
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
    chunks = []
    release()
    if (discard || !blob.size) return void (phase.value = 'idle')
    phase.value = 'transcribing'
    try {
      const text = await api.transcribeAudio(await toWav(blob))
      if (text) onText(text)
    } catch (e) {
      error.value = clean(e)
    } finally {
      phase.value = 'idle'
    }
  }

  async function start() {
    error.value = null
    discard = false
    try {
      if (!(await api.requestMicrophone())) throw new Error('Sem acesso ao microfone. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone.')
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recorder = new MediaRecorder(stream)
      chunks = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.onstop = finish
      recorder.start()
      seconds.value = 0
      phase.value = 'recording'
      timer = setInterval(() => ++seconds.value >= MAX_SECONDS && stop(), 1000)
    } catch (e) {
      release()
      phase.value = 'idle'
      error.value = clean(e)
    }
  }
  function stop() {
    if (recorder?.state === 'recording') recorder.stop()
  }
  /** Um clique começa a gravar; outro termina e transcreve */
  function toggle() {
    if (phase.value === 'idle') start()
    else if (phase.value === 'recording') stop()
  }
  /** Descarta a gravação em andamento */
  function cancel() {
    if (phase.value !== 'recording') return
    discard = true
    stop()
  }
  onUnmounted(() => {
    discard = true
    stop()
    release()
  })
  return { phase, seconds, time, error, toggle, cancel }
}
