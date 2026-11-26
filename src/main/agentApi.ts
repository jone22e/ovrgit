import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Service, ServiceState } from '../shared/types'
import { ScheduleError, type Scheduler } from './schedules'
import { validSimulatorAction, type SimulatorAction, type SimulatorCatalog, type SimulatorDevice } from '../shared/simulator'

/**
 * API local para os agentes mexerem nos serviços do Ovseer sem passar pela tela: listar, ligar (esperando a porta
 * abrir), desligar, ler a saída e cadastrar um serviço novo. Só responde em 127.0.0.1 e exige um token sorteado a
 * cada abertura do app, que vai para o agente na nota de serviços (agentChat.servicesNote). Editar e remover
 * continuam só na tela: um serviço sobrevive à conversa, e essa decisão é do usuário.
 */

export interface AgentApiBackend {
  schedules?: Pick<Scheduler, 'list' | 'create' | 'update' | 'enable' | 'remove' | 'run'>
  services(): Service[]
  states(): ServiceState[]
  start(id: string): Promise<void>
  stop(id: string): void
  /** Últimas linhas da saída (sem códigos de cor) */
  output(id: string, lines: number): string[]
  /** Cadastra um serviço novo (entra na lista do menu Serviços) */
  create(s: { name: string; command: string; cwd: string; autostart: boolean }): Service | Promise<Service>
  simulators?: {
    list(): Promise<SimulatorCatalog & { connected: string[] }>
    start(id: string): Promise<SimulatorDevice>
    stop(id: string): Promise<void>
    screenshot(id: string): Promise<Buffer>
    action(id: string, action: SimulatorAction): Promise<void>
    install(id: string, path: string): Promise<{ installed: boolean; appId?: string }>
    launch(id: string, appId: string): Promise<{ launched: boolean; appId: string }>
    openUrl(id: string, url: string): Promise<{ opened: boolean }>
  }
}

