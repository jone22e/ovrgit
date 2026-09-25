import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import type { AuthEvent, AuthStatus, CliProvider } from '../shared/types'
import { findBinary, needsShell, runCli } from './cli'

const BIN: Record<CliProvider, string> = { claude: 'claude', codex: 'codex' }

const COMMANDS: Record<CliProvider, { status: string[]; login: string[]; logout: string[] }> = {
  claude: {
    status: ['auth', 'status', '--json'],
    login: ['auth', 'login', '--claudeai'],
    logout: ['auth', 'logout']
  },
  codex: {
    status: ['login', 'status'],
    login: ['login'],
    logout: ['logout']
  }
}

export async function authStatus(provider: CliProvider): Promise<AuthStatus> {
  const bin = await findBinary(BIN[provider])
  if (!bin) return { installed: false, loggedIn: false }
  try {
    const r = await runCli(bin, COMMANDS[provider].status, '', os.tmpdir(), 15_000)
    const text = `${r.stdout}\n${r.stderr}`.trim()
    if (provider === 'claude') {
      const j = JSON.parse(r.stdout) as Record<string, unknown>
      const who = [j.email, j.subscriptionType ?? j.orgName].filter(Boolean).join(' · ')
      return { installed: true, loggedIn: j.loggedIn === true, detail: who || undefined }
    }
    // codex: "Logged in using ChatGPT" com código 0; "Not logged in" com código ≠ 0
    const loggedIn = r.code === 0 && !/not logged in/i.test(text)
    return { installed: true, loggedIn, detail: loggedIn ? text.split('\n')[0] : undefined }
  } catch (e) {
    return { installed: true, loggedIn: false, error: (e as Error).message }
  }
}

export async function logout(provider: CliProvider): Promise<AuthStatus> {
  const bin = await findBinary(BIN[provider])
  if (bin) await runCli(bin, COMMANDS[provider].logout, '', os.tmpdir(), 15_000).catch(() => undefined)
  return authStatus(provider)
}

let session: { child: ChildProcessWithoutNullStreams; poll: ReturnType<typeof setInterval> } | null = null

/**
 * Inicia o login do CLI. O próprio CLI abre o navegador; repassamos a URL (para "abrir de novo")
 * e aceitamos o código colado pelo usuário, caso a página mostre um.
 * O fim é detectado pela saída do processo ou consultando o status periodicamente.
 */
export async function startLogin(provider: CliProvider, emit: (e: AuthEvent) => void): Promise<void> {
  cancelLogin()
  const bin = await findBinary(BIN[provider])
  if (!bin) {
    emit({ type: 'done', ok: false, error: `${provider} não está instalado.` })
    return
  }
  const shell = needsShell(bin)
  const child = spawn(shell ? `"${bin}"` : bin, COMMANDS[provider].login, {
    cwd: os.tmpdir(),
    shell,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' }
  })
  let urlSent = false
  let finished = false
  let output = ''

  const finish = async (ok: boolean, error?: string) => {
    if (finished) return
    finished = true
    if (session?.child === child) {
      clearInterval(session.poll)
      session = null
    }
    terminate(child)
    const status = await authStatus(provider)
    emit({ type: 'done', ok: ok || status.loggedIn, error: status.loggedIn ? undefined : error, status })
  }

  const onData = (d: Buffer) => {
    const text = d.toString('utf8')
    output += text
    const url = /https:\/\/[^\s"'<>]+/.exec(output)?.[0]
    if (url && !urlSent) {
      urlSent = true
      emit({ type: 'url', url })
    }
    if (/code|código/i.test(text) && /paste|cole|enter|>\s*$/i.test(text)) emit({ type: 'needsCode' })
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.stdin.on('error', () => undefined)
  child.on('error', (e) => finish(false, e.message))
  child.on('close', (code) => {
    const tail = output.trim().split('\n').slice(-2).join(' ')
    finish(code === 0, code === 0 ? undefined : tail || `login saiu com código ${code}`)
  })

  const poll = setInterval(async () => {
    if ((await authStatus(provider)).loggedIn) finish(true)
  }, 3000)
  session = { child, poll }
}

export function sendCode(code: string) {
  const clean = code.trim()
  if (session && clean) session.child.stdin.write(`${clean}\n`)
}

export function cancelLogin() {
  if (!session) return
  clearInterval(session.poll)
  terminate(session.child)
  session = null
}

function terminate(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return
  child.kill()
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 2000).unref()
}
