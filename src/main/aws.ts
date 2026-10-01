import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, Notification } from 'electron'
import type { AwsInstallProgress, AwsStatus } from '../shared/types'
import { findBinary, forgetBinary, runCli } from './cli'
import { getSettings } from './settings'

/**
 * AWS no Ovseer: instala o AWS CLI (e o plugin do Session Manager), entra com `aws sso login` (abre o navegador),
 * acompanha a sessão e avisa quando ela cai. As credenciais ficam onde o AWS CLI guarda (~/.aws); o app só
 * consulta e nunca copia.
 */

const awsDir = () => path.join(os.homedir(), '.aws')
const CHECK_MS = 5 * 60 * 1000
/** Avisa quando faltar este tempo para a sessão expirar */
const SOON_MS = 15 * 60 * 1000

let notify: (s: AwsStatus) => void = () => undefined
let timer: ReturnType<typeof setInterval> | undefined
let last: AwsStatus | null = null
let warnedSoon = false

export function setupAws(onChange: (s: AwsStatus) => void) {
  notify = onChange
  timer = setInterval(() => void watch(), CHECK_MS)
  if (getSettings().awsWatch && getSettings().awsProfile) setTimeout(() => void watch(), 15_000)
}

export function stopAws() {
  clearInterval(timer)
}

// ---------- instalação ----------

async function version(bin: string): Promise<string | null> {
  try {
    const r = await runCli(bin, ['--version'], '', os.tmpdir(), 15_000)
    return /aws-cli\/(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr)?.[1] ?? null
  } catch {
    return null
  }
}

/** Perfis do ~/.aws/config ("[default]", "[profile x]") e do ~/.aws/credentials */
export function awsProfiles(): string[] {
  const out = new Set<string>()
  for (const [file, re] of [
    ['config', /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]/gm],
    ['credentials', /^\[\s*([^\]]+?)\s*\]/gm]
  ] as const) {
    const p = path.join(awsDir(), file)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const m of text.matchAll(re)) if (!/^sso-session\s/.test(m[1])) out.add(m[1])
  }
  return [...out].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
}

/**
 * Como o perfil entra: `sso` (sso_start_url/sso_session → `aws sso login`), `login` (login_session → `aws login`,
 * credenciais do console) ou `static` (chaves fixas: "Entrar" não se aplica).
 */
