import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentChatEvent, AgentStatus } from '../src/shared/types'
import type { ScheduledTask } from '../src/shared/schedules'

const hooks = vi.hoisted(() => ({
  event: (_uid: string, _event: AgentChatEvent) => {}, status: (_uid: string, _status: AgentStatus) => {}, gone: (_uid: string) => {},
  open: vi.fn(), infos: vi.fn(), info: vi.fn(), statusOf: vi.fn(), deliver: vi.fn(), release: vi.fn()
}))
vi.mock('../src/main/agentChat', () => ({
  onAgentEvent: (fn: typeof hooks.event) => { hooks.event = fn },
  onAgentStatus: (fn: typeof hooks.status) => { hooks.status = fn },
  onAgentGone: (fn: typeof hooks.gone) => { hooks.gone = fn },
  openAgentWindow: hooks.open, agentWindowInfos: hooks.infos, agentInfo: hooks.info, agentStatus: hooks.statusOf,
  deliverScheduledMessage: hooks.deliver, releaseScheduledMessage: hooks.release
}))
import { scheduledAgentExecutor } from '../src/main/scheduledAgents'

let cwd: string
const origin = () => ({ uid: 'agent-id', sessionId: 'session-origin', running: false })
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'ovseer-scheduled-agent-'))
  vi.useFakeTimers()
  hooks.open.mockResolvedValue(origin())
  hooks.infos.mockReturnValue([origin()])
  hooks.info.mockReturnValue(origin())
  hooks.statusOf.mockReturnValue('done')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); rmSync(cwd, { recursive: true, force: true }) })
const task = (): ScheduledTask => ({ id: 'task-id', sessionId: 'session-origin', name: 'Resumo', prompt: 'Confira erros', cwd, provider: 'codex', model: '', effort: 'high', mode: 'plan', enabled: true, timing: { kind: 'interval', minutes: 60 }, createdAt: Date.now(), nextRunAt: Date.now(), runs: [] })
const start = (runId = 'run-id') => hooks.event('agent-id', { type: 'scheduledStart', runId })
const done = () => hooks.event('agent-id', { type: 'done', ok: true })

describe('agendamentos na conversa original', () => {
  it('envia à janela existente e registra a resposta sem abrir outra conversa', async () => {
    const progress = vi.fn()
    const promise = scheduledAgentExecutor()(task(), progress, 'run-id')
    await flush()
    expect(hooks.open).not.toHaveBeenCalled()
    expect(hooks.deliver).toHaveBeenCalledWith('agent-id', expect.objectContaining({ sessionId: 'session-origin', runId: 'run-id', text: 'Tarefa periódica: Resumo\n\nConfira erros' }))
    start()
    hooks.event('agent-id', { type: 'text', delta: 'Sem erros' })
    done()
    expect(await promise).toMatchObject({ uid: 'agent-id', sessionId: 'session-origin', result: 'Sem erros' })
    expect(hooks.release).toHaveBeenCalledWith('run-id')
    expect(progress).toHaveBeenCalledWith({ uid: 'agent-id', sessionId: 'session-origin' })
  })
  it('reabre a mesma sessão fechada, sem firstMessage nem sessão nova', async () => {
    hooks.infos.mockReturnValue([])
    const promise = scheduledAgentExecutor()(task(), () => {}, 'run-id')
    await flush()
    expect(hooks.open).toHaveBeenCalledWith(expect.objectContaining({ resumeId: 'session-origin', hidden: true }))
    expect(hooks.open.mock.calls[0][0].firstMessage).toBeUndefined()
    start(); done(); await promise
  })
  it('aguarda trabalho atual e perguntas; não atribui a resposta anterior à tarefa', async () => {
    hooks.statusOf.mockReturnValue('live')
    hooks.info.mockReturnValue({ ...origin(), running: true })
    const promise = scheduledAgentExecutor()(task(), () => {}, 'run-id')
    await flush()
    done(); hooks.status('agent-id', 'done')
    await vi.advanceTimersByTimeAsync(5000)
    expect(hooks.deliver).not.toHaveBeenCalled()
    hooks.info.mockReturnValue(origin())
    hooks.statusOf.mockReturnValue('waiting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(hooks.deliver).not.toHaveBeenCalled()
    hooks.statusOf.mockReturnValue('done')
    await vi.advanceTimersByTimeAsync(1000)
    expect(hooks.deliver).toHaveBeenCalledTimes(1)
    start(); done(); await promise
  })
  it('serializa agendamentos diferentes da mesma sessão', async () => {
    const execute = scheduledAgentExecutor()
    const first = execute(task(), () => {}, 'run-1')
    const second = execute({ ...task(), id: 'other' }, () => {}, 'run-2')
    await flush()
    expect(hooks.deliver).toHaveBeenCalledTimes(1)
    start('run-1'); done(); await first; await flush()
    expect(hooks.deliver).toHaveBeenCalledTimes(2)
    start('run-2'); done(); await second
  })
  it('preserva a espera por tarefas em segundo plano', async () => {
    const promise = scheduledAgentExecutor()(task(), () => {}, 'run-id')
    await flush(); start()
    hooks.info.mockReturnValue({ ...origin(), bgTasks: [{ id: 'bg' }] })
    done()
    expect(hooks.release).not.toHaveBeenCalled()
    hooks.info.mockReturnValue(origin())
    hooks.status('agent-id', 'done')
    await promise
  })
  it('registra falha ou fechamento sem encerrar o agente original', async () => {
    const execute = scheduledAgentExecutor()
    const failed = execute(task(), () => {}, 'run-1')
    await flush(); start('run-1')
    hooks.event('agent-id', { type: 'done', ok: false, error: 'Sem login' })
    expect(await failed).toMatchObject({ error: 'Sem login' })
    const closed = execute(task(), () => {}, 'run-2')
    await flush(); hooks.gone('agent-id')
    expect((await closed).error).toContain('fechada')
  })
  it('não envia para outra sessão quando o usuário abre uma conversa nova na mesma janela', async () => {
    hooks.statusOf.mockReturnValue('live')
    const promise = scheduledAgentExecutor()(task(), () => {}, 'run-id')
    await flush()
    hooks.info.mockReturnValue({ ...origin(), sessionId: 'another-session' })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await promise).error).toContain('origem mudou')
    expect(hooks.deliver).not.toHaveBeenCalled()
  })
  it('invalida entrega sem confirmação para impedir execução tardia', async () => {
    const promise = scheduledAgentExecutor()(task(), () => {}, 'run-id')
    await flush(); await vi.advanceTimersByTimeAsync(60001)
    expect((await promise).error).toContain('não confirmou')
    expect(hooks.release).toHaveBeenCalledWith('run-id')
  })
  it('exige uma sessão de origem e uma pasta válida', async () => {
    const execute = scheduledAgentExecutor()
    await expect(execute({ ...task(), sessionId: undefined }, () => {}, 'run-1')).rejects.toThrow('Sessão')
    rmSync(cwd, { recursive: true })
    await expect(execute(task(), () => {}, 'run-2')).rejects.toThrow('pasta')
    expect(hooks.open).not.toHaveBeenCalled()
  })
})
