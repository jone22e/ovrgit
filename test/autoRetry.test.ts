import { describe, expect, it } from 'vitest'
import { AUTO_RETRY_DELAYS, AUTO_RETRY_MAX, canAutoRetry } from '../src/shared/autoRetry'

describe('canAutoRetry', () => {
  it('retoma falhas passageiras', () => {
    expect(canAutoRetry('This session was recorded with model `gpt-5.6-sol` but is resuming with `gpt-6-sol`.')).toBe(true)
    expect(canAutoRetry('Codex saiu com código 1')).toBe(true)
    expect(canAutoRetry('stream disconnected before completion')).toBe(true)
    expect(canAutoRetry('529 Overloaded')).toBe(true)
    expect(canAutoRetry('Rate limit exceeded, try again in a few seconds')).toBe(true)
  })
  it('não retoma o que o usuário interrompeu', () => {
    expect(canAutoRetry('Interrompido.')).toBe(false)
    expect(canAutoRetry('A resposta foi interrompida antes de terminar.')).toBe(false)
    expect(canAutoRetry(undefined)).toBe(false)
    expect(canAutoRetry('  ')).toBe(false)
  })
  it('não retoma o que depende do usuário', () => {
    expect(canAutoRetry('Sem login. Abra ⚙ Configurações e clique em "Entrar".')).toBe(false)
    expect(canAutoRetry('Codex CLI não encontrado. Instale com "npm i -g @openai/codex" e rode "codex login".')).toBe(false)
    expect(canAutoRetry('Modelo não encontrado na sua conta. Escolha outro no seletor.')).toBe(false)
    expect(canAutoRetry("You've hit your usage limit. Try again at 5pm.")).toBe(false)
    expect(canAutoRetry('Seu Claude Code (1.0) é antigo demais para este modelo')).toBe(false)
  })
  it('tem uma espera para cada tentativa', () => {
    expect(AUTO_RETRY_DELAYS).toHaveLength(AUTO_RETRY_MAX)
  })
})
