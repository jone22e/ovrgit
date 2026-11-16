import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderUsage, UsageInfo } from '../shared/types'
import { codexUsage } from './agentWatch'
import { agyStatus } from './auth'
import { findBinary, needsShell, runCli } from './cli'

/**
 * Consumo das assinaturas. Nada é enviado além do que os próprios CLIs já usam:
 * - Claude: o mesmo endpoint de uso da conta que o Claude Code consulta, com o login já feito
 *   (token no Keychain do macOS ou em ~/.claude/.credentials.json). O token nunca sai daqui.
 *   O token de acesso dura poucas horas e só o CLI o renova; quando vence, pedimos ao CLI que renove.
 * - Codex: consulta de limites do app-server do CLI; registros das sessões são a reserva se ela falhar.
 * - Antigravity: `agy -p /usage --output-format json`, que não roda o agente nem gasta cota; a conta
 *   conectada vem do token local (ver auth).
 */

const CACHE_MS = 5 * 60_000
let claudeCache: { at: number; value: ProviderUsage | null } | null = null
let codexCache: { at: number; value: ProviderUsage | null } | null = null
let agyCache: { at: number; value: ProviderUsage | null } | null = null

interface CodexRateWindow {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

interface CodexRateSnapshot {
  primary?: CodexRateWindow | null
  secondary?: CodexRateWindow | null
  planType?: string | null
}

/** Resposta de account/rateLimits/read: o limite `codex` é o mesmo exibido no plano do ChatGPT. */
export function parseCodexRateLimits(result: unknown, at: number): ProviderUsage | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { rateLimits?: CodexRateSnapshot; rateLimitsByLimitId?: Record<string, CodexRateSnapshot> | null }
  const snapshot = r.rateLimitsByLimitId?.codex ?? r.rateLimits
  if (!snapshot) return null
  const wins = [snapshot.primary, snapshot.secondary].filter((w): w is CodexRateWindow => !!w && typeof w.usedPercent === 'number')
  const pick = (test: (minutes: number) => boolean) => {
    const w = wins.find((x) => test(x.windowDurationMins ?? 0))
    return w ? { pct: Math.max(0, Math.min(100, w.usedPercent!)), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null } : null
  }
  const fiveHour = pick((m) => m > 0 && m <= 600)
  const week = pick((m) => m >= 7 * 24 * 60 - 60)
  return fiveHour || week ? { fiveHour, week, plan: snapshot.planType ?? undefined, at } : null
}

/** Faz só a leitura de limites; não inicia conversa nem consome tokens. */
async function liveCodexUsage(): Promise<ProviderUsage | null> {
  const bin = await findBinary('codex')
  if (!bin) return null
  return new Promise((resolve, reject) => {
    const shell = needsShell(bin)
    const child = spawn(shell ? `"${bin}"` : bin, ['app-server', '--stdio'], { shell, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let done = false
    let buffer = ''
    const finish = (value: ProviderUsage | null, error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(null, new Error('Consulta do Codex demorou demais.')), 10_000)
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: { id?: number; result?: unknown; error?: unknown }
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
        } else if (message.id === 1 && message.error) {
          finish(null, new Error('Falha ao iniciar consulta de limites do Codex.'))
        } else if (message.id === 2) {
          if (message.error) finish(null, new Error('Falha ao consultar limites do Codex.'))
          else finish(parseCodexRateLimits(message.result, Date.now()))
        }
      }
    })
    child.on('error', (error) => finish(null, error))
    child.on('close', () => finish(null, new Error('Codex encerrou antes de responder.')))
    child.stdin.on('error', () => undefined)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'ovseer', version: '1' } } })
  })
}

interface ClaudeLogin {
  token: string
  /** Ex.: "max", "pro", "team" */
  plan?: string
  /** Ex.: "default_claude_max_20x" → "20x" */
  tier?: string
  /** Validade do token de acesso (ms) */
  expiresAt?: number
}

