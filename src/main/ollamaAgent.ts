import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentChatEvent, AgentEffort, AgentMode, AgentTurn } from '../shared/types'
import { runCli } from './cli'
import { getSettings } from './settings'

type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; images?: string[]; tool_calls?: ToolCall[]; tool_name?: string }
type ToolCall = { function: { name: string; arguments: Record<string, unknown> | string } }
type Tool = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] } } }

const tool = (name: string, description: string, properties: Tool['function']['parameters']['properties'], required: string[]): Tool =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })

const READ_TOOLS: Tool[] = [
  tool('read_file', 'Leia o conteúdo de um arquivo de texto. Caminhos relativos partem da pasta do projeto.', { path: { type: 'string' } }, ['path']),
  tool('list_files', 'Liste arquivos do projeto. Use um caminho relativo opcional.', { path: { type: 'string' } }, []),
  tool('search_text', 'Busque texto nos arquivos do projeto.', { query: { type: 'string' }, path: { type: 'string' } }, ['query'])
]
const WRITE_TOOLS: Tool[] = [
  tool('run_command', 'Execute um comando de terminal na pasta do projeto. Pode ler e modificar arquivos.', { command: { type: 'string' } }, ['command']),
  tool('apply_patch', 'Aplique um patch unificado com caminhos relativos à pasta do projeto.', { patch: { type: 'string' } }, ['patch'])
]

const limit = (s: string, n = 20_000) => s.length > n ? `${s.slice(0, n)}\n… saída truncada` : s
const arg = (a: Record<string, unknown>, key: string) => typeof a[key] === 'string' ? a[key] as string : ''
const SKIP = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.venv'])
async function files(target: string, max = 3000): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string) {
    if (out.length >= max) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= max) break
      const file = path.join(dir, entry.name)
      if (entry.isDirectory() && !SKIP.has(entry.name)) await visit(file)
      else if (entry.isFile()) out.push(file)
    }
  }
  const info = await stat(target)
  if (info.isFile()) return [target]
  await visit(target)
  return out
}

async function execute(name: string, a: Record<string, unknown>, cwd: string, mode: AgentMode, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('Interrompido.')
  const target = path.resolve(cwd, arg(a, 'path') || '.')
  if (name === 'read_file') {
    if (!arg(a, 'path')) return 'Informe o caminho do arquivo.'
    try { return limit(await readFile(target, 'utf8'), 80_000) } catch (e) { return String(e) }
  }
  if (name === 'list_files') {
    try { return limit((await files(target)).map((file) => path.relative(cwd, file)).join('\n')) } catch (e) { return String(e) }
  }
  if (name === 'search_text') {
    const query = arg(a, 'query')
    if (!query) return 'Informe o texto para buscar.'
    const matches: string[] = []
    try {
      for (const file of await files(target)) {
        if (signal.aborted) throw new Error('Interrompido.')
        if ((await stat(file)).size > 300_000) continue
        const lines = (await readFile(file, 'utf8')).split('\n')
        for (const [index, line] of lines.entries()) {
          if (line.includes(query)) matches.push(`${path.relative(cwd, file)}:${index + 1}:${line.slice(0, 300)}`)
          if (matches.length >= 100) return limit(matches.join('\n'))
        }
      }
      return matches.length ? limit(matches.join('\n')) : 'Nenhum resultado.'
    } catch (e) { return String(e) }
  }
  if (mode !== 'full') return 'Ferramentas de escrita e execução não estão disponíveis no modo somente leitura.'
  if (name === 'run_command') {
    const command = arg(a, 'command')
    if (!command) return 'Informe o comando.'
    const win = process.platform === 'win32'
    const r = await runCli(win ? 'cmd.exe' : '/bin/zsh', win ? ['/d', '/s', '/c', command] : ['-lc', command], '', cwd, 120_000, signal)
    return limit(`${r.code === 0 ? '' : 'Erro: '}Código de saída: ${r.code}\n${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`)
  }
  if (name === 'apply_patch') {
    const patch = arg(a, 'patch')
    if (!patch) return 'Informe o patch.'
    const r = await runCli('git', ['apply', '--whitespace=nowarn', '-'], patch, cwd, 30_000, signal)
    return limit(r.code === 0 ? 'Patch aplicado.' : `Falha ao aplicar patch: ${r.stderr || r.stdout}`)
  }
  return `Ferramenta desconhecida: ${name}`
}