/** Corpo JSON de um pedido (limitado a 64 KB) */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8')
      if (data.length > 65_536) {
        reject(new Error('Corpo grande demais.'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export interface AgentApiInfo {
  port: number
  token: string
}

let info: AgentApiInfo | null = null
let server: http.Server | null = null
/** Porta e token da API, para a nota que vai ao agente (null: API desligada) */
export const agentApiInfo = () => info

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
/** Acha o serviço pelo id ou pelo nome (sem diferenciar acento nem maiúsculas) */
export function resolveService(list: Service[], key: string): Service | undefined {
  const k = fold(key)
  return list.find((s) => s.id === key) ?? list.find((s) => fold(s.name) === k)
}

/** Estado de um serviço como a API devolve */
export function serviceView(s: Service, st: ServiceState | undefined) {
  return { id: s.id, name: s.name, cwd: s.cwd || null, status: st?.status ?? 'stopped', ports: st?.ports ?? [], startedAt: st?.startedAt ?? null, exitCode: st?.exitCode ?? null, lastLine: st?.lastLine ?? null }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function startAgentApi(backend: AgentApiBackend): Promise<AgentApiInfo> {
  stopAgentApi()
  const token = randomBytes(24).toString('base64url')
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${token}`) return json(res, 401, { error: 'Token inválido. Use o cabeçalho Authorization: Bearer <token> da nota de serviços.' })
      const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
      if (parts[0] === 'schedules') {
        const schedules = backend.schedules
        if (!schedules) return json(res, 503, { error: 'Agendamentos indisponíveis nesta instância.' })
        if (parts.length > 3) return json(res, 404, { error: 'Rota de agendamento desconhecida.' })
        const id = parts[1], action = parts[2]
        if (req.method === 'GET' && !action) {
          if (!id) return json(res, 200, { schedules: schedules.list() })
          const task = schedules.list().find((t) => t.id === id)
          return task ? json(res, 200, task) : json(res, 404, { error: 'Agendamento não encontrado.' })
        }
        if ((req.method === 'POST' && !id) || (req.method === 'PUT' && id && !action)) {
          let body: unknown
          try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'Envie um objeto JSON válido.' }) }
          return json(res, id ? 200 : 201, id ? schedules.update(id, body) : schedules.create(body))
        }
        if (req.method === 'DELETE' && id && !action) {
          schedules.remove(id)
          return json(res, 200, { removed: true })
        }
        if (req.method === 'POST' && id) {
          if (action === 'pause' || action === 'resume') return json(res, 200, schedules.enable(id, action === 'resume'))
          if (action === 'run') return json(res, 202, schedules.run(id))
        }
        return json(res, 405, { error: 'Use GET/POST /schedules, GET/PUT/DELETE /schedules/{id}, POST /schedules/{id}/{pause,resume,run}.' })
      }
      if (parts[0] === 'simulators') {
        const sim = backend.simulators
        if (!sim) return json(res, 503, { error: 'Controle de simuladores indisponível nesta instância.' })
        if (parts.length === 1) {
          if (req.method !== 'GET') return json(res, 405, { error: 'Use GET para descobrir os simuladores.' })
          return json(res, 200, await sim.list())
        }
        const id = parts[1], action = parts[2]
        if (parts.length !== 3 || !id || id.length > 200) return json(res, 404, { error: 'Use /simulators/{id}/{start,stop,screenshot,action,install,launch,open-url}.' })
        if (action === 'screenshot') {
          if (req.method !== 'GET') return json(res, 405, { error: 'Use GET para capturar a tela.' })
          const png = await sim.screenshot(id)
          if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return json(res, 502, { error: 'O simulador não retornou um PNG válido.' })
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store', 'X-Image-Width': png.readUInt32BE(16), 'X-Image-Height': png.readUInt32BE(20) })
          res.end(png)
          return
        }
        if (!['start', 'stop', 'action', 'install', 'launch', 'open-url'].includes(action)) return json(res, 404, { error: 'Operação de simulador desconhecida.' })
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST para esta operação.' })
        if (action === 'start') return json(res, 200, await sim.start(id))
        if (action === 'stop') { await sim.stop(id); return json(res, 200, { stopped: true }) }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'Envie um objeto JSON válido.' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Envie um objeto JSON.' })
        const data = body as Record<string, unknown>
        if (action === 'action') {
          if (!validSimulatorAction(body)) return json(res, 400, { error: 'Ação inválida. Coordenadas devem estar entre 0 e 1; text aceita ASCII de até 1000 caracteres.' })
          await sim.action(id, body)
          return json(res, 200, { applied: true })
        }
        if (action === 'install') {
          if (typeof data.path !== 'string' || !data.path.trim() || data.path.length > 4096) return json(res, 400, { error: 'Informe path absoluto para o .app ou .apk.' })
          return json(res, 200, await sim.install(id, data.path))
        }
        if (action === 'launch') {
          if (typeof data.appId !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(data.appId) || data.appId.length > 255) return json(res, 400, { error: 'appId inválido.' })
          return json(res, 200, await sim.launch(id, data.appId))
        }
        if (typeof data.url !== 'string' || !data.url.trim() || data.url.length > 4096) return json(res, 400, { error: 'Informe uma URL válida.' })
        return json(res, 200, await sim.openUrl(id, data.url))
      }
      if (parts[0] !== 'services') return json(res, 404, { error: 'Rota desconhecida. Rotas: GET /services, POST /services (cadastrar), GET /services/{nome}, POST /services/{nome}/start?wait=30, POST /services/{nome}/stop, GET /services/{nome}/log?lines=40' })
      const list = backend.services()
      const stateOf = (id: string) => backend.states().find((x) => x.id === id)
      if (parts.length === 1) {
        if (req.method === 'POST') {
          // cadastro: nome, comando e pasta; sem repetir um nome que já existe (um agente tentando de novo não duplica)
          let body: Record<string, unknown>
          try {
            body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
          } catch {
            return json(res, 400, { error: 'Corpo inválido: mande JSON com name, command e, se quiser, cwd e autostart.' })
          }
          const name = String(body.name ?? '').trim().slice(0, 80)
          const command = String(body.command ?? '').trim().slice(0, 4000)
          const cwd = String(body.cwd ?? '').trim()
          if (!name || !command) return json(res, 400, { error: 'Faltou name ou command.' })
          const dup = resolveService(list, name)
          if (dup) return json(res, 409, { error: `Já existe um serviço chamado "${dup.name}".`, ...serviceView(dup, stateOf(dup.id)) })
          const created = await backend.create({ name, command, cwd, autostart: body.autostart === true })
          return json(res, 201, { ...serviceView(created, undefined), created: true })
        }
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET, ou POST para cadastrar.' })
        return json(res, 200, { services: list.map((s) => serviceView(s, stateOf(s.id))) })
      }
      const s = resolveService(list, parts[1])
      if (!s) return json(res, 404, { error: `Serviço "${parts[1]}" não encontrado. Cadastrados: ${list.map((x) => x.name).join(', ') || 'nenhum'}.` })
      const action = parts[2] ?? ''
      if (!action) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' })
        return json(res, 200, serviceView(s, stateOf(s.id)))
      }
      if (action === 'start') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' })
        await backend.start(s.id)
        // espera (até `wait` segundos) o serviço abrir uma porta ou sair: quem chama quer usá-lo logo em seguida
        const wait = Math.min(120, Math.max(0, Number(url.searchParams.get('wait') ?? 20) || 0))
        const end = Date.now() + wait * 1000
        let st = stateOf(s.id)
        while (Date.now() < end && st?.status === 'running' && !st.ports?.length) {
          await sleep(500)
          st = stateOf(s.id)
        }
        const view = serviceView(s, st)
        return json(res, 200, { ...view, ready: view.status === 'running' && view.ports.length > 0, log: backend.output(s.id, 20) })
      }
      if (action === 'stop') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' })
        backend.stop(s.id)
        await sleep(300)
        return json(res, 200, serviceView(s, stateOf(s.id)))
      }
      if (action === 'log') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' })
        const lines = Math.min(400, Math.max(1, Number(url.searchParams.get('lines') ?? 40) || 40))
        return json(res, 200, { ...serviceView(s, stateOf(s.id)), log: backend.output(s.id, lines) })
      }
      return json(res, 404, { error: `Ação "${action}" desconhecida. Ações: start, stop, log.` })
    } catch (e) {
      json(res, e instanceof ScheduleError ? e.status : 500, { error: String((e as Error)?.message ?? e) })
    }
  })
  server = srv
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      info = { port: (srv.address() as AddressInfo).port, token }
      resolve(info)
    })
  })
}

export function stopAgentApi() {
  server?.close()
  server = null
  info = null
}
