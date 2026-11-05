import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'ovseer-agent-order-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
afterAll(() => rmSync(userData, { recursive: true, force: true }))

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
