import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(os.tmpdir(), 'ovseer-manager-'))
const project = mkdtempSync(path.join(os.tmpdir(), 'ovseer-project-'))
const other = mkdtempSync(path.join(os.tmpdir(), 'ovseer-other-'))
const fake = vi.hoisted(() => ({
  snapshots: [] as any[],
  opened: [] as any[],
  actions: [] as { uid: string; action: any }[]
}))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ provider: 'codex', queueReuse: true, queueSmart: true, codexModel: '' }) }))
vi.mock('../src/main/quickAi', () => ({ quickAsk: vi.fn(async () => '0') }))
vi.mock('../src/main/reasoner', () => ({ reasonAbout: vi.fn() }))
vi.mock('../src/main/agentChat', () => ({
  agentSnapshots: () => fake.snapshots,
  agentWindowInfos: () => [...fake.snapshots, ...fake.opened],
  agentInfo: (uid: string) => [...fake.snapshots, ...fake.opened].find((a) => a.uid === uid) ?? null,
  agentBase: () => ({ provider: 'codex', model: '', effort: 'high', mode: 'full', cwd: project }),
  actOnAgent: (uid: string, action: any) => fake.actions.push({ uid, action }),
  setExtraDirs: vi.fn(),
  openAgentWindow: vi.fn(async (opts: any) => {
    const agent = { ...opts, uid: 'new-1', title: 'Novo agente', sessionId: null }
    fake.opened.push(agent)
    return agent
  }),
  availableStandby: () => [],
  onAgentStatus: vi.fn(),
  onAgentGone: vi.fn(),
  onAgentSnapshot: vi.fn()
}))

it('encaminha para uma conversa relacionada e ocupada do mesmo projeto; cria agente quando não há relação', async () => {
  fake.snapshots.push(
    { uid: 'related', cwd: project, provider: 'codex', status: 'live', title: 'Login: acesso negado', lastUser: 'Corrigir mensagem de acesso negado no login', summary: '', paths: [] },
    { uid: 'wrong-project', cwd: other, provider: 'codex', status: 'done', title: 'Exportação em PDF', lastUser: 'Criar exportação em PDF', summary: '', paths: [] }
  )
  const queue = await import('../src/main/queue')
  queue.setupQueue(() => undefined)

  const first = queue.add({ text: 'Ajustar mensagem de acesso negado no login', cwd: project, managed: true }).at(-1)!
  await vi.waitFor(() => expect(fake.actions).toHaveLength(1))
  expect(fake.actions[0]).toMatchObject({ uid: 'related', action: { type: 'enqueue', taskId: first.id } })
  expect(first.status).toBe('queued')
  queue.started(first.id, 'related')
  expect(first.status).toBe('running')
  queue.finished(first.id, 'related', true)
  expect(first.status).toBe('done')

  const second = queue.add({ text: 'Criar exportação em PDF', cwd: project, managed: true }).at(-1)!
  await vi.waitFor(() => expect(fake.opened).toHaveLength(1))
  expect(fake.opened[0]).toMatchObject({ cwd: project, firstMessage: second.text, managerTaskId: second.id, quiet: true })
  expect(second.via).toBe('new')
  expect(fake.actions).toHaveLength(1)
})
