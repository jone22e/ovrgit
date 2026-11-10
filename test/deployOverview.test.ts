import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const sources = vi.hoisted(() => ({ recent: [] as string[], services: [] as string[], active: [] as string[] }))
vi.mock('electron', () => ({ shell: {}, webContents: { getAllWebContents: () => [] } }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ recentProjects: sources.recent, services: sources.services.map((cwd) => ({ cwd })) }), saveSettings: vi.fn() }))
vi.mock('../src/main/services', () => ({}))
vi.mock('../src/main/deployAuth', () => ({ requireCode: vi.fn(), requireCodeAlways: vi.fn() }))
vi.mock('../src/main/deployScript', () => ({
  activeRoots: () => sources.active,
  snapshot: (root: string) => ({
    console: 'ready', origin: '', operation: sources.active.includes(root) ? { operation_id: '1', name: 'deploy', started_at: '', release_tag: 'v1', cancellable: true } : null,
    releases: [], current: null, expectedTests: 0, lockSupported: false
  })
}))

const { overview } = await import('../src/main/deploy')
const base = mkdtempSync(path.join(tmpdir(), 'ovseer-deploy-overview-'))
const makeProject = (name: string) => {
  const root = path.join(base, name)
  mkdirSync(path.join(root, '.ovseer'), { recursive: true })
  writeFileSync(path.join(root, '.ovseer', 'deploy.json'), JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'make deploy', steps: [{ id: 'run', title: 'Executar' }] }))
  return root
}
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('visão global dos deploys', () => {
  it('mantém deploy ativo visível após trocar de projeto', async () => {
    const old = makeProject('anterior')
    const current = makeProject('atual')
    const service = makeProject('servico')
    sources.recent = [old, current]
    sources.services = [service]
    sources.active = [old]
    expect((await overview()).map((entry) => entry.root)).toEqual([old, current, service])

    sources.recent = [current]
    sources.services = []
    const entries = await overview()
    expect(entries.map((entry) => entry.root)).toEqual([current, old])
    expect(entries.find((entry) => entry.root === old)?.snapshot.operation?.name).toBe('deploy')
  })
})
