import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatEvent } from '../src/shared/types'
import { ClaudeCompletion } from '../src/main/claudeCompletion'

type Done = Extract<AgentChatEvent, { type: 'done' }>
const done: Done = { type: 'done', ok: true, durationMs: 100 }

describe('fim da resposta do Claude após mensagens enviadas durante a vez', () => {
  afterEach(() => vi.useRealTimers())

  it('encerra imediatamente uma resposta sem mensagens adicionais', () => {
    const finish = vi.fn()
    new ClaudeCompletion(finish).result(done)
    expect(finish).toHaveBeenCalledExactlyOnceWith(done)
  })

  it('encerra quando o CLI reúne várias mensagens em um único resultado', () => {
    vi.useFakeTimers()
    const finish = vi.fn()
    const completion = new ClaudeCompletion(finish)
    completion.steer()
    completion.steer()
    completion.result(done)
    expect(finish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(finish).toHaveBeenCalledExactlyOnceWith(done)
  })

  it('aguarda a próxima resposta quando o CLI emite resultados separados', () => {
    vi.useFakeTimers()
    const finish = vi.fn()
    const completion = new ClaudeCompletion(finish)
    const final: Done = { type: 'done', ok: true, durationMs: 200 }
    completion.steer()
    completion.result(done)
    expect(completion.activity()).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(finish).not.toHaveBeenCalled()
    completion.result(final)
    vi.advanceTimersByTime(1000)
    expect(finish).toHaveBeenCalledExactlyOnceWith(final)
  })

  it('encerra ao sair o processo mesmo com um resultado ainda em espera', () => {
    vi.useFakeTimers()
    const finish = vi.fn()
    const completion = new ClaudeCompletion(finish)
    completion.steer()
    completion.result(done)
    completion.flush()
    vi.advanceTimersByTime(1000)
    expect(finish).toHaveBeenCalledExactlyOnceWith(done)
  })

  it('descarta o resultado anterior se o processo foi interrompido durante a espera', () => {
    vi.useFakeTimers()
    const finish = vi.fn()
    const completion = new ClaudeCompletion(finish)
    completion.steer()
    completion.result(done)
    expect(completion.waiting).toBe(true)
    completion.dispose()
    vi.advanceTimersByTime(1000)
    expect(finish).not.toHaveBeenCalled()
  })
})
