import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import QRCode from 'qrcode'
import type { DeployAuthSetup, DeployAuthStatus } from '../shared/types'
import { base32Decode, base32Encode, newSecret, otpauthUrl, verifyTotp } from './totp'

/**
 * Verificação em duas etapas do deploy: o usuário lê um QR code no aplicativo autenticador do telefone e,
 * a partir daí, o primeiro deploy após abrir o Ovseer exige o código de 6 dígitos. Liberar a trava
 * compartilhada sempre exige código. O segredo fica
 * criptografado pelo sistema (Keychain no Mac, DPAPI no Windows) em userData, nunca no repositório nem nas
 * configurações; o processo principal confere o código, a tela só o digita. Vale para todos os projetos e é
 * obrigatória: sem ela ativada, nenhum deploy começa pelo app.
 */

interface Stored {
  secret: string
  /** Último contador aceito: um código não vale duas vezes */
  last: number
}

const file = () => path.join(app.getPath('userData'), 'deploy-totp.bin')
let pending: { secret: Buffer; base32: string } | null = null
/** Autorização válida somente enquanto este processo do Ovseer estiver aberto. */
let authenticated = false

function read(): Stored | null {
  try {
    const raw = readFileSync(file())
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
    const parsed = JSON.parse(text) as Stored
    return typeof parsed.secret === 'string' ? { secret: parsed.secret, last: Number(parsed.last) || -1 } : null
  } catch {
    return null
  }
}

function write(stored: Stored) {
  const text = JSON.stringify(stored)
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')
  writeFileSync(file(), data, { mode: 0o600 })
}

export const enabled = () => existsSync(file()) && read() !== null

export function status(): DeployAuthStatus {
  const isEnabled = enabled()
  return { enabled: isEnabled, authenticated: isEnabled && authenticated }
}

/** Começa a ativação: novo segredo, QR code e chave para digitar; só vale depois de confirmar um código */
export async function begin(): Promise<DeployAuthSetup> {
  const secret = newSecret()
  const base32 = base32Encode(secret)
  pending = { secret, base32 }
  const otpauth = otpauthUrl(base32, `Deploy (${os.hostname()})`)
  const qrSvg = await QRCode.toString(otpauth, { type: 'svg', margin: 1, width: 180, errorCorrectionLevel: 'M' })
  return { secret: base32.replace(/(.{4})/g, '$1 ').trim(), otpauth, qrSvg }
}

export function confirm(code: string): DeployAuthStatus {
  if (!pending) throw new Error('Comece a ativação de novo: não há chave pendente.')
  const result = verifyTotp(pending.secret, String(code ?? ''))
  if (!result.ok) throw new Error('Código inválido. Confira o relógio do telefone e tente de novo.')
  write({ secret: pending.base32, last: result.counter })
  pending = null
  authenticated = false
  return status()
}

export function disable(code: string): DeployAuthStatus {
  verifyCode(code)
  try {
    unlinkSync(file())
  } catch {
    /* já não existe */
  }
  authenticated = false
  return status()
}

function verifyCode(code?: string) {
  const stored = read()
  if (!stored) throw new Error('Ative a verificação em duas etapas em Configurações → Deploy antes de fazer deploy.')
  if (!code) throw new Error('Digite o código do aplicativo autenticador.')
  const result = verifyTotp(base32Decode(stored.secret), String(code), { lastCounter: stored.last })
  if (!result.ok) throw new Error('Código do autenticador inválido ou já usado.')
  write({ ...stored, last: result.counter })
}

/** Barreira para iniciar ou retomar deploy: confirma uma vez por execução do Ovseer. */
export function requireCode(code?: string) {
  if (!enabled()) throw new Error('Ative a verificação em duas etapas em Configurações → Deploy antes de fazer deploy.')
  if (authenticated) return
  verifyCode(code)
  authenticated = true
}

/** Liberar a trava exige um código novo mesmo após autorizar deploys nesta execução. */
export function requireCodeAlways(code?: string) {
  verifyCode(code)
}
