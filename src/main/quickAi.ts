import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentEffort, CliProvider } from '../shared/types'
import { findBinary, needsShell } from './cli'
import { knownModels } from './agentWatch'

/**
 * Pergunta rápida a uma IA, sem sessão. Por padrão usa o modelo mais leve e nenhuma ferramenta; o agente raiz
 * pode escolher um modelo e ler um projeto em modo somente leitura para responder com evidência.
 */
const BIN: Record<CliProvider, string> = { claude: 'claude', codex: 'codex', agy: 'agy' }

export async function quickAsk(provider: CliProvider, prompt: string, timeoutMs = 20_000, selected?: { model?: string; effort?: AgentEffort; cwd?: string; extraDirs?: string[] }): Promise<string> {
  const bin = await findBinary(BIN[provider])
  if (!bin) throw new Error(`${provider} não encontrado.`)
  const model = selected?.model && /^[\w.:/-]+$/.test(selected.model) ? selected.model : undefined
  const effort = selected?.effort
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-quick-'))
  try {
    const project = selected?.cwd && existsSync(selected.cwd) ? selected.cwd : undefined
    const extraDirs = (selected?.extraDirs ?? []).filter((entry) => entry !== project && existsSync(entry))
    let args: string[]
    let outFile: string | null = null
    if (provider === 'claude') {
      args = ['-p', '--output-format', 'json', '--tools', project ? 'Read,Glob,Grep' : '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--effort', effort ?? 'low']
      if (model || !selected) args.push('--model', model ?? 'haiku')
      if (project) for (const entry of extraDirs) args.push('--add-dir', entry)
    } else if (provider === 'codex') {
      outFile = path.join(dir, 'out.txt')
      args = ['exec', '--ephemeral', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', `model_reasoning_effort="${effort ?? 'low'}"`, '--output-last-message', outFile]
      const chosen = model ?? (!selected ? knownModels().codexCatalog.find((m) => /mini/i.test(m.id))?.id : undefined)
      if (chosen) args.push('-m', chosen)
      args.push('-')
    } else {
      const agyEffort = effort === 'xhigh' || effort === 'ultra' ? 'max' : effort === 'minimal' ? 'low' : effort ?? 'low'
      args = ['--output-format', 'json', '--effort', agyEffort, '--mode', 'plan', `--print=${prompt}`]
      if (model) args.push('--model', model)
      if (project) for (const entry of extraDirs) args.push('--add-dir', entry)
    }
    const shellMode = needsShell(bin)
    const child = spawn(shellMode ? `"${bin}"` : bin, args, { cwd: project ?? dir, shell: shellMode, windowsHide: true, env: { ...process.env, NO_COLOR: '1', ...(!selected ? { MAX_THINKING_TOKENS: '0' } : {}) } })
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
