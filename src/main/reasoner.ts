import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CliProvider } from '../shared/types'
import { findBinary, runCli } from './cli'
import { agentBase } from './agentChat'

/**
 * O agente de raciocínio da fila: uma chamada só de leitura ao CLI do provedor padrão (o do último agente aberto),
 * na pasta da tarefa, que devolve uma análise curta. Não altera nada: o Claude só com Read, Glob e Grep; o Codex em
 * sandbox só leitura; o Antigravity em modo plano. Sem sessão e sem aparecer no gerenciador.
 */
const BIN: Record<CliProvider, string> = { claude: 'claude', codex: 'codex', agy: 'agy' }

export async function reasonAbout(o: { cwd?: string; prompt: string; timeoutMs?: number }): Promise<string> {
  const last = agentBase()
  const provider: CliProvider = last?.provider ?? 'claude'
  const model = last?.provider === provider ? last?.model ?? '' : ''
  const bin = await findBinary(BIN[provider])
  if (!bin) throw new Error(`${provider} não encontrado.`)
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : os.homedir()
  const timeout = o.timeoutMs ?? 4 * 60_000
  if (provider === 'claude') {
    const args = ['-p', '--output-format', 'json', '--tools', 'Read,Glob,Grep', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--effort', 'medium']
    if (model) args.push('--model', model)
    const r = await runCli(bin, args, o.prompt, cwd, timeout)
    const env = JSON.parse(r.stdout) as { is_error?: boolean; result?: string }
    if (env.is_error) throw new Error(String(env.result ?? 'erro'))
    return String(env.result ?? '')
  }
  if (provider === 'codex') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-reason-'))
    try {
      const out = path.join(dir, 'out.txt')
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort="medium"', '--output-last-message', out]
      if (model) args.push('-m', model)
      args.push('-')
      await runCli(bin, args, o.prompt, cwd, timeout)
      return await readFile(out, 'utf8').catch(() => '')
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  const r = await runCli(bin, ['--output-format', 'json', '--effort', 'medium', '--mode', 'plan', `--print=${o.prompt}`], '', cwd, timeout)
  try {
    const env = JSON.parse(r.stdout) as { response?: string; result?: { response?: string } }
    return String(env.response ?? env.result?.response ?? r.stdout)
  } catch {
    return r.stdout
  }
}
