import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentChatEvent, AgentStatus } from '../src/shared/types'
import type { ScheduledTask } from '../src/shared/schedules'

const hooks = vi.hoisted(() => ({
  event: (_uid: string, _event: AgentChatEvent) => {}, status: (_uid: string, _status: AgentStatus) => {}, gone: (_uid: string) => {},
  open: vi.fn(), close: vi.fn(), info: vi.fn()
}))
vi.mock('../src/main/agentChat', () => ({
  onAgentEvent: (fn: typeof hooks.event) => { hooks.event = fn },
  onAgentStatus: (fn: typeof hooks.status) => { hooks.status = fn },
  onAgentGone: (fn: typeof hooks.gone) => { hooks.gone = fn },
  openAgentWindow: hooks.open, closeAgentWindows: hooks.close, agentInfo: hooks.info
}))
import { scheduledAgentExecutor } from '../src/main/scheduledAgents'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'ovseer-scheduled-agent-'))
  vi.useFakeTimers()
  hooks.open.mockResolvedValue({ uid: 'agent-id' })
  hooks.info.mockReturnValue({ sessionId: 'session-id' })
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); rmSync(cwd, { recursive: true, force: true }) })
const task = (): ScheduledTask => ({ id: 'task-id', name: 'Resumo', prompt: 'Confira erros', cwd, provider: 'codex', model: '', effort: 'high', mode: 'plan', enabled: true, timing: { kind: 'interval', minutes: 60 }, createdAt: Date.now(), nextRunAt: Date.now(), runs: [] })

describe('conversas das tarefas periódicas', () => {
  it('abre conversa em segundo plano, acompanha sessão e só termina no status final', async () => {
    const progress = vi.fn()
    const promise = scheduledAgentExecutor()(task(), progress)
    await Promise.resolve()
    expect(hooks.open).toHaveBeenCalledWith(expect.objectContaining({ hidden: true, scheduled: true, mode: 'plan', cwd, firstMessage: 'Tarefa periódica: Resumo\n\nConfira erros' }))
    hooks.event('agent-id', { type: 'session', sessionId: 'session-id' })
    hooks.event('agent-id', { type: 'text', delta: 'Sem erros' })
    hooks.event('agent-id', { type: 'done', ok: true })
    hooks.status('agent-id', 'live')
    await vi.advanceTimersByTimeAsync(60001)
    expect(hooks.close).not.toHaveBeenCalled()
    hooks.status('agent-id', 'done')
    expect(await promise).toMatchObject({ uid: 'agent-id', sessionId: 'session-id', result: 'Sem erros' })
    expect(progress).toHaveBeenCalledWith({ uid: 'agent-id', sessionId: 'session-id' })
  })
  it('registra erro do agente e fechamento da conversa', async () => {
    const executor = scheduledAgentExecutor()
    const failed = executor(task(), () => {})
    await Promise.resolve()
    hooks.event('agent-id', { type: 'done', ok: false, error: 'Sem login' })
    hooks.status('agent-id', 'error')
    expect(await failed).toMatchObject({ error: 'Sem login' })
    const closed = executor(task(), () => {})
    await Promise.resolve()
    hooks.gone('agent-id')
    expect((await closed).error).toContain('fechada')
  })
  it('falha e fecha a janela se o renderer não iniciar a conversa', async () => {
    const promise = scheduledAgentExecutor()(task(), () => {})
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(60001)
    expect((await promise).error).toContain('não iniciou')
    expect(hooks.close).toHaveBeenCalledWith(['agent-id'])
  })
  it('não abre agente se a pasta não existe mais', async () => {
    const input = task()
    rmSync(cwd, { recursive: true })
    await expect(scheduledAgentExecutor()(input, () => {})).rejects.toThrow('pasta')
    expect(hooks.open).not.toHaveBeenCalled()
  })
})
