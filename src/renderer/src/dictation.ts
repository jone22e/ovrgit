import { computed, onUnmounted, ref } from 'vue'
import { DICTATION_RATE, createNoiseFloor, encodeWav } from '@shared/transcribe'

/**
 * Ditado no compositor: grava o microfone e devolve o texto transcrito (o áudio é transcrito neste computador
 * e descartado). No ditado comum, um clique começa e outro termina. No modo conversa, a pausa encerra a fala e a
 * gravação seguinte começa na hora, no mesmo microfone, enquanto a anterior transcreve: nada do que é dito nesse
 * meio-tempo se perde. O microfone fica aberto durante toda a conversa; só fecha ao encerrá-la.
 */
const MAX_SECONDS = 10 * 60
/** Modo conversa: a pausa que encerra uma fala (uma pausa para pensar não pode cortar a frase) */
const PAUSE_MS = 1600
/** Modo conversa: uma fala não passa disso; o que vier depois vai na seguinte */
const MAX_UTTERANCE_MS = 30_000
/** Modo conversa: sem fala por este tempo, a gravação é descartada e recomeça (a escuta continua) */
const NO_SPEECH_MS = 25_000
const TICK_MS = 80
/** Medições seguidas acima do limiar para contar como fala (160 ms deixa passar cliques e batidas) */
const LOUD_FRAMES = 2
const NO_SPEECH = 'Não ouvi nenhuma fala na gravação.'
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type Recording = {
  recorder: MediaRecorder
  chunks: Blob[]
  /** Já ouviu fala (modo conversa) */
  heard: boolean
  /** Ao terminar, jogar fora em vez de transcrever */
  discard: boolean
  /** Ao terminar, começar outra gravação no mesmo microfone (modo conversa) */
  again: boolean
  timer?: ReturnType<typeof setInterval>
  listener?: ReturnType<typeof setInterval>
}

export function useDictation(onText: (text: string) => void, autoStopOnSilence?: () => boolean, terms?: () => string[]) {
  const api = window.ovseer
  const phase = ref<'idle' | 'recording' | 'transcribing'>('idle')
  const seconds = ref(0)
  const error = ref<string | null>(null)
  const time = computed(() => `${Math.floor(seconds.value / 60)}:${String(seconds.value % 60).padStart(2, '0')}`)
  const conversation = () => !!autoStopOnSilence?.()
  let stream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let noise = createNoiseFloor()
  let current: Recording | null = null
  /** Cancelar invalida as transcrições em andamento: o texto delas não entra mais */
  let generation = 0
  let starting = false
  let transcribing = 0
  /** As transcrições saem em ordem, uma por vez */
  let queue: Promise<void> = Promise.resolve()

  function settle() {
    phase.value = current ? 'recording' : transcribing ? 'transcribing' : 'idle'
  }

  function closeStream() {
    audioContext?.close().catch(() => undefined)
    audioContext = null
    analyser = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    noise = createNoiseFloor()
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

  async function transcribe(blob: Blob, attempt: number) {
    try {
      const text = await api.transcribeAudio(await toWav(blob), terms?.())
      if (text && attempt === generation) onText(text)
    } catch (e) {
      const message = clean(e)
      if (attempt === generation && !(conversation() && message === NO_SPEECH)) error.value = message
    }
  }

  /** Termina a gravação atual; o que ela ouviu vai para a transcrição (ou fora, se `discard`) */
  function end(rec: Recording, opts: { again?: boolean; discard?: boolean } = {}) {
    if (opts.discard) rec.discard = true
    rec.again = !!opts.again
    if (rec.recorder.state === 'recording') rec.recorder.stop()
  }

  function finished(rec: Recording) {
    clearInterval(rec.timer)
    clearInterval(rec.listener)
    if (current === rec) current = null
    const attempt = generation
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' })
    rec.chunks = []
    const keep = !rec.discard && blob.size > 0
    if (rec.again && conversation() && stream && attempt === generation) record()
    else if (!conversation()) closeStream()
    if (keep) {
      transcribing++
      queue = queue.then(() => transcribe(blob, attempt)).finally(() => {
        transcribing--
        settle()
      })
    }
    settle()
  }

  function record() {
    if (!stream) return
    const rec: Recording = { recorder: new MediaRecorder(stream), chunks: [], heard: false, discard: false, again: false }
    rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data)
    rec.recorder.onstop = () => finished(rec)
    rec.recorder.start()
    current = rec
    seconds.value = 0
    phase.value = 'recording'
    rec.timer = setInterval(() => ++seconds.value >= MAX_SECONDS && end(rec), 1000)
    if (!conversation() || !analyser) return
    const meter = analyser
    const samples = new Float32Array(meter.fftSize)
    let loudFrames = 0
    const started = performance.now()
    let lastVoice = started
    rec.listener = setInterval(() => {
      if (rec.recorder.state !== 'recording') return
      meter.getFloatTimeDomainData(samples)
      let energy = 0
      for (const sample of samples) energy += sample * sample
      const loud = noise.sample(Math.sqrt(energy / samples.length))
      const now = performance.now()
      if (loud) {
        if (++loudFrames >= LOUD_FRAMES) rec.heard = true
        lastVoice = now
      } else loudFrames = 0
      if (rec.heard && (now - lastVoice >= PAUSE_MS || now - started >= MAX_UTTERANCE_MS)) end(rec, { again: true })
      else if (!rec.heard && now - started >= NO_SPEECH_MS) end(rec, { again: true, discard: true })
    }, TICK_MS)
  }

  async function start() {
    if (phase.value === 'recording' || current || starting) return
    starting = true
    const attempt = generation
    error.value = null
    try {
      if (!stream) {
        const allowed = await api.requestMicrophone()
        if (attempt !== generation) return
        if (!allowed) throw new Error('Sem acesso ao microfone. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone.')
        const opened = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (attempt !== generation || stream) return void opened.getTracks().forEach((t) => t.stop())
        stream = opened
        if (conversation()) {
          audioContext = new AudioContext()
          analyser = audioContext.createAnalyser()
          analyser.fftSize = 2048
          audioContext.createMediaStreamSource(stream).connect(analyser)
        }
      }
      record()
    } catch (e) {
      closeStream()
      settle()
      if (attempt === generation) error.value = clean(e)
    } finally {
      starting = false
    }
  }
  /** Termina a gravação e transcreve */
  function stop() {
    if (current) end(current)
  }
  /** Um clique começa a gravar; outro termina e transcreve */
  function toggle() {
    if (phase.value === 'idle') start()
    else if (phase.value === 'recording') stop()
  }
  /** Descarta a gravação em andamento e o que ainda estava transcrevendo. Na conversa, o microfone continua aberto. */
  function cancel() {
    ++generation
    if (current) end(current, { discard: true })
    else if (!conversation()) closeStream()
    settle()
  }
  /** Modo conversa: o que já foi dito vai para a transcrição; sem fala, descarta. A escuta para até `start()`. */
  function flush() {
    if (!current) return
    end(current, { discard: !current.heard })
  }
  /** Encerra de vez: descarta tudo e fecha o microfone */
  function hangUp() {
    cancel()
    closeStream()
    settle()
  }
  onUnmounted(hangUp)
  return { phase, seconds, time, error, start, toggle, cancel, flush, hangUp }
}
