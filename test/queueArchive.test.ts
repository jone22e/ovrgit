import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { QueueTask } from '../src/shared/types'

const userData = mkdtempSync(path.join(os.tmpdir(), 'ovseer-queue-archive-'))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../src/main/agentChat', () => ({
  onAgentStatus: vi.fn(), onAgentGone: vi.fn(), onAgentSnapshot: vi.fn()
}))

it('arquiva o histórico antigo sem perder tarefas ativas nem opções pendentes; carrega páginas anteriores', async () => {
  const finished: QueueTask[] = Array.from({ length: 225 }, (_, i) => ({
    id: `task-${i}`, text: `Pedido ${i}`, status: 'done', managed: true, createdAt: i + 1, reply: `Resposta ${i}`
  }))
  const active: QueueTask = { id: 'active', text: 'Em andamento', status: 'running', managed: true, createdAt: 226 }
  const choice: QueueTask = { id: 'choice', text: 'Escolher projeto', status: 'done', managed: true, createdAt: 227, projectChoices: [{ cwd: '/projeto', label: 'Projeto' }] }
  writeFileSync(path.join(userData, 'queue.json'), JSON.stringify([...finished, active, choice]))

  const queue = await import('../src/main/queue')
  queue.setupQueue(() => undefined)

  expect(queue.list()).toHaveLength(102)
  expect(queue.list()[0].id).toBe('task-125')
  expect(queue.list().at(-2)?.id).toBe('active')
  expect(queue.list().at(-1)?.id).toBe('choice')
  expect(JSON.parse(readFileSync(path.join(userData, 'queue.json'), 'utf8'))).toHaveLength(102)
  expect(readdirSync(path.join(userData, 'queue-archive')).filter((name) => name.endsWith('.json'))).toHaveLength(125)

  const newest = queue.historyPage()
  expect(newest.tasks.map((task) => task.id)).toEqual(finished.slice(75, 125).map((task) => task.id))
  expect(newest.nextCursor).toBeTruthy()
  const middle = queue.historyPage(newest.nextCursor)
  expect(middle.tasks.map((task) => task.id)).toEqual(finished.slice(25, 75).map((task) => task.id))
  const oldest = queue.historyPage(middle.nextCursor)
  expect(oldest.tasks.map((task) => task.id)).toEqual(finished.slice(0, 25).map((task) => task.id))
  expect(oldest.nextCursor).toBeUndefined()

  queue.remove('task-0')
  expect(queue.historyPage(middle.nextCursor).tasks.some((task) => task.id === 'task-0')).toBe(false)
  queue.clearFinished()
  expect(queue.list().map((task) => task.id)).toEqual(['active', 'choice'])
  expect(queue.historyPage().tasks).toEqual([])
  expect(existsSync(path.join(userData, 'queue.json'))).toBe(true)

  const completedLate: QueueTask = { id: 'completed-late', text: 'Pedido antigo que terminou agora', status: 'done', managed: true, createdAt: 1, finishedAt: 10_000 }
  const normal: QueueTask[] = Array.from({ length: 100 }, (_, i) => ({ id: `normal-${i}`, text: `Pedido ${i}`, status: 'done', managed: true, createdAt: i + 2, finishedAt: i + 2 }))
  writeFileSync(path.join(userData, 'queue.json'), JSON.stringify([completedLate, ...normal]))
  queue.setupQueue(() => undefined)
  expect(queue.list().some((task) => task.id === 'completed-late')).toBe(true)
  expect(queue.list().some((task) => task.id === 'normal-0')).toBe(false)
})

it('mantém o contexto antigo do agente raiz com tamanho limitado', async () => {
  const { managerPrompt } = await import('../src/main/manager')
  const history: QueueTask[] = Array.from({ length: 30 }, (_, i) => ({
    id: `old-${i}`, text: `Pedido ${i} ${'x'.repeat(2000)}`, reply: `Resposta ${i} ${'y'.repeat(2000)}`,
    status: 'done', managed: true, createdAt: i
  }))
  const prompt = managerPrompt('Novo pedido', [], [], history)
  expect(prompt).not.toContain('Pedido 23')
  expect(prompt).toContain('Pedido 24')
  expect(prompt).toContain('Pedido 29')
  expect(prompt.length).toBeLessThan(8000)
})
