import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DICTATION_LOCALE, dictationTerms, readTranscribeOutput } from '../shared/transcribe'

/** Ajudante nativo de transcrição: só existe no macOS (empacotado em Resources/native; em desenvolvimento, em dist-native) */
function binary(): string | null {
  if (process.platform !== 'darwin') return null
  const p = app.isPackaged ? path.join(process.resourcesPath, 'native', 'ovseer-transcribe') : path.join(app.getAppPath(), 'dist-native', 'darwin', 'ovseer-transcribe')
  return existsSync(p) ? p : null
}

/** A primeira vez num idioma baixa o modelo de fala do sistema: por isso o prazo folgado */
const TIMEOUT_MS = 10 * 60_000
/** WAV de 16 kHz mono: 40 MB dá uns 20 minutos de fala */
const MAX_BYTES = 40 * 1024 * 1024

/**
 * Transcreve um áudio WAV (gravado no compositor) em texto, neste computador. `terms` são nomes que o reconhecedor
 * deve favorecer (projetos, agentes); o vocabulário básico de desenvolvimento entra sempre.
 */
export async function transcribeAudio(wav: Uint8Array, terms: readonly string[] = []): Promise<string> {
  const bin = binary()
  if (!bin) throw new Error(process.platform === 'darwin' ? 'Transcritor de áudio não encontrado neste app.' : 'A transcrição de áudio só está disponível no macOS.')
  if (!wav.byteLength) throw new Error('A gravação ficou vazia.')
  if (wav.byteLength > MAX_BYTES) throw new Error('Gravação longa demais para transcrever.')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ovseer-ditado-'))
  const file = path.join(dir, 'audio.wav')
  const termsFile = path.join(dir, 'terms.txt')
  try {
    await fsp.writeFile(file, wav)
    await fsp.writeFile(termsFile, dictationTerms(Array.isArray(terms) ? terms.map(String) : []).join('\n'))
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['--input', file, '--locale', DICTATION_LOCALE, '--terms', termsFile], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', (e) => (clearTimeout(timer), reject(e)))
      child.on('close', () => (clearTimeout(timer), resolve(out)))
    })
    const r = readTranscribeOutput(stdout)
    if ('error' in r) throw new Error(r.error)
    if (!r.text) throw new Error('Não ouvi nenhuma fala na gravação.')
    return r.text
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
