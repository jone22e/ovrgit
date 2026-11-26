import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSnapshot } from '../src/shared/types'
import type { OpenAgent } from '../src/main/openAgents'

const userData = mkdtempSync(path.join(tmpdir(), 'ovseer-agent-restore-'))
const snapshotFile = path.join(userData, 'open-agents.json')
const area = { x: 0, y: 0, width: 1600, height: 1000 }
let opened = 0
let failAt = 0

class Host extends EventEmitter {
  visible = false
  close = () => { this.emit('closed') }
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(), setBackgroundThrottling: vi.fn(), send: vi.fn(), isDestroyed: () => false
  })
  constructor() {
    super()
    if (++opened === failAt) throw new Error('Falha temporária ao criar a janela')
  }
  loadFile = async () => undefined
  loadURL = async () => undefined
  isDestroyed = () => false
  isMinimized = () => false
  isFullScreen = () => false
  isVisible = () => this.visible
  getBounds = () => area
}

vi.mock('electron', () => ({
  app: { getPath: () => userData, setBadgeCount: vi.fn() },
  BrowserWindow: Host,
  webContents: { getAllWebContents: () => [] },
  Notification: { isSupported: () => false },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: area }),
    getDisplayMatching: () => ({ workArea: area })
  }
}))
vi.mock('../src/main/cli', () => ({ runCli: vi.fn(async () => ({ code: 0, stdout: 'main', stderr: '' })) }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  opened = 0
  failAt = 0
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

function seed(): OpenAgent[] {
  const agents: OpenAgent[] = Array.from({ length: 30 }, (_, i) => ({
    provider: 'codex', model: '', effort: 'high', mode: 'full', cwd: userData,
    sessionId: `session-${i.toString().padStart(4, '0')}`, floating: true,
    order: { status: i % 2 ? 'done' : 'waiting', lastTurnId: `turn-${i}`, since: 100 + i, interactedAt: 50 + i }
  }))
  writeFileSync(snapshotFile, JSON.stringify({ agents }))
  writeFileSync(path.join(userData, 'agent-order.json'), JSON.stringify({
    items: Object.fromEntries(agents.map((a, i) => [a.sessionId!, { turnId: a.order!.lastTurnId, rank: 100 - i }]))
  }))
  return agents
}
const saved = (): OpenAgent[] => JSON.parse(readFileSync(snapshotFile, 'utf8')).agents

it('restaura mais de 24 conversas e conserva a ordem mesmo com telas carregando em outra sequência', async () => {
  const before = seed()
  const agents = await import('../src/main/agentChat')
  expect(await agents.restoreOpenAgents()).toBe(30)
  const infos = agents.agentWindowInfos()
  for (const info of [...infos].reverse()) {
    const original = before.find((a) => a.sessionId === info.sessionId)!
    agents.reportSnapshot(info.uid, {
      ...info, ...original.order, since: 9999, interactedAt: 9999,
      lastUser: 'Pedido', modelId: '', title: 'Conversa'
    } as AgentSnapshot)
  }
  const snaps = agents.agentSnapshots()
  expect(snaps.map(({ since, interactedAt }) => ({ since, interactedAt })))
    .toEqual(before.map((a) => ({ since: a.order!.since, interactedAt: a.order!.interactedAt })))
  expect(snaps.filter((a) => a.status === 'done').map((a) => a.doneOrder))
    .toEqual(before.flatMap((a, i) => a.order!.status === 'done' ? [100 - i] : []))

  agents.shutdownAgents()
  expect(saved()).toEqual(before)
  // Fechar o app e abrir novamente usa os mesmos horários e mantém todas as conversas.
  vi.resetModules()
  const reopened = await import('../src/main/agentChat')
  expect(await reopened.restoreOpenAgents()).toBe(30)
  expect(saved()).toEqual(before)
})

it('uma falha temporária de abertura não apaga a conversa dos próximos reinícios', async () => {
  const before = seed()
  failAt = 5
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const agents = await import('../src/main/agentChat')
  expect(await agents.restoreOpenAgents()).toBe(29)
  expect(error).toHaveBeenCalledWith('Não consegui reabrir um agente:', 'Falha temporária ao criar a janela')
  expect(saved()).toHaveLength(30)
  expect(saved()).toContainEqual(before[4])
  agents.shutdownAgents()

  vi.resetModules()
  failAt = 0
  const reopened = await import('../src/main/agentChat')
  expect(await reopened.restoreOpenAgents()).toBe(30)
  expect(reopened.agentWindows().sort()).toEqual(before.map((a) => a.sessionId!).sort())
})

it('sair enquanto restaura não substitui o retrato completo por uma lista parcial', async () => {
  const before = seed()
  const cli = await import('../src/main/cli')
  let release!: () => void
  vi.mocked(cli.runCli).mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ code: 0, stdout: 'main', stderr: '' })
  }))
  const agents = await import('../src/main/agentChat')
  const restoring = agents.restoreOpenAgents()
  agents.shutdownAgents()
  release()
  await restoring
  expect(saved()).toEqual(before)
  expect(agents.agentWindowInfos()).toHaveLength(1)
})

it('execuções periódicas não entram no retrato usado para restaurar conversas', async () => {
  const agents = await import('../src/main/agentChat')
  const base = { provider: 'codex' as const, model: '', effort: 'high' as const, mode: 'full' as const, cwd: userData, hidden: true }
  await agents.openAgentWindow({ ...base, scheduled: true })
  await agents.openAgentWindow(base)
  agents.shutdownAgents()
  expect(saved()).toHaveLength(1)
})

it('libera somente a janela de execução periódica concluída; preserva perguntas e agentes manuais', async () => {
  const agents = await import('../src/main/agentChat')
  const base = { provider: 'codex' as const, model: '', effort: 'high' as const, mode: 'full' as const, cwd: userData, hidden: true }
  const periodic = await agents.openAgentWindow({ ...base, scheduled: true })
  const manual = await agents.openAgentWindow(base)
  agents.reportStatus(periodic.uid, 'waiting')
  agents.closeFinishedScheduledAgent(periodic.uid)
  expect(agents.agentInfo(periodic.uid)).not.toBeNull()
  agents.reportStatus(periodic.uid, 'done')
  agents.closeFinishedScheduledAgent(periodic.uid)
  expect(agents.agentInfo(periodic.uid)).toBeNull()
  agents.reportStatus(manual.uid, 'done')
  agents.closeFinishedScheduledAgent(manual.uid)
  expect(agents.agentInfo(manual.uid)).not.toBeNull()
})
