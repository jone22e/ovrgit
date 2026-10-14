import { afterAll, describe, expect, it } from 'vitest'
import type { Service, ServiceState } from '../src/shared/types'
import { resolveService, startAgentApi, stopAgentApi } from '../src/main/agentApi'

const services: Service[] = [
  { id: 'db', name: 'Banco de Dados', command: 'ssh -L 5432:db:5432 host', cwd: '' },
  { id: 'web', name: 'Servidor Web', command: 'npm run dev', cwd: '/p' }
]
const states = new Map<string, ServiceState>()
const log = new Map<string, string[]>()
const backend = {
  services: () => services,
  states: () => services.map((s) => states.get(s.id) ?? { id: s.id, status: 'stopped' as const }),
  async start(id: string) {
    states.set(id, { id, status: 'running', startedAt: Date.now(), ports: [] })
    log.set(id, ['conectando…'])
    // a porta abre um pouco depois, como num túnel de verdade
    setTimeout(() => {
      states.set(id, { id, status: 'running', startedAt: Date.now(), ports: [5432] })
      log.set(id, ['conectando…', 'Waiting for connections'])
    }, 300)
  },
  stop(id: string) {
    states.set(id, { id, status: 'exited', exitCode: 0 })
  },
  output: (id: string, n: number) => (log.get(id) ?? []).slice(-n),
  create(s: { name: string; command: string; cwd: string; autostart: boolean }) {
    const svc: Service = { id: `s${services.length + 1}`, name: s.name, command: s.command, cwd: s.cwd, autostart: s.autostart || undefined }
    services.push(svc)
    return svc
  }
}
const api = await startAgentApi(backend)
afterAll(stopAgentApi)
const call = (path: string, method = 'GET', token = api.token) => fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` } })

describe('API local dos serviços para os agentes', () => {
  it('acha pelo id ou pelo nome, sem acento nem maiúsculas', () => {
    expect(resolveService(services, 'db')?.id).toBe('db')
    expect(resolveService(services, 'banco de dados')?.id).toBe('db')
    expect(resolveService(services, 'BANCO DE DADOS ')?.id).toBe('db')
    expect(resolveService(services, 'outro')).toBeUndefined()
  })
  it('exige o token', async () => {
    expect((await call('/services', 'GET', 'errado')).status).toBe(401)
  })
  it('lista, liga esperando a porta, lê a saída e desliga', async () => {
    const list = (await (await call('/services')).json()) as { services: { name: string; status: string }[] }
    expect(list.services.map((s) => `${s.name}:${s.status}`)).toEqual(['Banco de Dados:stopped', 'Servidor Web:stopped'])

    const started = (await (await call('/services/Banco%20de%20Dados/start?wait=5', 'POST')).json()) as { status: string; ports: number[]; ready: boolean; log: string[] }
    expect(started).toMatchObject({ status: 'running', ports: [5432], ready: true })
    expect(started.log).toContain('Waiting for connections')

    const out = (await (await call('/services/db/log?lines=1')).json()) as { log: string[] }
    expect(out.log).toEqual(['Waiting for connections'])

    const stopped = (await (await call('/services/db/stop', 'POST')).json()) as { status: string; exitCode: number }
    expect(stopped).toMatchObject({ status: 'exited', exitCode: 0 })
  })
  it('cadastra um serviço novo; nome repetido não duplica; sem nome ou comando, 400', async () => {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${api.port}/services`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const r = await post({ name: 'Túnel do Redis', command: 'ssh -L 6379:redis:6379 host', cwd: '/p', autostart: true })
    expect(r.status).toBe(201)
    expect((await r.json()) as object).toMatchObject({ name: 'Túnel do Redis', status: 'stopped', created: true })
    expect(services.find((s) => s.name === 'Túnel do Redis')).toMatchObject({ command: 'ssh -L 6379:redis:6379 host', cwd: '/p', autostart: true })
    const dup = await post({ name: 'tunel do redis', command: 'outro' })
    expect(dup.status).toBe(409)
    expect(services.filter((s) => /redis/i.test(s.name))).toHaveLength(1)
    expect((await post({ name: 'Sem comando' })).status).toBe(400)
  })
  it('serviço ou ação desconhecidos: 404 com a lista do que existe', async () => {
    const r = await call('/services/nada/start', 'POST')
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: string }).error).toContain('Banco de Dados')
    expect((await call('/services/db/reiniciar', 'POST')).status).toBe(404)
    expect((await call('/outra')).status).toBe(404)
  })
})
