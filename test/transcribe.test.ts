import { describe, expect, it } from 'vitest'
import { encodeWav, readTranscribeOutput } from '../src/shared/transcribe'

const j = (o: unknown) => JSON.stringify(o)

describe('encodeWav', () => {
  it('escreve o cabeçalho e as amostras em 16 bits', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000)
    const v = new DataView(wav.buffer)
    expect(wav.byteLength).toBe(44 + 8)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(40, true)).toBe(8)
    expect([44, 46, 48, 50].map((at) => v.getInt16(at, true))).toEqual([0, 32767, -32768, 32767])
  })
})

describe('readTranscribeOutput', () => {
  it('junta os trechos do texto', () => {
    const out = [j({ type: 'status', state: 'transcribing' }), j({ type: 'text', text: 'Olá, corrija o erro. ' }), j({ type: 'text', text: 'Depois rode os testes.' }), j({ type: 'done' })].join('\n')
    expect(readTranscribeOutput(out)).toEqual({ text: 'Olá, corrija o erro. Depois rode os testes.' })
  })
  it('traduz os erros do ajudante', () => {
    expect(readTranscribeOutput(j({ type: 'error', code: 'unsupported-os', detail: 'x' }))).toEqual({ error: 'A transcrição de áudio precisa do macOS 26 ou mais novo.' })
    expect(readTranscribeOutput(j({ type: 'error', code: 'failed', detail: 'boom' }))).toEqual({ error: 'A transcrição falhou: boom' })
  })
  it('saída cortada no meio é erro', () => {
    expect(readTranscribeOutput(j({ type: 'text', text: 'Olá' }))).toEqual({ error: 'A transcrição parou antes de terminar.' })
    expect(readTranscribeOutput('')).toEqual({ error: 'A transcrição parou antes de terminar.' })
  })
})
