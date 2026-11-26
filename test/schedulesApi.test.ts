import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAgentApi, stopAgentApi } from '../src/main/agentApi'
import { Scheduler, type RunResult } from '../src/main/schedules'

const cwd = mkdtempSync(path.join(os.tmpdir(), 'ovseer-schedules-api-'))
let finish!: (result: RunResult) => void
const scheduler = new Scheduler(path.join(cwd, 'schedules.json'), () => new Promise((resolve) => { finish = resolve }))
let sourceSession = 'session-origin'
const source = { uid: 'agent-origin', sessionId: sourceSession, provider: 'codex' as const, model: '', effort: 'high' as const, mode: 'plan' as const, cwd, project: 'test', branch: null, running: false, title: '', renamed: false }
const api = await startAgentApi({
  scheduleAgent: (uid) => uid === source.uid ? { ...source, sessionId: sourceSession } : null,
  schedules: scheduler, services: () => [], states: () => [], start: async () => {}, stop: () => {}, output: () => [],
  create: () => { throw new Error('fora do escopo') }
})
const call = (url: string, method = 'GET', body?: unknown, token = api.token) => fetch(`http://127.0.0.1:${api.port}/schedules${url}`, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {})
})
afterAll(() => { scheduler.stop(); stopAgentApi(); rmSync(cwd, { recursive: true, force: true }) })

describe('API local de agendamentos', () => {
  it('autentica, valida, cria, lista, edita, pausa e retoma', async () => {
    expect((await call('', 'GET', undefined, 'errado')).status).toBe(401)
    expect((await call('', 'POST', {})).status).toBe(400)
    const input = { agentUid: source.uid, name: 'Resumo', prompt: 'Confira erros', cwd, provider: 'codex', model: '', effort: 'high', mode: 'plan', enabled: true, timing: { kind: 'daily', time: '08:00', timezone: 'America/Sao_Paulo' } }
    const created = await call('', 'POST', input)
    expect(created.status).toBe(201)
    const task = await created.json()
    expect(task.sessionId).toBe('session-origin')
    expect((await call('', 'POST', { ...input, agentUid: 'inexistente' })).status).toBe(400)
    const spoofed = await (await call('', 'POST', { ...input, name: 'Outra', sessionId: 'inventada', provider: 'claude', cwd: '/inventado' })).json()
    expect(spoofed).toMatchObject({ sessionId: 'session-origin', provider: 'codex', cwd })
    await call(`/${spoofed.id}`, 'DELETE')
    expect((await (await call('')).json()).schedules).toHaveLength(1)
    expect((await call('', 'POST', input)).status).toBe(409)
    expect((await (await call(`/${task.id}`)).json()).name).toBe('Resumo')
    expect((await (await call(`/${task.id}`, 'PUT', { ...input, name: 'Editado' })).json()).name).toBe('Editado')
    expect((await (await call(`/${task.id}/pause`, 'POST')).json()).enabled).toBe(false)
    expect((await (await call(`/${task.id}/resume`, 'POST')).json()).enabled).toBe(true)
    sourceSession = 'another-session'
    expect((await call(`/${task.id}`, 'PUT', input)).status).toBe(409)
    sourceSession = 'session-origin'
    expect((await call('/inexistente')).status).toBe(404)
    expect((await call(`/${task.id}/pause`)).status).toBe(405)
  })
  it('executa, rejeita sobreposição e exclusão durante a execução e devolve o resultado', async () => {
    const task = scheduler.list()[0]
    expect((await call(`/${task.id}/run`, 'POST')).status).toBe(202)
    expect((await call(`/${task.id}/run`, 'POST')).status).toBe(409)
    expect((await call(`/${task.id}`, 'DELETE')).status).toBe(409)
    finish({ result: 'Sem erros', sessionId: 'sessao-123456' })
    const state = await (await call(`/${task.id}`)).json()
    expect(state.runs[0]).toMatchObject({ status: 'done', result: 'Sem erros', sessionId: 'sessao-123456' })
    expect((await call(`/${task.id}`, 'DELETE')).status).toBe(200)
    expect(scheduler.list()).toEqual([])
  })
})
