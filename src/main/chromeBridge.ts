import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'

const str = { type: 'string' }
const num = { type: 'number' }
const tool = (name: string, description: string, properties: Record<string, object> = {}, required: string[] = []): Tool =>
  ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })

export const chromeTools: Tool[] = [
  tool('browser_tabs', 'Liste, selecione, crie ou feche abas. new abre uma aba da conversa automaticamente; url é opcional. Para select/close, use o tabId real retornado na lista. Não use abas de outra conversa.', { action: { enum: ['list', 'select', 'new', 'close'] }, tabId: num, url: str }, ['action']),
  tool('browser_snapshot', 'Leia a árvore de acessibilidade da aba, com referências para interagir. Capture novamente após navegar ou quando uma referência expirar.'),
  tool('browser_navigate', 'Navegue a aba da conversa para uma URL HTTP(S). Se ainda não houver aba, abre uma automaticamente.', { url: str }, ['url']),
  tool('browser_navigate_back', 'Volte uma página no histórico da aba.'),
  tool('browser_click', 'Clique em uma referência da última captura de acessibilidade.', { ref: str, button: { enum: ['left', 'right', 'middle'] }, doubleClick: { type: 'boolean' } }, ['ref']),
  tool('browser_hover', 'Mova o ponteiro até uma referência da última captura.', { ref: str }, ['ref']),
  tool('browser_type', 'Preencha um campo da última captura; opcionalmente envie Enter.', { ref: str, text: str, submit: { type: 'boolean' } }, ['ref', 'text']),
  tool('browser_file_upload', 'Selecione arquivos locais para upload. Clique no botão de envio e depois informe paths com os caminhos absolutos dos arquivos neste computador; o seletor é tratado pela extensão. Opcionalmente use ref de um input type=file da última captura. paths vazio limpa a seleção.', { paths: { type: 'array', items: { type: 'string', minLength: 1 } }, ref: str }, ['paths']),
  tool('browser_fill_form', 'Preencha vários campos. type: textbox, checkbox ou combobox; checkbox usa value true/false como texto.', { fields: { type: 'array', items: { type: 'object', properties: { ref: str, type: { enum: ['textbox', 'checkbox', 'combobox'] }, value: str }, required: ['ref', 'type', 'value'], additionalProperties: false } } }, ['fields']),
  tool('browser_select_option', 'Selecione valores em um elemento select.', { ref: str, values: { type: 'array', items: str } }, ['ref', 'values']),
  tool('browser_press_key', 'Pressione uma tecla, por exemplo Enter, Tab, Escape, ArrowDown ou Control+A.', { key: str }, ['key']),
  tool('browser_scroll', 'Role a página em pixels.', { x: num, y: num }, ['y']),
  tool('browser_evaluate', 'Execute uma função JavaScript na aba da conversa, por exemplo () => document.title. Respeite o pedido do usuário.', { function: str }, ['function']),
  tool('browser_take_screenshot', 'Capture a parte visível da aba da conversa em PNG.'),
  tool('browser_handle_dialog', 'Aceite ou dispense um diálogo JavaScript.', { accept: { type: 'boolean' }, promptText: str }, ['accept']),
  tool('browser_console_messages', 'Leia as mensagens de console capturadas desde o início do controle da aba.'),
  tool('browser_network_requests', 'Liste as requisições HTTP capturadas desde o início do controle da aba.'),
  tool('browser_close', 'Feche a aba atual da conversa.')
]

const validator = new AjvJsonSchemaValidator()
const validators = new Map(chromeTools.map((t) => [t.name, validator.getValidator(t.inputSchema)]))

type Session = { id: string; label: string; state: 'approved' | 'stopped'; requested: boolean; epoch: string }
type Command = { id: string; session: string; epoch: string; name: string; args: Record<string, unknown>; deadline: number }
type Pending = { command: Command; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const secret = () => randomBytes(24).toString('base64url')
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body))
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 12 * 1024 * 1024) throw new Error('Resposta da extensão grande demais.')
    chunks.push(Buffer.from(chunk))
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Pedido inválido.')
  return result as Record<string, unknown>
}