function authKind(profile: string): 'sso' | 'login' | 'static' {
  const p = path.join(awsDir(), 'config')
  if (!existsSync(p)) return 'static'
  const text = readFileSync(p, 'utf8')
  const head = profile === 'default' ? /^\[\s*default\s*\]/m : new RegExp(`^\\[\\s*profile\\s+${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'm')
  const start = text.search(head)
  if (start < 0) return 'static'
  const body = text.slice(start).split(/\n\[/)[0]
  if (/^\s*sso_(start_url|session)\s*=/m.test(body)) return 'sso'
  if (/^\s*login_session\s*=/m.test(body)) return 'login'
  // perfil que assume papel a partir de outro: herda o jeito de entrar do perfil de origem
  const src = /^\s*source_profile\s*=\s*(\S+)/m.exec(body)?.[1]
  return src && src !== profile ? authKind(src) : 'static'
}

/** Quando o token do SSO expira: o mais tardio dos tokens válidos em ~/.aws/sso/cache */
function ssoExpiry(): number | null {
  const dir = path.join(awsDir(), 'sso', 'cache')
  if (!existsSync(dir)) return null
  let best: number | null = null
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { expiresAt?: string; accessToken?: string }
      if (!j.accessToken || !j.expiresAt) continue
      const t = Date.parse(j.expiresAt)
      if (Number.isFinite(t) && (best === null || t > best)) best = t
    } catch {
      /* cache corrompido: ignora */
    }
  }
  return best
}

export async function awsStatus(): Promise<AwsStatus> {
  const bin = await findBinary('aws')
  const ssm = !!(await findBinary('session-manager-plugin'))
  const profiles = awsProfiles()
  const profile = getSettings().awsProfile || (profiles.includes('default') ? 'default' : (profiles[0] ?? ''))
  const status: AwsStatus = {
    installed: bin ? await version(bin) : null,
    sessionManager: ssm,
    profiles,
    profile,
    auth: profile ? authKind(profile) : 'static',
    session: null,
    checkedAt: Date.now()
  }
  if (bin && profile) {
    try {
      const r = await runCli(bin, ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], '', os.tmpdir(), 20_000, undefined, { AWS_PAGER: '' })
      if (r.code === 0) {
        const j = JSON.parse(r.stdout) as { Account?: string; Arn?: string }
        status.session = { ok: true, account: j.Account ?? '', arn: j.Arn ?? '', expiresAt: status.auth === 'sso' ? ssoExpiry() : null }
      } else {
        status.session = { ok: false, error: friendly(r.stderr) }
      }
    } catch (e) {
      status.session = { ok: false, error: friendly(String((e as Error)?.message ?? e)) }
    }
  }
  last = status
  return status
}

function friendly(err: string): string {
  const t = err.trim()
  if (/token.*(expired|refresh)|sso.*(login|session)|Error loading SSO Token/i.test(t)) return 'Sessão expirada. Entre de novo.'
  if (/could not be found|Unable to locate credentials|config profile .* could not be found/i.test(t)) return 'Perfil sem credenciais. Entre na AWS ou configure o perfil.'
  if (/InvalidClientTokenId|SignatureDoesNotMatch|security token.*invalid/i.test(t)) return 'Credenciais inválidas.'
  if (/Could not connect|EndpointConnectionError|getaddrinfo|ENOTFOUND/i.test(t)) return 'Sem conexão com a AWS.'
  return t.split('\n').find((l) => l.trim())?.slice(0, 160) ?? 'Falha ao consultar a sessão.'
}

/** Baixa um arquivo para uma pasta temporária e devolve o caminho */
async function download(url: string, name: string, onProgress: (p: AwsInstallProgress) => void, step: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Não deu para baixar ${name} (${res.status}).`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-aws-'))
  const file = path.join(dir, name)
  const chunks: Uint8Array[] = []
  let got = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress({ step, percent: total ? Math.round((got / total) * 100) : null })
  }
  await writeFile(file, Buffer.concat(chunks))
  return file
}

/**
 * Instala o AWS CLI v2 e o plugin do Session Manager com os instaladores oficiais. No macOS os .pkg pedem
 * administrador: o pedido de senha é o do próprio sistema (osascript), nunca passa pelo app. No Windows, o MSI
 * (UAC). No Linux, não há instalador silencioso: devolve o comando para rodar no terminal.
 */
export async function awsInstall(onProgress: (p: AwsInstallProgress) => void): Promise<void> {
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'mac_arm64' : 'mac_64bit'
    const cli = await download('https://awscli.amazonaws.com/AWSCLIV2.pkg', 'AWSCLIV2.pkg', onProgress, 'Baixando o AWS CLI')
    const ssm = await download(`https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${arch}/session-manager-plugin.pkg`, 'session-manager-plugin.pkg', onProgress, 'Baixando o Session Manager')
    onProgress({ step: 'Instalando (o sistema vai pedir sua senha)', percent: null })
    const script = [
      `installer -pkg '${cli}' -target /`,
      `installer -pkg '${ssm}' -target /`,
      `ln -sf /usr/local/sessionmanagerplugin/bin/session-manager-plugin /usr/local/bin/session-manager-plugin`
    ].join(' && ')
    await admin(script)
  } else if (process.platform === 'win32') {
    const cli = await download('https://awscli.amazonaws.com/AWSCLIV2.msi', 'AWSCLIV2.msi', onProgress, 'Baixando o AWS CLI')
    const ssm = await download('https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPluginSetup.exe', 'SessionManagerPluginSetup.exe', onProgress, 'Baixando o Session Manager')
    onProgress({ step: 'Instalando (o Windows vai pedir permissão)', percent: null })
    await exec('msiexec', ['/i', cli, '/passive', '/norestart'])
    await exec(ssm, ['/quiet'])
  } else {
    throw new Error('No Linux, instale pelo terminal: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html')
  }
  forgetBinary('aws')
  forgetBinary('session-manager-plugin')
  onProgress({ step: 'Pronto', percent: 100 })
}

