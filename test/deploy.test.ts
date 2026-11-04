import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONSOLE_STEPS, buildDeploySteps, formatDuration, lockLine, overallStatus, parseDeployManifest,
  type DeployManifest, type DeployRelease
} from '../src/shared/deploy'

const manifest = (): DeployManifest => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'make deploy-console', port: 3098 }))

const release = (phases: DeployRelease['phases'], status = 'running'): DeployRelease => ({ tag: 'aws-2026.11.04.02', status, phases })

describe('manifesto do deploy', () => {
  it('aceita o mínimo e preenche nome e etapas padrão', () => {
    const m = manifest()
    expect(m.name).toBe('Deploy')
    expect(m.port).toBe(3098)
    expect(m.steps).toEqual(DEFAULT_CONSOLE_STEPS)
  })
  it('recusa JSON inválido, tipo desconhecido, porta e etapas malformadas com mensagens claras', () => {
    expect(() => parseDeployManifest('{')).toThrow(/JSON válido/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'x' }))).toThrow(/"ovseer": "deploy"/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', start: 'x', port: 3000 }))).toThrow(/não suportado: script/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'x', port: 80 }))).toThrow(/entre 1024 e 65535/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'x', port: 3000, steps: [{ id: 'a' }] }))).toThrow(/Etapa 1/)
  })
  it('aceita etapas próprias', () => {
    const m = parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', name: ' Publicar ', start: 'npm start', port: 4000, steps: [{ id: 'b', title: 'Build', phases: ['build'] }] }))
    expect(m.name).toBe('Publicar')
    expect(m.steps).toEqual([{ id: 'b', title: 'Build', phases: ['build'] }])
  })
})

describe('etapas numeradas', () => {
  it('sem release, tudo pendente', () => {
    const steps = buildDeploySteps(manifest(), null)
    expect(steps).toHaveLength(10)
    expect(steps.every((s) => s.status === 'pending')).toBe(true)
    expect(steps[2]).toMatchObject({ index: 3, title: 'Testes' })
    expect(overallStatus(steps)).toBe('pending')
  })
  it('agrupa fases do motor: concluídas, puladas, em andamento e pendentes', () => {
    const r = release({
      preflight: { status: 'completed', started_at: '2026-11-04T11:58:35Z', completed_at: '2026-11-04T11:58:35Z' },
      plan: { status: 'completed' },
      tests: { status: 'completed', result: { total: 1425, passed: 1416, failed: 0, groups: [{ file: 'marketplace.tap', total: 529, passed: 529, failed: 0 }, { file: 'stock.tap', total: 265, passed: 200, failed: 0 }] } },
      publish_release_tag: { status: 'completed' },
      publish_images: { status: 'completed' },
      workers_preflight: { status: 'completed' },
      prepare_workers: { status: 'completed' },
      typesense: { status: 'skipped', result: { reason: 'deploy rotineiro nao usa Typesense-first' } },
      workers_typesense: { status: 'skipped', result: { reason: 'deploy rotineiro nao exige worker de busca antecipado' } },
      prepare_systems: { status: 'completed', started_at: '2026-11-04T12:10:00Z', completed_at: '2026-11-04T12:11:00Z' },
      deploy_systems: { status: 'running', started_at: '2026-11-04T12:11:00Z' }
    })
    const steps = buildDeploySteps(manifest(), r)
    const by = Object.fromEntries(steps.map((s) => [s.id, s]))
    expect(by.tests.status).toBe('completed')
    expect(by.tests.detail).toBe('1416 / 1425')
    expect(by.tests.subs).toEqual([
      { id: 'marketplace.tap', title: 'marketplace', status: 'completed', detail: '529 / 529' },
      { id: 'stock.tap', title: 'stock', status: 'running', detail: '200 / 265' }
    ])
    expect(by['workers-prep'].status).toBe('completed')
    expect(by.systems.status).toBe('running')
    expect(by.systems.startedAt).toBe('2026-11-04T12:10:00Z')
    expect(by.systems.endedAt).toBeUndefined()
    expect(by.systems.phases).toEqual(['prepare_systems', 'deploy_systems'])
    expect(by.workers.status).toBe('pending')
    expect(overallStatus(steps)).toBe('running')
  })
  it('etapa toda pulada mostra o motivo e etapa com falha carrega o erro', () => {
    const r = release({
      tests: { status: 'failed', failed_at: '2026-11-04T12:00:00Z', error: 'make falhou com codigo 2', result: { total: 10, passed: 3, failed: 1, groups: [{ file: 'pix.tap', total: 4, passed: 3, failed: 1 }] } },
      typesense: { status: 'skipped', result: { reason: 'x' } }
    }, 'failed')
    const steps = buildDeploySteps(manifest(), r)
    const by = Object.fromEntries(steps.map((s) => [s.id, s]))
    expect(by.tests.status).toBe('failed')
    expect(by.tests.error).toBe('make falhou com codigo 2')
    expect(by.tests.detail).toBe('3 / 10 · 1 falhas')
    expect(by.tests.subs[0].status).toBe('failed')
    expect(overallStatus(steps)).toBe('failed')
  })
  it('release interrompida não deixa etapa parcial como "em andamento"', () => {
    const r = release({ prepare_systems: { status: 'completed' } }, 'failed')
    const by = Object.fromEntries(buildDeploySteps(manifest(), r).map((s) => [s.id, s]))
    expect(by.systems.status).toBe('failed')
    const live = release({ prepare_systems: { status: 'completed' } }, 'running')
    expect(buildDeploySteps(manifest(), live).find((s) => s.id === 'systems')?.status).toBe('running')
  })
})

describe('textos', () => {
  it('duração em mm:ss e hh:mm:ss', () => {
    expect(formatDuration(5000)).toBe('00:05')
    expect(formatDuration(18 * 60_000 + 55_000)).toBe('18:55')
    expect(formatDuration(3_600_000 + 61_000)).toBe('01:01:01')
  })
  it('linha da trava diz quem, onde e há quanto tempo', () => {
    const now = Date.parse('2026-11-04T12:18:35Z')
    const line = lockLine({ status: 'active', stale: false, location: 's3://b/k', checked_at: '', lock: { tag: 'aws-2026.11.04.02', operation: 'deploy', host: 'mac-ana', user: 'ana', acquired_at: '2026-11-04T11:58:35Z' } }, now)
    expect(line).toBe('Deploy de aws-2026.11.04.02 em andamento no computador mac-ana (ana) há 20:00')
    expect(lockLine({ status: 'free', stale: false, location: '', checked_at: '', lock: null })).toMatch(/Nenhum deploy/)
    expect(lockLine({ status: 'active', stale: true, location: '', checked_at: '', lock: { operation: 'resume', tag: 't', host: 'h', user: 'u' } })).toMatch(/^Retomada de t .*possivelmente abandonado$/)
  })
})