/** Ponte local: credencial da extensão separada das URLs privadas de cada conversa. */
export class ChromeBridge {
  readonly ready: Promise<{ port: number; connection: string }>
  private server: http.Server
  private sessions = new Map<string, Session>()
  private pending = new Map<string, Pending>()
  private queue: Command[] = []
  private poll?: () => void
  private frontends = new Set<Server>()
  private closed = false
  private lastSeen = 0
  private extensionRoute: string

  get connected(): boolean { return Date.now() - this.lastSeen < 35_000 }

  constructor(token = secret(), port = 0) {
    this.extensionRoute = `/extension/${token}`
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo
        resolve({ port: address.port, connection: `http://127.0.0.1:${address.port}${this.extensionRoute}` })
      })
    })
  }

  session(label: string): ChromeSession {
    if (this.closed) throw new Error('Ponte do Chrome encerrada.')
    const info: Session = { id: secret(), label: label.slice(0, 180), state: 'approved', requested: false, epoch: secret() }
    this.sessions.set(info.id, info)
    return new ChromeSession(this, info)
  }

  async call(id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Conversa encerrada.')
    const validate = validators.get(name)
    if (!validate) throw new Error('Ferramenta desconhecida.')
    if (!validate(args).valid) throw new Error('Argumentos inválidos. Consulte o schema da ferramenta.')
    if (signal?.aborted) throw new Error('Interrompido.')
    session.requested = true
    this.poll?.()
    if (session.state === 'stopped') throw new Error('Controle interrompido pelo usuário. Aguarde ele clicar em Retomar na extensão Ovseer antes de continuar.')
    if (Date.now() - this.lastSeen > 35_000) throw new Error('Extensão Ovseer desconectada. Abra a extensão e confira a conexão com o app.')
    if (name === 'browser_file_upload') for (const file of args.paths as string[]) {
      if (!isAbsolute(file) || file.includes('\0')) throw new Error(`Informe um caminho absoluto de arquivo: ${file}`)
      let isFile: boolean
      try { isFile = statSync(file).isFile(); accessSync(file, constants.R_OK) }
      catch { throw new Error(`Arquivo não encontrado ou sem permissão de leitura: ${file}`) }
      if (!isFile) throw new Error(`O caminho deve apontar para um arquivo: ${file}`)
    }
    return new Promise((resolve, reject) => {
      const command: Command = { id: secret(), session: id, epoch: session.epoch, name, args, deadline: Date.now() + 30_000 }
      const cancel = (error: Error) => {
        const pending = this.pending.get(command.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(command.id)
        this.queue = this.queue.filter((c) => c.id !== command.id)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      const abort = () => cancel(new Error('Interrompido.'))
      signal?.addEventListener('abort', abort, { once: true })
      const cleanup = () => signal?.removeEventListener('abort', abort)
      this.pending.set(command.id, { command, resolve: (value) => { cleanup(); resolve(value) }, reject: (error) => { cleanup(); reject(error) }, timer: setTimeout(() => { cleanup(); cancel(new Error('A extensão não respondeu a tempo. Confira a aba no Chrome.')) }, 30_000) })
      this.queue.push(command)
      this.poll?.()
    })
  }

  remove(id: string) {
    this.sessions.delete(id)
    this.cancelSession(id)
    this.poll?.()
  }

  private cancelSession(id: string) {
    for (const [key, pending] of this.pending) if (pending.command.session === id) {
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.reject(new Error('Controle interrompido.'))
    }
    this.queue = this.queue.filter((c) => c.session !== id)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) return json(res, 403, { error: 'Host inválido.' })
      const url = req.url ?? ''
      if (url.startsWith(`${this.extensionRoute}/`)) {
        if (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)) return json(res, 403, { error: 'Origem inválida.' })
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' })
        const data = await body(req)
        this.lastSeen = Date.now()
        if (url === `${this.extensionRoute}/poll`) {
          if (this.poll) return json(res, 409, { error: 'Outro perfil do Chrome já está conectado.' })
          let timer: ReturnType<typeof setTimeout>
          const flush = () => {
            clearTimeout(timer)
            if (this.poll === flush) this.poll = undefined
            if (res.destroyed) return
            const commands = this.queue.splice(0, 1)
            json(res, 200, { sessions: [...this.sessions.values()].filter((s) => s.requested), commands })
          }
          timer = setTimeout(flush, 15_000)
          this.poll = flush
          res.once('close', () => { clearTimeout(timer); if (this.poll === flush) this.poll = undefined })
          if (this.queue.length || data.immediate) flush()
          return
        }
        if (url === `${this.extensionRoute}/permission`) {
          const session = this.sessions.get(String(data.session))
          if (!session) return json(res, 404, { error: 'Conversa encerrada.' })
          if (session.state !== 'approved' || data.approved !== true) session.epoch = secret()
          session.state = data.approved === true ? 'approved' : 'stopped'
          if (session.state === 'stopped') this.cancelSession(session.id)
          this.poll?.()
          return json(res, 200, { ok: true, epoch: session.epoch })
        }
        if (url === `${this.extensionRoute}/result`) {
          const pending = this.pending.get(String(data.id))
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(String(data.id))
            if (data.error) pending.reject(new Error(String(data.error)))
            else pending.resolve(data.result)
          }
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'Rota desconhecida.' })
      }
      // Páginas web não recebem CORS nem podem acessar as ferramentas dos agentes.
      if (req.headers.origin) return json(res, 403, { error: 'Origem inválida.' })
      const match = /^\/mcp\/([\w-]+)(\/tools|\/call)?$/.exec(url)
      const session = match && this.sessions.get(match[1])
      if (!session) return json(res, 404, { error: 'Conversa desconhecida.' })
      if (match[2] === '/tools' && req.method === 'GET') return json(res, 200, { tools: chromeTools })
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' })
      if (match[2] === '/call') {
        const data = await body(req)
        try { return json(res, 200, { result: await this.call(session.id, String(data.name), (data.arguments ?? {}) as Record<string, unknown>) }) }
        catch (e) { return json(res, 400, { error: (e as Error).message }) }
      }
      const frontend = new Server({ name: 'Ovseer Chrome', version: '1.0.0' }, { capabilities: { tools: {} } })
      this.frontends.add(frontend)
      frontend.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: chromeTools }))
      frontend.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        try {
          const value = await this.call(session.id, request.params.name, request.params.arguments ?? {}, extra.signal)
          if (request.params.name === 'browser_take_screenshot') return { content: [{ type: 'image' as const, data: String(value), mimeType: 'image/png' }] }
          return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] }
        } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] } }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => { this.frontends.delete(frontend); void frontend.close().catch(() => {}) })
      await frontend.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: (e as Error).message })
      else res.end()
    }
  }

  async close() {
    this.closed = true
    this.sessions.clear()
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Ovseer encerrado.')) }
    this.pending.clear()
    this.queue = []
    this.poll?.()
    this.server.close()
    this.server.closeAllConnections()
    await Promise.allSettled([...this.frontends].map((f) => f.close()))
  }
}

export class ChromeSession {
  readonly ready: Promise<{ url: string }>
  constructor(private bridge: ChromeBridge, private info: Session) {
    this.ready = bridge.ready.then(({ port }) => ({ url: `http://127.0.0.1:${port}/mcp/${info.id}` }))
  }
  update(label: string) { this.info.label = label.slice(0, 180) }
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal) { return this.bridge.call(this.info.id, name, args, signal) }
  async close() { this.bridge.remove(this.info.id) }
}
