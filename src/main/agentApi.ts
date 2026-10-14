import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Service, ServiceState } from '../shared/types'

/**
 * API local para os agentes mexerem nos serviços do Ovseer sem passar pela tela: listar, ligar (esperando a porta
 * abrir), desligar e ler a saída. Só responde em 127.0.0.1 e exige um token sorteado a cada abertura do app, que
 * vai para o agente na nota de serviços (agentChat.servicesNote). Serviços são os que o usuário cadastrou no menu
 * Serviços: a API não cria nem edita nenhum.
 */

export interface AgentApiBackend {
  services(): Service[]
  states(): ServiceState[]
  start(id: string): Promise<void>
  stop(id: string): void
  /** Últimas linhas da saída (sem códigos de cor) */
  output(id: string, lines: number): string[]
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
      if (parts[0] !== 'services') return json(res, 404, { error: 'Rota desconhecida. Rotas: GET /services, GET /services/{nome}, POST /services/{nome}/start?wait=30, POST /services/{nome}/stop, GET /services/{nome}/log?lines=40' })
      const list = backend.services()
      const stateOf = (id: string) => backend.states().find((x) => x.id === id)
      if (parts.length === 1) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' })
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
      json(res, 500, { error: String((e as Error)?.message ?? e) })
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
