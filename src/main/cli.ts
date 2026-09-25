import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isWin = process.platform === 'win32'
const cache = new Map<string, string | null>()

/**
 * Localiza um CLI (claude, codex). Apps abertos pelo Finder/Explorer não herdam o PATH do terminal,
 * então procuramos nos lugares de instalação comuns e, por último, perguntamos ao shell de login.
 */
export async function findBinary(name: string): Promise<string | null> {
  if (cache.has(name)) return cache.get(name)!
  const home = os.homedir()
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = isWin
    ? [
        path.join(home, '.local', 'bin'),
        path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
        path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', name),
        path.join(home, '.bun', 'bin')
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'local'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.volta', 'bin')
      ]
  let found: string | null = null
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e)
      if (existsSync(p)) {
        found = p
        break
      }
    }
    if (found) break
  }
  if (!found) found = await askShell(name)
  cache.set(name, found)
  return found
}

function askShell(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const [cmd, args] = isWin
      ? ['where', [name]]
      : [process.env.SHELL || '/bin/zsh', ['-ilc', `command -v ${name}`]]
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const line = String(stdout)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && (path.isAbsolute(s) || /^[a-z]:\\/i.test(s)))
      resolve(err || !line ? null : line)
    })
  })
}

/** No Windows, .cmd/.bat só rodam via shell; nesse caso não passamos argumentos com aspas/JSON. */
export const needsShell = (bin: string) => isWin && /\.(cmd|bat)$/i.test(bin)

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

export function runCli(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELADO'))
    const shell = needsShell(bin)
    const child = spawn(shell ? `"${bin}"` : bin, shell ? args.map(quoteCmd) : args, {
      cwd,
      shell,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' }
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('A IA demorou demais para responder.'))
    }, timeoutMs)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      child.kill()
      reject(new Error('CANCELADO'))
    })
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

function quoteCmd(arg: string): string {
  return /^[\w.:/\\=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}
