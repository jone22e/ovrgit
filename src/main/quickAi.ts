import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CliProvider } from '../shared/types'
import { findBinary, needsShell } from './cli'
import { knownModels } from './agentWatch'

/**
 * Pergunta rápida a uma IA, sem ferramentas, sem sessão, no modelo mais leve disponível (Haiku, o "mini" do
 * catálogo do Codex, o Antigravity em esforço baixo). Serve para decisões pequenas, como escolher um agente.
 */
const BIN: Record<CliProvider, string> = { claude: 'claude', codex: 'codex', agy: 'agy' }

export async function quickAsk(provider: CliProvider, prompt: string, timeoutMs = 20_000): Promise<string> {
  const bin = await findBinary(BIN[provider])
  if (!bin) throw new Error(`${provider} não encontrado.`)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-quick-'))
  try {
    let args: string[]
    let outFile: string | null = null
    if (provider === 'claude') {
      args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--model', 'haiku', '--effort', 'low']
    } else if (provider === 'codex') {
      outFile = path.join(dir, 'out.txt')
      const mini = knownModels().codexCatalog.find((m) => /mini/i.test(m.id))?.id
      args = ['exec', '--ephemeral', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort="low"', '--output-last-message', outFile]
      if (mini) args.push('-m', mini)
      args.push('-')
    } else {
      args = ['--output-format', 'json', '--effort', 'low', '--mode', 'plan', `--print=${prompt}`]
    }
    const shellMode = needsShell(bin)
    const child = spawn(shellMode ? `"${bin}"` : bin, args, { cwd: dir, shell: shellMode, windowsHide: true, env: { ...process.env, NO_COLOR: '1', MAX_THINKING_TOKENS: '0' } })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => undefined)
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    await new Promise<void>((resolve) => {
      child.on('error', () => resolve())
      child.on('close', () => resolve())
      if (provider === 'agy') child.stdin.end()
      else child.stdin.end(prompt)
    })
    clearTimeout(timer)
    if (provider === 'claude') {
      const env = JSON.parse(stdout) as { is_error?: boolean; result?: string }
      if (env.is_error) throw new Error(String(env.result ?? 'erro'))
      return String(env.result ?? '')
    }
    if (provider === 'codex') return await readFile(outFile!, 'utf8')
    try {
      const env = JSON.parse(stdout) as { response?: string; result?: { response?: string } }
      return String(env.response ?? env.result?.response ?? stdout)
    } catch {
      return stdout
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
