import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { base32Encode, totp } from '../src/main/totp'

const userData = mkdtempSync(path.join(tmpdir(), 'ovseer-deploy-auth-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))

afterAll(() => {
  vi.useRealTimers()
  rmSync(userData, { recursive: true, force: true })
})

describe('autorização de deploy', () => {
  it('pede MFA uma vez por abertura do app e sempre para liberar trava ou desativar', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'))
    const secret = Buffer.from('12345678901234567890')
    writeFileSync(path.join(userData, 'deploy-totp.bin'), JSON.stringify({ secret: base32Encode(secret), last: -1 }))

    const auth = await import('../src/main/deployAuth')
    expect(auth.status()).toEqual({ enabled: true, authenticated: false })
    expect(() => auth.requireCode()).toThrow(/Digite o código/)
    expect(() => auth.requireCode('000000')).toThrow(/inválido/)
    auth.requireCode(totp(secret))
    expect(auth.status()).toEqual({ enabled: true, authenticated: true })
    expect(() => auth.requireCode()).not.toThrow()
    expect(() => auth.requireCodeAlways()).toThrow(/Digite o código/)

    vi.resetModules() // novo processo: a autorização em memória desaparece, mas a chave permanece
    const reopened = await import('../src/main/deployAuth')
    expect(reopened.status()).toEqual({ enabled: true, authenticated: false })
    expect(() => reopened.requireCode()).toThrow(/Digite o código/)
    expect(() => reopened.requireCode(totp(secret))).toThrow(/já usado/)
    vi.setSystemTime(Date.now() + 30_000)
    reopened.requireCode(totp(secret))
    expect(() => reopened.disable('')).toThrow(/Digite o código/)
    vi.setSystemTime(Date.now() + 30_000)
    expect(reopened.disable(totp(secret))).toEqual({ enabled: false, authenticated: false })
    expect(() => reopened.requireCode()).toThrow(/Ative a verificação/)
  })
})
