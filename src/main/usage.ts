import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderUsage, UsageInfo } from '../shared/types'
import { codexUsage } from './agentWatch'
import { agyStatus } from './auth'

/**
 * Consumo das assinaturas. Nada é enviado além do que os próprios CLIs já usam:
 * - Claude: o mesmo endpoint de uso da conta que o Claude Code consulta, com o login já feito
 *   (token no Keychain do macOS ou em ~/.claude/.credentials.json). O token nunca sai daqui.
 * - Codex: percentuais que o próprio CLI grava nos registros das sessões (ver agentWatch).
 */

const CACHE_MS = 5 * 60_000
let claudeCache: { at: number; value: ProviderUsage | null } | null = null

interface ClaudeLogin {
  token: string
  /** Ex.: "max", "pro", "team" */
  plan?: string
  /** Ex.: "default_claude_max_20x" → "20x" */
  tier?: string
}

/** Login do Claude Code: Keychain no Mac; arquivo de credenciais nos demais sistemas. Só o token e o plano são lidos. */
async function claudeToken(): Promise<ClaudeLogin | null> {
  const parse = (json: string): ClaudeLogin | null => {
    try {
      const d = JSON.parse(json) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string; rateLimitTier?: string } }
      const o = d.claudeAiOauth
      if (!o?.accessToken) return null
      const tier = /_(\d+x)$/.exec(o.rateLimitTier ?? '')?.[1]
      return { token: o.accessToken, plan: o.subscriptionType || undefined, tier }
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    const fromKeychain = await new Promise<ClaudeLogin | null>((resolve) => {
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? null : parse(String(stdout).trim()))
      )
    })
    if (fromKeychain) return fromKeychain
  }
  try {
    return parse(readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

interface ClaudeWindow {
  utilization?: number | null
  resets_at?: string | null
}

async function claudeUsage(): Promise<ProviderUsage | null> {
  const login = await claudeToken()
  if (!login) return null
  const plan = login.plan ? `${login.plan}${login.tier ? ` ${login.tier}` : ''}` : undefined
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: ctrl.signal
    })
    if (res.status === 401 || res.status === 403) return { fiveHour: null, week: null, plan, at: Date.now(), error: 'Login do Claude expirado: rode "claude" no terminal para renovar.' }
    if (!res.ok) return { fiveHour: null, week: null, plan, at: Date.now(), error: `Claude respondeu ${res.status}` }
    const d = (await res.json()) as { five_hour?: ClaudeWindow | null; seven_day?: ClaudeWindow | null }
    const win = (w: ClaudeWindow | null | undefined) =>
      w && typeof w.utilization === 'number'
        ? { pct: Math.max(0, Math.min(100, w.utilization)), resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null }
        : null
    return { fiveHour: win(d.five_hour), week: win(d.seven_day), plan, at: Date.now() }
  } catch (e) {
    return { fiveHour: null, week: null, plan, at: Date.now(), error: (e as Error).name === 'AbortError' ? 'Sem resposta do Claude.' : (e as Error).message }
  } finally {
    clearTimeout(t)
  }
}

export async function getUsage(force = false): Promise<UsageInfo> {
  if (force || !claudeCache || Date.now() - claudeCache.at > CACHE_MS) {
    claudeCache = { at: Date.now(), value: await claudeUsage() }
  }
  return { claude: claudeCache.value, codex: codexUsage(), agy: await agyUsage() }
}

/** Antigravity: o CLI não grava nem expõe os limites; mostramos a conta conectada. */
async function agyUsage(): Promise<ProviderUsage | null> {
  const st = await agyStatus()
  if (!st.installed) return null
  return { fiveHour: null, week: null, plan: st.loggedIn ? st.detail : undefined, at: Date.now(), error: st.loggedIn ? undefined : 'Não conectado: rode "agy" no terminal.' }
}