function historyMessages(turns: AgentTurn[]): Message[] {
  return turns.slice(-12).flatMap((t): Message[] => {
    const answer = t.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim()
    return t.user && answer && !t.running ? [{ role: 'user', content: t.user }, { role: 'assistant', content: answer }] : []
  })
}

async function request(model: string, effort: AgentEffort, messages: Message[], tools: Tool[], signal: AbortSignal): Promise<{ message: Message; prompt_eval_count?: number; eval_count?: number }> {
  const url = getSettings().ollamaUrl.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
      body: JSON.stringify({ model, stream: false, think: /^SparkLLM\/Spark-X2\.6-4B(?::|$)/i.test(model) ? (effort === 'high' ? 'high' : 'low') : false,
        options: { num_ctx: 32768 }, messages, ...(tools.length ? { tools } : {}) })
    })
  } catch (e) {
    if (signal.aborted) throw new Error('Interrompido.')
    throw new Error(`Não foi possível conectar ao Ollama em ${url}: ${String(e)}`)
  }
  const body = await response.json().catch(() => ({})) as { message?: Message; error?: string; prompt_eval_count?: number; eval_count?: number }
  if (!response.ok || !body.message) throw new Error(body.error || `Ollama respondeu ${response.status}.`)
  return { message: body.message, prompt_eval_count: body.prompt_eval_count, eval_count: body.eval_count }
}

export async function askOllama(model: string, prompt: string, signal: AbortSignal = new AbortController().signal, images: string[] = []): Promise<string> {
  const r = await request(model, 'low', [{ role: 'user', content: prompt, ...(images.length ? { images } : {}) }], [], signal)
  return r.message.content.trim()
}

export async function runOllamaTurn(o: {
  model: string; effort: AgentEffort; mode: AgentMode; cwd: string; prompt: string; turns: AgentTurn[];
  images?: string[]; instructions?: string; signal: AbortSignal; onEvent: (ev: AgentChatEvent) => void
}): Promise<void> {
  const settings = getSettings()
  const rules = await readFile(path.join(o.cwd, 'AGENTS.md'), 'utf8').catch(() => '')
  const system = [
    'Você é um agente de programação no aplicativo Ovseer. Trabalhe na pasta do projeto informada. Use as ferramentas para verificar fatos antes de afirmar ou alterar. Responda em português do Brasil.',
    `Pasta do projeto: ${o.cwd}`,
    o.mode === 'full' ? 'Pode executar comandos e editar arquivos conforme o pedido do usuário.' : 'Modo somente leitura: use as ferramentas para verificar fatos e responda ao pedido. Não altere arquivos.',
    settings.agentInstructions?.trim(), rules ? `Instruções do projeto (AGENTS.md):\n${rules.slice(0, 25_000)}` : '', o.instructions
  ].filter(Boolean).join('\n\n')
  const messages: Message[] = [{ role: 'system', content: system }, ...historyMessages(o.turns), { role: 'user', content: o.prompt, ...(o.images?.length ? { images: o.images } : {}) }]
  const tools = o.mode === 'full' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
  for (let step = 0; step < 20; step++) {
    if (o.signal.aborted) throw new Error('Interrompido.')
    const r = await request(o.model, o.effort, messages, tools, o.signal)
    const msg = r.message
    messages.push(msg)
    if (msg.content) o.onEvent({ type: 'text', delta: msg.content })
    const calls = msg.tool_calls ?? []
    if (!calls.length) {
      if (r.prompt_eval_count) o.onEvent({ type: 'context', context: { used: r.prompt_eval_count + (r.eval_count ?? 0), window: 32768 } })
      return
    }
    for (const [index, call] of calls.entries()) {
      const name = call.function?.name ?? ''
      const raw = call.function?.arguments
      let args: Record<string, unknown> = {}
      try { args = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw && typeof raw === 'object' ? raw : {} }
      catch { args = {} }
      const id = `${step}-${index}`
      const detail = String(args.path ?? args.query ?? args.command ?? '').slice(0, 160)
      o.onEvent({ type: 'tool', id, name, title: name.replace(/_/g, ' '), detail })
      let output: string
      try { output = await execute(name, args, o.cwd, o.mode, o.signal) } catch (e) { output = String(e) }
      o.onEvent({ type: 'toolResult', id, ok: !/^Falha|^Error|^Erro/.test(output), output })
      messages.push({ role: 'tool', content: output, tool_name: name })
    }
  }
  throw new Error('O agente local atingiu o limite de etapas desta resposta.')
}
