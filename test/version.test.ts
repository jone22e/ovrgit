import { describe, expect, it } from 'vitest'
import { isNewerVersion } from '../src/shared/version'

describe('isNewerVersion', () => {
  it('compara número a número, não como texto', () => {
    expect(isNewerVersion('0.1.33', '0.1.32')).toBe(true)
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.1.99')).toBe(true)
    expect(isNewerVersion('1.0', '0.9.9')).toBe(true)
  })
  it('igual ou mais velha não é mais nova', () => {
    expect(isNewerVersion('0.1.32', '0.1.32')).toBe(false)
    expect(isNewerVersion('0.1.31', '0.1.32')).toBe(false)
    expect(isNewerVersion('0.1', '0.1.0')).toBe(false)
  })
  it('ignora o v e sufixos', () => {
    expect(isNewerVersion('v0.1.33', '0.1.32')).toBe(true)
    expect(isNewerVersion('0.1.33-beta.1', '0.1.32')).toBe(true)
  })
})
