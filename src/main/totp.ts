import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Senha de uso único por tempo (TOTP, RFC 6238) com HMAC-SHA1, 6 dígitos e janela de 30 s: o que o Google
 * Authenticator, o Authy e afins geram. Puro, sem Electron, para testar com os vetores da RFC.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff)
  return String(code % 10 ** digits).padStart(digits, '0')
}

export const totpCounter = (nowMs = Date.now(), stepSeconds = 30) => Math.floor(nowMs / 1000 / stepSeconds)

export function totp(secret: Buffer, nowMs = Date.now(), digits = 6, stepSeconds = 30): string {
  return hotp(secret, totpCounter(nowMs, stepSeconds), digits)
}

/**
 * Confere um código aceitando um passo de 30 s para cada lado (relógio do telefone) e recusando a repetição
 * de um código já usado (`lastCounter`). Devolve o contador aceito, para guardar como último usado.
 */
export function verifyTotp(secret: Buffer, code: string, { nowMs = Date.now(), window = 1, lastCounter = -1 } = {}): { ok: boolean; counter: number } {
  const digits = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(digits)) return { ok: false, counter: -1 }
  const base = totpCounter(nowMs)
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = base + delta
    if (counter <= lastCounter) continue
    const expected = hotp(secret, counter)
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return { ok: true, counter }
  }
  return { ok: false, counter: -1 }
}

export const newSecret = () => randomBytes(20)

export function otpauthUrl(secretBase32: string, account: string, issuer = 'Ovseer'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
