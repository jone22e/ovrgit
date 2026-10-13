import { describe, expect, it } from 'vitest'
import type { AgentWindowInfo } from '../src/shared/types'
import { parseSnapshot, reopenRequest, toOpenAgent } from '../src/main/openAgents'

const info = (over: Partial<AgentWindowInfo> = {}): AgentWindowInfo => ({
  uid: 'u1', provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh', mode: 'full', cwd: '/w/flexi2', project: 'flexi2', branch: 'main',
  sessionId: 'thread-abc-123', running: false, title: 'Contagem de carga', renamed: false, ...over
})

describe('toOpenAgent', () => {
  it('guarda só o que precisa para reabrir, sem campos vazios', () => {
    expect(toOpenAgent(info(), { docked: false, hidden: false })).toEqual({ provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh', mode: 'full', cwd: '/w/flexi2', sessionId: 'thread-abc-123' })
  })
  it('marca em espera, escondido, encaixado e os repositórios juntados', () => {
    const a = toOpenAgent(info({ sessionId: null, standby: true, extraDirs: ['/w/a'] }), { docked: true, hidden: true })
    expect(a).toEqual({ provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh', mode: 'full', cwd: '/w/flexi2', extraDirs: ['/w/a'], standby: true, hidden: true, docked: true })
  })
})

describe('reopenRequest', () => {
  it('retoma a sessão e nasce quieto; só o encaixado toma a área, e só no orquestrador', () => {
    const a = toOpenAgent(info(), { docked: true, hidden: false })
    expect(reopenRequest(a, true)).toMatchObject({ resumeId: 'thread-abc-123', standby: false, hidden: false, quiet: false })
    expect(reopenRequest(a, false).quiet).toBe(true)
    expect(reopenRequest({ ...a, docked: undefined }, true).quiet).toBe(true)
  })
  it('agente em espera volta em espera, sem sessão', () => {
    const r = reopenRequest(toOpenAgent(info({ sessionId: null, standby: true }), { docked: false, hidden: false }), true)
    expect(r.resumeId).toBeUndefined()
    expect(r.standby).toBe(true)
  })
})

describe('parseSnapshot', () => {
  const exists = (p: string) => p.startsWith('/ok')
  const snap = (agents: unknown[]) => JSON.stringify({ savedAt: 1, agents })
  it('descarta arquivo corrompido ou sem lista', () => {
    expect(parseSnapshot('{')).toEqual([])
    expect(parseSnapshot('{"agents": 3}')).toEqual([])
    expect(parseSnapshot('[]')).toEqual([])
  })
  it('descarta pasta inexistente, IA desconhecida e sessão inválida; conserta o esforço', () => {
    const list = parseSnapshot(
      snap([
        { provider: 'codex', model: 'm', effort: 'xhigh', mode: 'full', cwd: '/gone' },
        { provider: 'gemini', model: 'm', effort: 'high', mode: 'full', cwd: '/ok/a' },
        { provider: 'claude', model: 'opus', effort: 'absurdo', mode: 'full', cwd: '/ok/a', sessionId: 'x y', extraDirs: ['/ok/b', '/gone', '/ok/a'] },
        { provider: 'codex', model: 'm', effort: 'high', mode: 'full', cwd: '/ok/c', sessionId: 'thread-1234', standby: true, docked: true },
        { provider: 'codex', model: 'm', effort: 'high', mode: 'full', cwd: '/ok/d', docked: true, hidden: true }
      ]),
      exists
    )
    expect(list).toEqual([
      { provider: 'claude', model: 'opus', effort: 'high', mode: 'full', cwd: '/ok/a', extraDirs: ['/ok/b'] },
      { provider: 'codex', model: 'm', effort: 'high', mode: 'full', cwd: '/ok/c', sessionId: 'thread-1234', standby: true, docked: true },
      { provider: 'codex', model: 'm', effort: 'high', mode: 'full', cwd: '/ok/d', hidden: true }
    ])
  })
  it('limita a 24 agentes', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ provider: 'codex', model: '', effort: 'high', mode: 'full', cwd: `/ok/${i}` }))
    expect(parseSnapshot(snap(many), exists)).toHaveLength(24)
  })
})