/** Login do Claude Code: Keychain no Mac; arquivo de credenciais nos demais sistemas. Só o token e o plano são lidos. */
async function claudeToken(): Promise<ClaudeLogin | null> {
  const parse = (json: string): ClaudeLogin | null => {
    try {
      const d = JSON.parse(json) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string } }
      const o = d.claudeAiOauth
      if (!o?.accessToken) return null
      const tier = /_(\d+x)$/.exec(o.rateLimitTier ?? '')?.[1]
      return { token: o.accessToken, plan: o.subscriptionType || undefined, tier, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined }
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

const RENEW_EVERY_MS = 60_000
let renewing: Promise<void> | null = null
let renewedAt = 0

/**
 * Faz o CLI renovar o token de acesso. `mcp list` é o comando mais barato que passa pela renovação
 * (`auth status` não renova) e não gasta inferência. Roda na pasta temporária para não subir os MCPs de um projeto.
 */
function renewClaudeToken(): Promise<void> {
  if (renewing) return renewing
  if (Date.now() - renewedAt < RENEW_EVERY_MS) return Promise.resolve()
  renewing = (async () => {
    try {
      const bin = await findBinary('claude')
      if (bin) await runCli(bin, ['mcp', 'list'], '', os.tmpdir(), 45_000)
    } catch {
      /* sem renovação: a consulta seguinte mostra o erro */
    } finally {
      renewedAt = Date.now()
      renewing = null
    }
  })()
  return renewing
}

const expired = (login: ClaudeLogin) => login.expiresAt !== undefined && login.expiresAt - Date.now() < 60_000

/** Nome do plano mostrado pelo perfil da conta; o tier do token é só o fallback técnico. */
export function claudePlanLabel(profileJson: string | null, subscriptionType?: string, tier?: string): string | undefined {
  try {
    const profile = JSON.parse(profileJson ?? '') as { oauthAccount?: { planDisplayName?: unknown } }
    const name = profile.oauthAccount?.planDisplayName
    if (typeof name === 'string' && name.trim()) return name.trim()
  } catch {
    /* perfil indisponível: usa o tipo da assinatura no token */
  }
  return subscriptionType ? `${subscriptionType}${tier ? ` ${tier}` : ''}` : undefined
}

function claudePlan(login: ClaudeLogin): string | undefined {
  let profileJson: string | null = null
  try {
    profileJson = readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')
  } catch {
    /* Claude Code pode ainda não ter salvo o perfil */
  }
  return claudePlanLabel(profileJson, login.plan, login.tier)
}

async function claudeUsage(): Promise<ProviderUsage | null> {
  let login = await claudeToken()
  if (!login) return null
  let renewed = false
  if (expired(login)) {
    await renewClaudeToken()
    renewed = true
    login = (await claudeToken()) ?? login
  }
  let usage = await fetchClaudeUsage(login)
  if (usage === 'unauthorized' && !renewed) {
    await renewClaudeToken()
    login = (await claudeToken()) ?? login
    usage = await fetchClaudeUsage(login)
  }
  if (usage !== 'unauthorized') return usage
  const plan = claudePlan(login)
  return { fiveHour: null, week: null, plan, at: Date.now(), error: 'Login do Claude expirado: rode "claude" no terminal para renovar.' }
}

async function fetchClaudeUsage(login: ClaudeLogin): Promise<ProviderUsage | 'unauthorized'> {
  const plan = claudePlan(login)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: ctrl.signal
    })
    if (res.status === 401 || res.status === 403) return 'unauthorized'
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
  const stale = (c: typeof claudeCache) => force || !c || Date.now() - c.at > CACHE_MS
  const [claude, codex, agy] = await Promise.all([
    stale(claudeCache) ? claudeUsage().then((value) => (claudeCache = { at: Date.now(), value }).value) : claudeCache!.value,
    stale(codexCache) ? liveCodexUsage().catch(() => null).then((value) => (codexCache = { at: Date.now(), value }).value) : codexCache!.value,
    stale(agyCache) ? agyUsage().then((value) => (agyCache = { at: Date.now(), value }).value) : agyCache!.value
  ])
  return { claude, codex: codex ?? codexUsage(), agy }
}

interface AgyBucket {
  window?: string
  remaining_fraction?: number | null
  reset_time?: string | null
}

/**
 * Saída de `agy -p /usage --output-format json`: a cota é separada por grupo de modelos (Gemini, Claude e GPT...),
 * cada um com janela semanal e de 5 horas. Para cada janela fica o grupo mais gasto. Nulo se não for essa saída.
 */
export function parseAgyUsage(body: string): Pick<ProviderUsage, 'fiveHour' | 'week'> | null {
  let groups: { buckets?: AgyBucket[] }[]
  try {
    const d = JSON.parse(body.trim()) as { command?: { data?: { groups?: { buckets?: AgyBucket[] }[] } } }
    if (!Array.isArray(d.command?.data?.groups)) return null
    groups = d.command.data.groups
  } catch {
    return null
  }
  const out: Pick<ProviderUsage, 'fiveHour' | 'week'> = { fiveHour: null, week: null }
  for (const b of groups.flatMap((g) => g.buckets ?? [])) {
    if (typeof b.remaining_fraction !== 'number') continue
    const key = b.window === '5h' ? 'fiveHour' : b.window === 'weekly' ? 'week' : null
    if (!key) continue
    const pct = Math.max(0, Math.min(100, (1 - b.remaining_fraction) * 100))
    if (!out[key] || pct > out[key].pct) out[key] = { pct, resetsAt: b.reset_time ? Date.parse(b.reset_time) || null : null }
  }
  return out
}

/** Antigravity: conta conectada (token local) e limites do `/usage` do próprio CLI. */
async function agyUsage(): Promise<ProviderUsage | null> {
  const st = await agyStatus()
  if (!st.installed) return null
  if (!st.loggedIn) return { fiveHour: null, week: null, at: Date.now(), error: 'Não conectado: rode "agy" no terminal.' }
  const bin = await findBinary('agy')
  if (!bin) return null
  try {
    const r = await runCli(bin, ['-p', '/usage', '--output-format', 'json'], '', os.tmpdir(), 30_000)
    const parsed = parseAgyUsage(r.stdout)
    if (!parsed) return { fiveHour: null, week: null, plan: st.detail, at: Date.now(), error: 'Resposta do agy fora do formato esperado.' }
    return { ...parsed, plan: st.detail, at: Date.now() }
  } catch (e) {
    return { fiveHour: null, week: null, plan: st.detail, at: Date.now(), error: (e as Error).message }
  }
}