/** Roda um script como administrador no macOS, com o diálogo de senha do próprio sistema */
function admin(script: string): Promise<void> {
  const osa = `do shell script ${JSON.stringify(script)} with administrator privileges`
  return exec('osascript', ['-e', osa]).then(() => undefined, (e) => {
    throw /User canceled|-128/.test(String(e)) ? new Error('Instalação cancelada.') : e
  })
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || out.trim() || `${cmd} saiu com código ${code}`))))
  })
}

// ---------- login ----------

let login: ReturnType<typeof spawn> | null = null

/** `aws sso login` ou `aws login` (conforme o perfil): abre o navegador; o texto do CLI (código, URL) vai para a tela. */
export async function awsLogin(profile: string, onOutput: (line: string) => void): Promise<AwsStatus> {
  const bin = await findBinary('aws')
  if (!bin) throw new Error('AWS CLI não instalado.')
  if (login) throw new Error('Já há um login em andamento.')
  // sem perfil: `aws login` cria o perfil default com a sessão do console
  const kind = profile ? authKind(profile) : 'login'
  if (kind === 'static') throw new Error('Este perfil usa chaves fixas; não há login a fazer.')
  const args = kind === 'sso' ? ['sso', 'login', '--profile', profile] : profile ? ['login', '--profile', profile] : ['login']
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, NO_COLOR: '1', AWS_PAGER: '' } })
    login = child
    let err = ''
    const feed = (d: Buffer) => d.toString().split(/\r?\n/).filter((l) => l.trim()).forEach(onOutput)
    child.stdout.on('data', feed)
    child.stderr.on('data', (d: Buffer) => ((err += d.toString()), feed(d)))
    child.on('error', (e) => ((login = null), reject(e)))
    child.on('close', (code) => {
      login = null
      code === 0 ? resolve() : reject(new Error(friendly(err) || 'O login não foi concluído.'))
    })
    // sem resposta no navegador em 10 min, desiste
    setTimeout(() => child.kill(), 10 * 60 * 1000)
  })
  warnedSoon = false
  const s = await awsStatus()
  notify(s)
  return s
}

export function awsCancelLogin() {
  login?.kill()
}

export async function awsLogout(profile: string): Promise<AwsStatus> {
  const bin = await findBinary('aws')
  const kind = authKind(profile)
  if (bin && kind !== 'static') {
    const args = kind === 'sso' ? ['sso', 'logout'] : ['logout', '--profile', profile]
    await runCli(bin, args, '', os.tmpdir(), 30_000).catch(() => undefined)
  }
  const s = await awsStatus()
  notify(s)
  return s
}

// ---------- acompanhamento ----------

/** A cada 5 min: sessão caiu ou está para cair → aviso na janela e notificação do sistema */
async function watch() {
  const { awsWatch, awsProfile } = getSettings()
  if (!awsWatch || !awsProfile) return
  const before = last
  const s = await awsStatus()
  notify(s)
  if (!s.installed) return
  const wasOk = before?.session?.ok ?? true
  if (wasOk && s.session && !s.session.ok) {
    warnedSoon = false
    alert('Sessão da AWS caiu', `Perfil ${awsProfile}: ${s.session.error ?? 'desconectado'}. Entre de novo em Configurações → AWS.`)
    return
  }
  const exp = s.session?.ok ? s.session.expiresAt : null
  if (exp && exp - Date.now() < SOON_MS && !warnedSoon) {
    warnedSoon = true
    alert('Sessão da AWS expira em breve', `Perfil ${awsProfile} expira em ${Math.max(1, Math.round((exp - Date.now()) / 60000))} min. Entre de novo para não ser interrompido.`)
  }
}

function alert(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body }).show()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('aws:alert', { title, body })
}
