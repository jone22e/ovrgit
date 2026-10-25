import { computed, onUnmounted, ref } from 'vue'
import { DICTATION_RATE, encodeWav } from '@shared/transcribe'

/**
 * Ditado no compositor: grava o microfone e devolve o texto transcrito (o áudio é transcrito neste computador
 * e descartado). No ditado comum, um clique começa e outro termina; no modo conversa, a pausa encerra a fala.
 */
const MAX_SECONDS = 10 * 60
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function useDictation(onText: (text: string) => void, autoStopOnSilence?: () => boolean) {
  const api = window.ovseer
  const phase = ref<'idle' | 'recording' | 'transcribing'>('idle')
  const seconds = ref(0)
  const error = ref<string | null>(null)
  const time = computed(() => `${Math.floor(seconds.value / 60)}:${String(seconds.value % 60).padStart(2, '0')}`)
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let listenTimer: ReturnType<typeof setInterval> | undefined
  let audioContext: AudioContext | null = null
  let discard = false
  let generation = 0
  let starting = false

  function release() {
    clearInterval(timer)
    clearInterval(listenTimer)
    audioContext?.close().catch(() => undefined)
    audioContext = null
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
    const attempt = generation
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
    chunks = []
    release()
    if (discard || !blob.size) return void (phase.value = 'idle')
    phase.value = 'transcribing'
    try {
      const text = await api.transcribeAudio(await toWav(blob))
      if (text && attempt === generation) onText(text)
    } catch (e) {
      const message = clean(e)
      if (attempt === generation && !(autoStopOnSilence?.() && message === 'Não ouvi nenhuma fala na gravação.')) error.value = message
    } finally {
      phase.value = 'idle'
    }
  }

  async function start() {
    if (phase.value !== 'idle' || starting) return
    starting = true
    const attempt = ++generation
    error.value = null
    discard = false
    try {
      const allowed = await api.requestMicrophone()
      if (attempt !== generation) return
      if (!allowed) throw new Error('Sem acesso ao microfone. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone.')
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (attempt !== generation) return void release()
      recorder = new MediaRecorder(stream)
      chunks = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.onstop = finish
      recorder.start()
      seconds.value = 0
      phase.value = 'recording'
      timer = setInterval(() => ++seconds.value >= MAX_SECONDS && stop(), 1000)
      if (autoStopOnSilence?.()) {
        audioContext = new AudioContext()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        audioContext.createMediaStreamSource(stream).connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        let loudFrames = 0
        let heard = false
        let lastVoice = performance.now()
        const started = lastVoice
        listenTimer = setInterval(() => {
          if (phase.value !== 'recording') return
          analyser.getFloatTimeDomainData(samples)
          let energy = 0
          for (const sample of samples) energy += sample * sample
          const loud = Math.sqrt(energy / samples.length) >= 0.018
          const now = performance.now()
          if (loud) {
            loudFrames++
            if (loudFrames >= 3) heard = true
            lastVoice = now
          } else loudFrames = 0
          if (heard && (now - lastVoice >= 1100 || now - started >= 30_000)) stop()
          else if (!heard && now - started >= 25_000) cancel()
        }, 80)
      }
    } catch (e) {
      if (attempt !== generation) return void release()
      if (recorder?.state === 'recording') {
        discard = true
        recorder.stop()
      }
      release()
      phase.value = 'idle'
      error.value = clean(e)
    } finally {
      starting = false
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
    ++generation
    if (phase.value !== 'recording') return
    discard = true
    stop()
  }
  onUnmounted(() => {
    ++generation
    discard = true
    stop()
    release()
  })
  return { phase, seconds, time, error, start, toggle, cancel }
}
