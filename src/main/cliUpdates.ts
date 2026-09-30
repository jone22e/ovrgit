import os from 'node:os'
import type { CliProvider, CliUpdateInfo, CliUpdates } from '../shared/types'
import { findBinary, forgetBinary, runCli } from './cli'

/**
 * Versão instalada de cada CLI (claude, codex, agy) e a mais recente publicada.
 * - Claude e Codex: a versão `latest` do pacote no npm (a mesma que o instalador de cada um usa).
 * - Antigravity: a raiz do servidor de atualizações do próprio CLI responde "Stable Version: x.y.z".
 * Para atualizar, roda o comando `update` do próprio CLI. Para instalar, o instalador oficial de cada um (o mesmo
 * do site: executável próprio em ~/.local/bin, sem Node nem Homebrew).
 */

const CACHE_MS = 6 * 3600_000
let cache: { at: number; value: CliUpdates } | null = null

const LATEST: Record<CliProvider, () => Promise<string | null>> = {
  claude: () => npmLatest('@anthropic-ai/claude-code'),
  codex: () => npmLatest('@openai/codex'),
  agy: async () => {
    const r = await fetch('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app', { signal: AbortSignal.timeout(8000) })
    return r.ok ? version(await r.text()) : null
  }
}

async function npmLatest(pkg: string): Promise<string | null> {
  const r = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(8000) })
  return r.ok ? version(String(((await r.json()) as { version?: string }).version ?? '')) : null
}

/** Primeiro "x.y.z" do texto (ex.: "2.1.283 (Claude Code)", "codex-cli 0.158.0") */
const version = (s: string) => /\d+\.\d+\.\d+/.exec(s)?.[0] ?? null

/** a > b, comparando parte a parte */
function newer(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

async function installed(id: CliProvider): Promise<string | null> {
  const bin = await findBinary(id)
  if (!bin) return null
  try {
    const r = await runCli(bin, ['--version'], '', os.tmpdir(), 15_000)
    return version(r.stdout) ?? version(r.stderr)
  } catch {
    return null
  }
}

async function check(id: CliProvider): Promise<CliUpdateInfo | null> {
  const current = await installed(id)
  if (!current) return null // não instalado: nada a mostrar
  const latest = await LATEST[id]().catch(() => null)
  return { current, latest, available: !!latest && newer(latest, current) }
}

export async function getCliUpdates(force = false): Promise<CliUpdates> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const [claude, codex, agy] = await Promise.all((['claude', 'codex', 'agy'] as const).map(check))
  cache = { at: Date.now(), value: { claude, codex, agy } }
  return cache.value
}

/** Roda o `update` do próprio CLI e devolve a situação depois dele */
export async function updateCli(id: CliProvider): Promise<CliUpdateInfo | null> {
  const bin = await findBinary(id)
  if (!bin) throw new Error('CLI não encontrado.')
  const r = await runCli(bin, ['update'], '', os.tmpdir(), 5 * 60_000)
  const after = await check(id)
  if (cache) cache.value[id] = after
  if (r.code !== 0 && after?.available) {
    const msg = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).pop()
    throw new Error(msg || `A atualização terminou com código ${r.code}.`)
  }
  return after
}

/** Instaladores oficiais: script para macOS/Linux e para Windows (PowerShell) */
const INSTALLER: Record<CliProvider, { sh: string; ps1: string }> = {
  claude: { sh: 'https://claude.ai/install.sh', ps1: 'https://claude.ai/install.ps1' },
  codex: { sh: 'https://chatgpt.com/codex/install.sh', ps1: 'https://chatgpt.com/codex/install.ps1' },
  agy: { sh: 'https://antigravity.google/cli/install.sh', ps1: 'https://antigravity.google/cli/install.ps1' }
}

/** Instala o CLI pelo instalador oficial, sem perguntas, e devolve a situação depois dele */
export async function installCli(id: CliProvider): Promise<CliUpdateInfo | null> {
  const url = INSTALLER[id]
  const r =
    process.platform === 'win32'
      ? await runCli('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${url.ps1} | iex`], '', os.homedir(), 10 * 60_000, undefined, { CODEX_NON_INTERACTIVE: '1' })
      : await runCli('/bin/bash', ['-c', `curl -fsSL ${url.sh} | bash`], '', os.homedir(), 10 * 60_000, undefined, { CODEX_NON_INTERACTIVE: '1' })
  forgetBinary(id)
  const after = await check(id)
  if (cache) cache.value[id] = after
  if (!after) {
    const msg = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).pop()
    throw new Error(msg || `A instalação terminou com código ${r.code}.`)
  }
  return after
}
