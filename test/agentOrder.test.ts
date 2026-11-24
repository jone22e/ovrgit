import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { snapshotOrder } from '../src/main/agentOrder'

const userData = mkdtempSync(path.join(tmpdir(), 'ovseer-agent-order-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('horários da lista ao reabrir', () => {
  it.each(['waiting', 'error', 'done', 'idle'] as const)('preserva a posição de uma conversa %s sem usar o horário de carregamento', (status) => {
    const previous = { lastTurnId: status === 'idle' ? undefined : 't1', status, since: 100, interactedAt: 90 }
    expect(snapshotOrder({ ...previous, since: 1000, interactedAt: 990 }, previous)).toEqual(previous)
  })
  it('uma mudança real de situação ou uma nova resposta usa o novo horário', () => {
    const previous = { lastTurnId: 't1', status: 'waiting' as const, since: 100, interactedAt: 90 }
    expect(snapshotOrder({ ...previous, status: 'done', since: 200 }, previous)).toEqual({ ...previous, status: 'done', since: 200 })
    const next = { ...previous, lastTurnId: 't2', status: 'live' as const, since: 300, interactedAt: 300 }
    expect(snapshotOrder(next, previous)).toEqual(next)
  })
})

describe('ordem dos agentes concluídos', () => {
  it('preserva a posição ao reabrir e move só uma nova resposta para o topo', async () => {
    writeFileSync(path.join(userData, 'agent-order.json'), JSON.stringify({ items: { antiga: { turnId: 't1', rank: 2 }, outra: { turnId: 't2', rank: 1 } } }))
    const order = await import('../src/main/agentOrder')
    expect(order.completedOrder('antiga', 't1', 'done')).toBe(2)
    expect(order.completedOrder('outra', 't2', 'done')).toBe(1)
    expect(order.completedOrder('antiga', 't1', 'live')).toBeUndefined()

    vi.resetModules() // simula a próxima abertura do Ovseer
    const reopened = await import('../src/main/agentOrder')
    expect(reopened.completedOrder('outra', 't2', 'done')).toBe(1)
    expect(reopened.completedOrder('antiga', 't1', 'done')).toBe(2)
    expect(reopened.completedOrder('outra', 't3', 'done')).toBe(3)
    expect(JSON.parse(readFileSync(path.join(userData, 'agent-order.json'), 'utf8')).items.outra).toEqual({ turnId: 't3', rank: 3 })
  })
})
