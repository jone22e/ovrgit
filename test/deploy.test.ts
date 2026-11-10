import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONSOLE_STEPS, DEPLOY_STEP_MARKER, buildDeploySteps, formatDuration, lockLine, overallStatus, parseDeployManifest, releaseFailure, stripAnsi,
  type DeployManifest, type DeployRelease
} from '../src/shared/deploy'

const manifest = (): DeployManifest => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'make deploy-console', port: 3098 }))

const release = (phases: DeployRelease['phases'], status = 'running'): DeployRelease => ({ tag: 'aws-2026.11.04.02', status, phases })

describe('manifesto do deploy', () => {
  it('aceita o mínimo e preenche nome e etapas padrão', () => {
    const m = manifest()
    expect(m.name).toBe('Deploy')
    expect(m.kind === 'console' && m.port).toBe(3098)
    expect(m.steps).toEqual(DEFAULT_CONSOLE_STEPS)
  })
  it('recusa JSON inválido, tipo desconhecido, porta e etapas malformadas com mensagens claras', () => {
    expect(() => parseDeployManifest('{')).toThrow(/JSON válido/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'x' }))).toThrow(/"ovseer": "deploy"/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'ssh', start: 'x', port: 3000 }))).toThrow(/não suportado: ssh/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'x', port: 80 }))).toThrow(/entre 1024 e 65535/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'x', port: 3000, steps: [{ id: 'a' }] }))).toThrow(/Etapa 1/)
  })
  it('tipo script exige comando e etapas; etapa sem "phases" usa o próprio id', () => {
    const m = parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'make deploy', steps: [{ id: 'backup', title: 'Backup' }, { id: 'envio', title: 'Envio', phases: ['rsync'] }] }))
    expect(m.kind).toBe('script')
    if (m.kind === 'script') expect(m.command).toBe('make deploy')
    expect(m.steps).toEqual([{ id: 'backup', title: 'Backup', phases: ['backup'] }, { id: 'envio', title: 'Envio', phases: ['rsync'] }])
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'x' }))).toThrow(/precisa da lista "steps"/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', steps: [{ id: 'a', title: 'A' }] }))).toThrow(/"command"/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'x', steps: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }))).toThrow(/repetido/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'x', steps: [{ id: 'com espaço', title: 'A' }] }))).toThrow(/Etapa 1/)
  })
  it('alvos: ids válidos e únicos, e {target} no comando', () => {
    const m = parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'make deploy-aws LOJA={target}', steps: [{ id: 'a', title: 'A' }], targets: [{ id: 'brasiltec', title: 'Brasiltec' }, { id: 'source', title: ' Source ' }] }))
    expect(m.kind === 'script' && m.targets).toEqual([{ id: 'brasiltec', title: 'Brasiltec' }, { id: 'source', title: 'Source' }])
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'make deploy', steps: [{ id: 'a', title: 'A' }], targets: [{ id: 'x', title: 'X' }] }))).toThrow(/conter \{target\}/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'make deploy {target}', steps: [{ id: 'a', title: 'A' }] }))).toThrow(/não declara "targets"/)
    expect(() => parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'x {target}', steps: [{ id: 'a', title: 'A' }], targets: [{ id: 'x', title: 'X' }, { id: 'x', title: 'Y' }] }))).toThrow(/repetido/)
  })
  it('marcador de etapa na saída do script, mesmo com cores', () => {
    expect('[ovseer] etapa backup'.match(DEPLOY_STEP_MARKER)?.[1]).toBe('backup')
    expect('[ovseer] etapa troca-de-trafego  '.match(DEPLOY_STEP_MARKER)?.[1]).toBe('troca-de-trafego')
    expect('# [ovseer] etapa backup'.match(DEPLOY_STEP_MARKER)).toBeNull()
    expect(stripAnsi('\x1b[32m[ovseer] etapa build\x1b[0m').match(DEPLOY_STEP_MARKER)?.[1]).toBe('build')
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
    expect(by.tests.detail).toBe('1416 / 1425 · 0 falhas')
    expect(by.tests.subs).toEqual([
      { id: 'marketplace.tap', title: 'marketplace', status: 'completed', detail: '529 / 529' },
      { id: 'stock.tap', title: 'stock', status: 'completed', detail: '200 / 265' }
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
    expect(by.tests.detail).toBe('3 / 10 · 1 falha')
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
  it('mostra a falha da orquestração local mesmo sem uma fase falhada na lista', () => {
    const r = release({
      preflight: { status: 'completed' },
      plan: { status: 'completed' },
      tests: { status: 'completed', result: { total: 1453, passed: 1444, failed: 0, groups: [{ file: 'venda-editor.tap', total: 230, passed: 221, failed: 0 }] } }
    }, 'failed')
    r.failure_phase = 'orquestracao_local'
    r.failure_detail = 'retomada exige o commit da release em checkout'
    const steps = buildDeploySteps(manifest(), r)
    expect(steps[2]).toMatchObject({ status: 'completed', detail: '1444 / 1453 · 0 falhas' })
    expect(steps[2].subs[0].status).toBe('completed')
    expect(steps.some((s) => s.status === 'failed')).toBe(false)
    expect(releaseFailure(r, steps)).toEqual({ title: 'Orquestração local', detail: 'retomada exige o commit da release em checkout' })
    const running = release({ tests: { status: 'running', result: { total: 230, passed: 221, failed: 0, groups: [{ file: 'venda-editor.tap', total: 230, passed: 221, failed: 0 }] } } })
    expect(buildDeploySteps(manifest(), running)[2].subs[0].status).toBe('running')
  })
  it('usa o erro da etapa quando o console não envia o detalhe da falha', () => {
    const r = release({ tests: { status: 'failed', error: 'testes falharam' } }, 'failed')
    expect(releaseFailure(r, buildDeploySteps(manifest(), r))).toEqual({ title: 'Testes', detail: 'testes falharam' })
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
