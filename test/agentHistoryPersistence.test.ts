import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { AgentTurn, AgentWindowInfo } from '../src/shared/types'

const userData = mkdtempSync(path.join(tmpdir(), 'ovseer-history-persistence-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
afterAll(() => rmSync(userData, { recursive: true, force: true }))
afterEach(() => vi.useRealTimers())

const info = (sessionId: string): AgentWindowInfo => ({
  uid: sessionId, sessionId, provider: 'codex', model: '', effort: 'high', mode: 'full',
  cwd: '/repo', project: 'repo', branch: 'main', running: false, title: sessionId, renamed: false
})
const turn = (id: string): AgentTurn => ({
  id, user: 'Pedido', attachments: [], running: false, thinking: false, startedAt: 1000,
  blocks: [{ kind: 'tool', id: 'tool', name: 'Bash', title: 'Testes', ok: true, open: true }]
})

it('reabrir e republicar transcrições em outra ordem não altera a ordem do histórico', async () => {
  vi.useFakeTimers()
  const history = await import('../src/main/agentHistory')
  vi.setSystemTime(1000)
  history.saveTranscript(info('older'), [turn('t1')], 'done')
  vi.setSystemTime(2000)
  history.saveTranscript(info('newer'), [turn('t2')], 'done')
  const before = history.listHistory().map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt }))
  expect(before).toEqual([{ sessionId: 'newer', updatedAt: 2000 }, { sessionId: 'older', updatedAt: 1000 }])

  vi.resetModules()
  const reopened = await import('../src/main/agentHistory')
  for (const [i, sessionId] of ['newer', 'older'].entries()) {
    vi.setSystemTime(3000 + i)
    reopened.saveTranscript(info(sessionId), reopened.loadTranscript(sessionId)!, 'done')
  }
  expect(reopened.listHistory().map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt }))).toEqual(before)

  // Abrir/fechar o detalhe de uma ferramenta também não é atividade nova.
  vi.setSystemTime(4000)
  reopened.saveTranscript(info('older'), [turn('t1')], 'done')
  expect(reopened.listHistory().map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt }))).toEqual(before)

  // Uma mensagem nova continua levando a conversa para o topo.
  vi.setSystemTime(5000)
  reopened.saveTranscript(info('older'), [turn('t1'), turn('t3')], 'done')
  expect(reopened.listHistory().map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt })))
    .toEqual([{ sessionId: 'older', updatedAt: 5000 }, { sessionId: 'newer', updatedAt: 2000 }])
})
