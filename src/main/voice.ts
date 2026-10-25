import { app, webContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { findBinary, forgetBinary } from './cli'
import type { VoiceStatus } from '../shared/types'

const MODEL = 'hf://gradium/phonon-40m-pt'
const VOICE = 'Isadora'
const PHRASE = 'Olá! A voz local está pronta para conversar.'
const MAX_TEXT = 800
const MAC_RELEASE = {
  arm64: { file: 'ptts-0.4.0-aarch64-apple-darwin.tar.gz', sha256: '7b26c8b9d98f5b5894de09af2aad35e64827e8475c07b003557cafc1ebba6a40' },
  x64: { file: 'ptts-0.4.0-x86_64-apple-darwin.tar.gz', sha256: '17e67ef6e708b885f9a15172ab76be22cb02cdb8bf6afc9d00efcc06ced670b7' }
} as const
const LINUX_RELEASE = {
  arm64: { file: 'ptts-0.4.0-aarch64-unknown-linux-gnu.tar.gz', sha256: 'd1ae0e30bcab25bf5efc0c308ec01946b43f797b1bd0b0462037fb1789a61ffc' },
  x64: { file: 'ptts-0.4.0-x86_64-unknown-linux-gnu.tar.gz', sha256: '4ad1912856e6d91975fbd51b2f3a4dc774badc00eebe85c51a3908d8b1f5cb0a' }
} as const
type Job = { uid: string; text: string }
const jobs: Job[] = []
let active: Job | null = null
let child: ChildProcess | null = null
let canceled = false
let installing = false
const managedBinary = () => path.join(app.getPath('userData'), 'voice', process.platform === 'win32' ? 'ptts.exe' : 'ptts')
const voiceBinary = async () => existsSync(managedBinary()) ? managedBinary() : findBinary('ptts')

function broadcast(channel: string, value: unknown) {
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) wc.send(channel, value)
}

/** Resolve apenas arquivos já baixados: nenhuma resposta em voz faz acesso à rede. */
function cacheRoot(): string {
  return process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub')
}

function snapshots(repo: string): string[] {
  const dir = path.join(cacheRoot(), `models--gradium--${repo}`, 'snapshots')
  try { return readdirSync(dir).map((name) => path.join(dir, name)) } catch { return [] }
}

function localModel(): string | null {
  return snapshots('phonon-40m-pt').find((p) =>
    ['config.json', 'tokenizer.json', 'model.q8.gguf'].every((name) => existsSync(path.join(p, name)))) ?? null
}

function localVoice(): string | null {
  for (const dir of snapshots('phonon-voices')) {
    try {
      const lines = readFileSync(path.join(dir, 'voices.jsonl'), 'utf8').split('\n')
      const row = lines.map((line) => { try { return JSON.parse(line) as { name?: string; filename?: string } } catch { return null } })
        .find((entry) => entry?.name === VOICE)
      if (row?.filename) {
        const file = path.resolve(dir, row.filename)
        if (file.startsWith(dir + path.sep) && existsSync(file)) return file
      }
    } catch { /* catálogo ainda não foi baixado */ }
  }
  return null
}

export async function voiceStatus(): Promise<VoiceStatus> {
  const binary = await voiceBinary()
  const modelReady = !!localModel()
  const voiceReady = !!localVoice()
  const supported = (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')
  return {
    platform: process.platform, arch: process.arch,
    supported,
    installed: !!binary, modelReady, voiceReady, ready: supported && !!binary && modelReady && voiceReady,
    installing
  }
}

/** Arquivos e hashes da fórmula oficial gradium-ai/tap/ptts v0.4.0. */
async function installRelease(platform: 'darwin' | 'linux'): Promise<void> {
  if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error('Arquitetura não suportada pelo Phonon.')
  const release = platform === 'darwin' ? MAC_RELEASE[process.arch] : LINUX_RELEASE[process.arch]
  const url = `https://github.com/gradium-ai/xn-ptts/releases/download/v0.4.0/${release.file}`
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok) throw new Error(`Não foi possível baixar o Phonon (${response.status}).`)
  const data = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(data).digest('hex') !== release.sha256) throw new Error('O arquivo do Phonon não passou na verificação SHA-256.')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovseer-voice-install-'))
  try {
    const archive = path.join(dir, release.file)
    writeFileSync(archive, data)
    await command('/bin/tar', ['-xzf', archive, '-C', dir, 'ptts'])
    const target = managedBinary()
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(dir, 'ptts'), target)
    chmodSync(target, 0o755)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function command(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env, windowsHide: true, shell: false })
    let error = ''
    const timer = setTimeout(() => { proc.kill(); reject(new Error('A operação de voz demorou demais.')) }, timeoutMs)
    proc.stderr?.on('data', (data: Buffer) => { error = (error + data.toString('utf8')).slice(-3000) })
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(error.trim().split('\n').filter(Boolean).pop() || `O comando terminou com código ${code}.`))
    })
  })
}

