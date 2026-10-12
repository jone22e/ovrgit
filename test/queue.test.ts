import { describe, expect, it } from 'vitest'
import { assign, move } from '../src/shared/queue'
import type { QueueTask } from '../src/shared/types'

const t = (id: string, status: QueueTask['status'] = 'queued', cwd?: string): QueueTask => ({ id, text: id, status, cwd, createdAt: 0 })
const agents = [
  { uid: 'a', cwd: '/p/one', title: 'A' },
  { uid: 'b', cwd: '/p/two', title: 'B' },
  { uid: 'c', cwd: '/p/one', title: 'C' }
]

describe('fila de tarefas', () => {
  it('entrega na ordem, um agente por tarefa, respeitando o repositório', () => {
    const pairs = assign([t('1'), t('2', 'queued', '/p/two'), t('3', 'queued', '/p/three'), t('4'), t('5', 'running')], agents, new Set())
    expect(pairs.map((p) => [p.task.id, p.agent.uid])).toEqual([['1', 'a'], ['2', 'b'], ['4', 'c']])
  })
  it('agente já ocupado não pega outra', () => {
    expect(assign([t('1'), t('2')], agents, new Set(['a', 'c'])).map((p) => p.agent.uid)).toEqual(['b'])
  })
  it('sobe e desce só entre as que esperam', () => {
    const list = [t('1', 'done'), t('2'), t('3'), t('4')]
    expect(move(list, '3', -1).map((x) => x.id)).toEqual(['1', '3', '2', '4'])
    expect(move(list, '2', -1).map((x) => x.id)).toEqual(['1', '2', '3', '4'])
    expect(move(list, '4', 1).map((x) => x.id)).toEqual(['1', '2', '3', '4'])
  })
})
