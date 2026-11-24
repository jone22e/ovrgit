import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export interface PersistentMcpEndpoint { url: string }

/**
 * O CLI reconecta por HTTP a cada mensagem; o MCP por stdio pertence à conversa e continua vivo.
 * Cada pedido HTTP usa um transporte sem estado, sem encerrar o cliente stdio quando o CLI sai.
 * Inicializar o HTTP não inicia o processo nem acessa o navegador: isso só ocorre ao pedir ferramentas.
 */
export class PersistentMcp {
  readonly ready: Promise<PersistentMcpEndpoint>
  private readonly server: http.Server
  private readonly frontends = new Set<Server>()
  private client?: Client
  private connecting?: Promise<Client>
  private closed = false

  constructor(private readonly options: StdioServerParameters) {
    const route = `/mcp/${randomBytes(24).toString('base64url')}`
    this.server = http.createServer((req, res) => {
      // Só o CLI que recebeu esta URL pode usar a conexão; páginas do navegador não podem chamá-la.
      if (req.headers.origin || req.url !== route) {
        res.writeHead(403).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      void this.handle(req, res)
    })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.once('close', () => reject(new Error('Conexão MCP encerrada.')))
      this.server.listen(0, '127.0.0.1', () => {
        if (this.closed) {
          this.server.close()
          reject(new Error('Conexão MCP encerrada.'))
          return
        }
        const { port } = this.server.address() as AddressInfo
        resolve({ url: `http://127.0.0.1:${port}${route}` })
      })
    })
  }

  private upstream(): Promise<Client> {
    if (this.closed) return Promise.reject(new Error('Conexão MCP encerrada.'))
    if (this.connecting) return this.connecting
    const client = new Client({ name: 'Ovseer', version: '1.0.0' })
    this.client = client
    client.onclose = () => {
      if (this.client !== client) return
      this.client = undefined
      this.connecting = undefined
    }
    const transport = new StdioClientTransport({ ...this.options, stderr: 'ignore' })
    const connecting = client.connect(transport).then(() => client).catch(async (error: unknown) => {
      await client.close().catch(() => {})
      if (this.connecting === connecting) this.connecting = undefined
      throw error
    })
    this.connecting = connecting
    return connecting
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const frontend = new Server({ name: 'Ovseer Chrome', version: '1.0.0' }, { capabilities: { tools: {} } })
    this.frontends.add(frontend)
    frontend.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const client = await this.upstream()
      return client.listTools(request.params, { signal: extra.signal })
    })
    frontend.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const client = await this.upstream()
      return client.callTool(request.params, undefined, { signal: extra.signal, timeout: 30 * 60_000 })
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => {
      this.frontends.delete(frontend)
      void frontend.close().catch(() => {})
    })
    try {
      await frontend.connect(transport)
      await transport.handleRequest(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500).end('Falha na conexão MCP.')
      else res.end()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.server.close()
    this.server.closeAllConnections()
    const clients = [...this.frontends, ...(this.client ? [this.client] : [])]
    this.frontends.clear()
    await Promise.allSettled(clients.map((client) => client.close()))
  }
}
