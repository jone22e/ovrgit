import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, hotp, otpauthUrl, totp, verifyTotp } from '../src/main/totp'

// vetores da RFC 6238 (SHA1, segredo "12345678901234567890"): 8 dígitos; os de 6 são os últimos 6
const secret = Buffer.from('12345678901234567890', 'ascii')

describe('TOTP', () => {
  it('bate com os vetores da RFC 6238', () => {
    expect(totp(secret, 59_000, 8)).toBe('94287082')
    expect(totp(secret, 1_111_111_109_000, 8)).toBe('07081804')
    expect(totp(secret, 1_234_567_890_000, 8)).toBe('89005924')
    expect(totp(secret, 59_000)).toBe('287082')
    expect(hotp(secret, 1)).toBe(totp(secret, 59_000))
  })
  it('base32 vai e volta e tolera espaços e minúsculas', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Decode('mzxw 6ytb oi').toString()).toBe('foobar')
    const s = Buffer.from('12345678901234567890')
    expect(base32Decode(base32Encode(s)).equals(s)).toBe(true)
  })
  it('aceita um passo para cada lado, recusa repetição e formato errado', () => {
    const now = 1_234_567_890_000
    const code = totp(secret, now)
    expect(verifyTotp(secret, code, { nowMs: now })).toEqual({ ok: true, counter: 41_152_263 })
    expect(verifyTotp(secret, totp(secret, now - 30_000), { nowMs: now }).ok).toBe(true)
    expect(verifyTotp(secret, totp(secret, now + 30_000), { nowMs: now }).ok).toBe(true)
    expect(verifyTotp(secret, totp(secret, now - 60_000), { nowMs: now }).ok).toBe(false)
    expect(verifyTotp(secret, code, { nowMs: now, lastCounter: 41_152_263 }).ok).toBe(false)
    expect(verifyTotp(secret, '12 34 56', { nowMs: now }).ok).toBe(false)
    expect(verifyTotp(secret, 'abcdef', { nowMs: now }).ok).toBe(false)
  })
  it('monta a URL otpauth que os autenticadores leem', () => {
    expect(otpauthUrl('MZXW6YTBOI', 'Deploy (mac)')).toBe('otpauth://totp/Ovseer%3ADeploy%20(mac)?secret=MZXW6YTBOI&issuer=Ovseer&algorithm=SHA1&digits=6&period=30')
  })
})
