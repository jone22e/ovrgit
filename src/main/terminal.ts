import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from '@lydell/node-pty'
import type { WebContents } from 'electron'
import type { SshConnection } from '../shared/types'

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

/** ssh do sistema (OpenSSH): /usr/bin/ssh no Mac/Linux, System32\OpenSSH no Windows 10+. */
function sshBinary(): string {
  // testes automatizados podem apontar para um ssh isolado (sem tocar no ~/.ssh do usuário)
  if (process.env.OVRGIT_SSH_BIN && existsSync(process.env.OVRGIT_SSH_BIN)) return process.env.OVRGIT_SSH_BIN
  if (process.platform === 'win32') {
    const p = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    return existsSync(p) ? p : 'ssh.exe'
  }
  return existsSync('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh'
}

const SAFE_HOST = /^[A-Za-z0-9._:\[\]-]+$/
const SAFE_USER = /^[A-Za-z0-9._@-]+$/

/** Argumentos do ssh a partir da conexão salva, validando cada campo (nada começa com "-"). */
export function sshArgs(c: SshConnection): string[] {
  if (!SAFE_HOST.test(c.host) || c.host.startsWith('-')) throw new Error(`Host inválido: ${c.host}`)
  if (c.user && (!SAFE_USER.test(c.user) || c.user.startsWith('-'))) throw new Error(`Usuário inválido: ${c.user}`)
  const port = Number(c.port) || 22
  if (port < 1 || port > 65535) throw new Error(`Porta inválida: ${c.port}`)
  const args = ['-p', String(port), '-o', 'ServerAliveInterval=30']
  if (c.identityFile) {
    if (!existsSync(c.identityFile)) throw new Error(`Chave não encontrada: ${c.identityFile}`)
    args.push('-i', c.identityFile)
  }
  const dir = (c.remoteDir ?? '').trim()
  // -t (terminal interativo) precisa vir antes do destino; depois dele tudo vira comando remoto
  if (dir) args.push('-t')
  args.push(c.user ? `${c.user}@${c.host}` : c.host)
  if (dir) {
    // entra na pasta e abre o shell de login; aspas simples escapadas para o shell remoto
    args.push(`cd '${dir.replace(/'/g, `'\\''`)}' && exec "$SHELL" -l`)
  }
  return args
}

export async function createTerminal(
  owner: WebContents,
  cwd: string,
  cols: number,
  rows: number,
  ssh?: SshConnection
): Promise<number> {
  // carregado sob demanda: o módulo nativo só é necessário quando o terminal é aberto
  const { spawn } = await import('@lydell/node-pty')
  const { file, args } = ssh ? { file: sshBinary(), args: sshArgs(ssh) } : defaultShell()
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

/**
 * Chaves privadas em ~/.ssh. Lê só o começo de cada arquivo para reconhecer o cabeçalho
 * "-----BEGIN ... PRIVATE KEY-----"; o conteúdo da chave nunca sai daqui (só o caminho).
 */
export function listSshKeys(): string[] {
  const dir = path.join(os.homedir(), '.ssh')
  const skip = /^(known_hosts|authorized_keys|config|environment)(\..*)?$|\.pub$/
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const keys: string[] = []
  for (const name of names) {
    if (skip.test(name)) continue
    const file = path.join(dir, name)
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size > 64 * 1024) continue
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(64)
      const n = readSync(fd, buf, 0, 64, 0)
      closeSync(fd)
      if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(buf.subarray(0, n).toString('utf8'))) keys.push(file)
    } catch {
      /* sem permissão ou arquivo sumiu: ignora */
    }
  }
  return keys.sort()
}
