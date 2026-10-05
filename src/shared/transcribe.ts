/**
 * Ditado: o áudio gravado no compositor vira texto pelo ajudante nativo `ovseer-transcribe` (reconhecimento de fala
 * do macOS, neste computador). Aqui fica o que não depende do Electron: o WAV que o ajudante lê e a leitura da saída dele.
 */

/** Taxa em que o áudio vai para o ajudante (fala não precisa de mais, e o arquivo fica pequeno) */
export const DICTATION_RATE = 16000
/** Idioma do ditado */
export const DICTATION_LOCALE = 'pt-BR'

/** WAV PCM de 16 bits, mono, a partir das amostras (−1 a 1) */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  out.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true) // PCM
  out.setUint16(22, 1, true) // mono
  out.setUint32(24, sampleRate, true)
  out.setUint32(28, sampleRate * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  ascii(36, 'data')
  out.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(out.buffer)
}

/** Erros do ajudante em linguagem de usuário */
const ERRORS: Record<string, string> = {
  'unsupported-os': 'A transcrição de áudio precisa do macOS 26 ou mais novo.',
  'unsupported-locale': 'Este Mac não tem o reconhecimento de fala em português.',
  'unreadable-audio': 'Não deu para ler o áudio gravado.'
}

/** Lê a saída do ajudante (uma linha JSON por vez): o texto transcrito ou o erro */
export function readTranscribeOutput(stdout: string): { text: string } | { error: string } {
  const parts: string[] = []
  let done = false
  for (const line of stdout.split('\n')) {
    let o: { type?: string; text?: string; code?: string; detail?: string }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'text' && o.text) parts.push(o.text)
    else if (o.type === 'done') done = true
    else if (o.type === 'error') return { error: ERRORS[o.code ?? ''] ?? `A transcrição falhou${o.detail ? `: ${o.detail.slice(0, 200)}` : '.'}` }
  }
  if (!done) return { error: 'A transcrição parou antes de terminar.' }
  // cada trecho já vem com a pontuação e os espaços dele
  return { text: parts.join('').replace(/\s+/g, ' ').trim() }
}
