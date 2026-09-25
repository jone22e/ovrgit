import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from '@lydell/node-pty'
import type { WebContents } from 'electron'

interface Session {
  pty: IPty
  owner: WebContents
}

const sessions = new Map<number, Session>()
let nextId = 1

/** Shell padrão do sistema: zsh/bash no Mac/Linux, PowerShell no Windows. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    if (existsSync(pwsh)) return { file: pwsh, args: ['-NoLogo'] }
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  // shell de login: carrega o PATH do usuário (brew, nvm, etc.), já que apps abertos pelo Finder não herdam
  return { file: shell, args: ['-l'] }
}

export async function createTerminal(owner: WebContents, cwd: string, cols: number, rows: number): Promise<number> {
  // carregado sob demanda: o módulo nativo só é necessário quando o terminal é aberto
  const { spawn } = await import('@lydell/node-pty')
  const { file, args } = defaultShell()
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(cols, 20),
    rows: Math.max(rows, 5),
    cwd: existsSync(cwd) ? cwd : os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'OvrGit' } as Record<string, string>
  })
  const id = nextId++
  sessions.set(id, { pty, owner })
  pty.onData((data) => {
    if (!owner.isDestroyed()) owner.send('term:data', id, data)
  })
  pty.onExit(({ exitCode }) => {
    sessions.delete(id)
    if (!owner.isDestroyed()) owner.send('term:exit', id, exitCode)
  })
  owner.once('destroyed', () => killTerminal(id))
  return id
}

export function writeTerminal(id: number, data: string) {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: number, cols: number, rows: number) {
  const s = sessions.get(id)
  if (s && cols > 0 && rows > 0) s.pty.resize(cols, rows)
}

export function killTerminal(id: number) {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.pty.kill()
  } catch {
    /* já encerrado */
  }
}

export function killAllTerminals() {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