export async function installVoice(token?: string): Promise<VoiceStatus> {
  if (!(await voiceStatus()).supported) throw new Error('Voz local indisponível neste sistema.')
  if (installing) throw new Error('A instalação de voz já está em andamento.')
  installing = true
  try {
    let bin = await voiceBinary()
    if (!bin) {
      broadcast('voice:progress', 'Instalando o Phonon…')
      if (process.platform === 'darwin') {
        const brew = await findBinary('brew')
        if (brew) {
          try { await command(brew, ['install', 'gradium-ai/tap/ptts']) }
          catch {
            broadcast('voice:progress', 'Instalando pelo pacote oficial do Phonon…')
            await installRelease('darwin')
          }
        } else await installRelease('darwin')
      } else if (process.platform === 'linux') {
        await installRelease('linux')
      } else {
        throw new Error('Instalador oficial não configurado para este sistema.')
      }
      forgetBinary('ptts')
      bin = await voiceBinary()
      if (!bin) throw new Error('O Phonon foi instalado, mas o executável ptts não foi encontrado.')
    }
    if (!localModel() || !localVoice()) {
      broadcast('voice:progress', 'Baixando o modelo e a voz Isadora…')
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ovseer-voice-'))
      try {
        try {
          await command(bin, ['--model', MODEL, '--voice', VOICE, '--lang', 'pt', '--quant', 'q8', '--device', 'cpu', '--output', path.join(dir, 'test.wav'), PHRASE],
            { ...process.env, ...(token?.trim() ? { HF_TOKEN: token.trim() } : {}) }, 30 * 60_000)
        } catch (e) {
          const message = (e as Error).message
          throw new Error(token?.trim() ? message.replaceAll(token.trim(), '[token oculto]') : message)
        }
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
    const status = await voiceStatus()
    if (!status.ready) throw new Error('O Phonon terminou, mas o modelo ou a voz Isadora não apareceram no cache local.')
    broadcast('voice:progress', 'Voz local pronta.')
    return status
  } finally {
    installing = false
  }
}

function runCancelable(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env, windowsHide: true, shell: false })
    child = proc
    let error = ''
    proc.stderr?.on('data', (data: Buffer) => { error = (error + data.toString('utf8')).slice(-2000) })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (child === proc) child = null
      if (canceled) resolve()
      else if (code === 0) resolve()
      else reject(new Error(error.trim().split('\n').filter(Boolean).pop() || 'Não foi possível reproduzir a voz.'))
    })
  })
}

async function play(file: string) {
  if (process.platform === 'darwin') return runCancelable('/usr/bin/afplay', [file], process.env)
  const player = await findBinary('paplay') || await findBinary('aplay')
  if (!player) throw new Error('Reprodutor WAV não encontrado (paplay ou aplay).')
  return runCancelable(player, [file], process.env)
}

async function drain() {
  if (active || !jobs.length) return
  while (jobs.length) {
    active = jobs.shift()!
    canceled = false
    const job = active
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ovseer-voice-'))
    try {
      const bin = await voiceBinary()
      const model = localModel()
      const voice = localVoice()
      if (!bin || !model || !voice) throw new Error('Instale a voz local antes de ativar a conversa.')
      if (canceled) continue
      const wav = path.join(dir, 'speech.wav')
      broadcast('voice:phase', { uid: job.uid, phase: 'generating' })
      await runCancelable(bin, ['--model', model, '--voice', voice, '--lang', 'pt', '--quant', 'q8', '--device', 'cpu', '--output', wav, job.text],
        { ...process.env, HF_HUB_OFFLINE: '1', HF_TOKEN: '' })
      if (!canceled && existsSync(wav)) {
        broadcast('voice:phase', { uid: job.uid, phase: 'playing' })
        await play(wav)
      }
    } catch (e) {
      if (!canceled) broadcast('voice:error', { uid: job.uid, message: (e as Error).message })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      active = null
      broadcast('voice:phase', { uid: job.uid, phase: 'idle' })
      broadcast('voice:queue', { uid: job.uid, pending: jobs.filter((x) => x.uid === job.uid).length })
    }
  }
}

export function speak(uid: string, text: string) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Voz local desativada neste sistema.')
  const trimmed = text.trim().slice(0, MAX_TEXT)
  if (!trimmed || !uid) return
  if (jobs.length >= 100) throw new Error('A fila de voz está cheia.')
  jobs.push({ uid, text: trimmed })
  broadcast('voice:queue', { uid, pending: jobs.filter((x) => x.uid === uid).length + (active?.uid === uid ? 1 : 0) })
  void drain()
}

export function cancelVoice(uid: string) {
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].uid === uid) jobs.splice(i, 1)
  if (active?.uid === uid) {
    canceled = true
    child?.kill()
  }
  broadcast('voice:phase', { uid, phase: 'idle' })
  broadcast('voice:queue', { uid, pending: 0 })
}

export function shutdownVoice() {
  jobs.splice(0)
  canceled = true
  child?.kill()
}

export function testVoice() { speak('__test__', PHRASE) }
