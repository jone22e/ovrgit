import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { BrowserWindow, type WebContents } from 'electron'
import type { Service, ServiceState } from '../shared/types'
import { getSettings } from './settings'

/**
 * Serviços em segundo plano: cada um é um comando de shell (encaminhamento de porta, servidor de desenvolvimento…)
 * que o usuário liga e desliga pelo menu Serviços. Roda num pseudoterminal, guarda a saída recente e pode ser
 * visto numa janela própria com o terminal, só quando pedida.
 */

interface Running {
  pty: IPty
  startedAt: number
  /** Saída recente (limitada), para a janela do terminal mostrar o que já passou */
  buffer: string
  /** Janelas acompanhando a saída ao vivo */
  viewers: Set<WebContents>
}

const BUFFER_MAX = 400_000
const running = new Map<string, Running>()
/** Última execução de cada serviço (para "saiu com código X" na lista) */
const exits = new Map<string, number | null>()
const lastLines = new Map<string, string>()
let setup: { icon: string; background: () => string } | null = null
const windows = new Map<string, BrowserWindow>()

export function setupServices(s: { icon: string; background: () => string }) {
  setup = s
}

const find = (id: string): Service | undefined => getSettings().services.find((s) => s.id === id)

export function serviceStates(): ServiceState[] {
  return getSettings().services.map((s) => {
    const r = running.get(s.id)
    if (r) return { id: s.id, status: 'running', pid: r.pty.pid, startedAt: r.startedAt, lastLine: lastLines.get(s.id) }
    if (exits.has(s.id)) return { id: s.id, status: 'exited', exitCode: exits.get(s.id), lastLine: lastLines.get(s.id) }
    return { id: s.id, status: 'stopped' }
  })
}

function broadcast() {
  const states = serviceStates()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('services:changed', states)
}

/** Shell de login (carrega o PATH do usuário: nvm, brew…) rodando o comando do serviço */
function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    return { file: existsSync(pwsh) ? pwsh : 'powershell.exe', args: ['-NoLogo', '-Command', command] }
  }
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  return { file: shell, args: ['-l', '-c', command] }
}

/** Última linha não vazia da saída, sem códigos de cor */
function tail(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n')
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? '').slice(0, 160)
}

export async function startService(id: string): Promise<void> {
  const s = find(id)
  if (!s) throw new Error('Serviço não encontrado.')
  if (running.has(id)) return
  const { spawn } = await import('@lydell/node-pty')
  const { file, args } = shellFor(s.command)
  const cwd = s.cwd && existsSync(s.cwd) ? s.cwd : os.homedir()
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Ovseer', FORCE_COLOR: '1' } as Record<string, string>
  })
  const r: Running = { pty, startedAt: Date.now(), buffer: '', viewers: new Set() }
  running.set(id, r)
  exits.delete(id)
  lastLines.delete(id)
  pty.onData((data) => {
    r.buffer = (r.buffer + data).slice(-BUFFER_MAX)
    const line = tail(data)
    if (line) {
      lastLines.set(id, line)
      // a lista mostra a última linha, mas sem martelar a janela: no máximo a cada segundo
      scheduleBroadcast()
    }
    for (const v of r.viewers) if (!v.isDestroyed()) v.send('services:data', id, data)
  })
  pty.onExit(({ exitCode }) => {
    running.delete(id)
    exits.set(id, exitCode)
    const bye = `\r\n\x1b[2m[processo encerrado${exitCode === null ? '' : ` com código ${exitCode}`}]\x1b[0m\r\n`
    for (const v of r.viewers) if (!v.isDestroyed()) v.send('services:data', id, bye)
    broadcast()
  })
  broadcast()
}

let pending: ReturnType<typeof setTimeout> | undefined
function scheduleBroadcast() {
  if (pending) return
  pending = setTimeout(() => {
    pending = undefined
    broadcast()
  }, 1000)
}

/** Para o serviço: pede para encerrar e, se não sair em 3 s, mata. */
export function stopService(id: string): void {
  const r = running.get(id)
  if (!r) return
  try {
    r.pty.kill('SIGTERM')
  } catch {
    /* já encerrado */
  }
  setTimeout(() => {
    if (running.get(id) === r) {
      try {
        r.pty.kill('SIGKILL')
      } catch {
        /* já encerrado */
      }
    }
  }, 3000)
}

export function stopAllServices() {
  for (const id of [...running.keys()]) stopService(id)
}

// ---------- janela do terminal do serviço ----------

export function attachService(viewer: WebContents, id: string, cols: number, rows: number) {
  const r = running.get(id)
  if (r) {
    r.viewers.add(viewer)
    viewer.once('destroyed', () => r.viewers.delete(viewer))
    if (cols > 0 && rows > 0) r.pty.resize(cols, rows)
  }
  const st = serviceStates().find((s) => s.id === id) ?? null
  return { service: find(id) ?? null, state: st, buffer: r?.buffer ?? '' }
}

export function writeService(id: string, data: string) {
  running.get(id)?.pty.write(data)
}

export function resizeService(id: string, cols: number, rows: number) {
  const r = running.get(id)
  if (r && cols > 0 && rows > 0) r.pty.resize(cols, rows)
}

export function openServiceWindow(id: string) {
  const s = find(id)
  if (!s) throw new Error('Serviço não encontrado.')
  const existing = windows.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 900,
    height: 560,
    minWidth: 480,
    minHeight: 280,
    title: `${s.name} · Serviço`,
    icon: setup?.icon,
    show: false,
    backgroundColor: setup?.background() ?? '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  windows.set(id, win)
  win.once('ready-to-show', () => win.show())
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('closed', () => windows.delete(id))
  const load = () =>
    process.env.ELECTRON_RENDERER_URL
      ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/service.html?id=${encodeURIComponent(id)}`)
      : win.loadFile(path.join(__dirname, '../renderer/service.html'), { query: { id } })
  load().catch((e) => console.error('Janela do serviço não carregou:', e))
}
