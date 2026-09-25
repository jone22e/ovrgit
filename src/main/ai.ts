import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AiProvider, Analysis, ChangeGroup, CommitType, FileChange, ProviderStatus, Settings } from '../shared/types'
import { contextHash } from './analysisStore'
import { findBinary, needsShell, runCli } from './cli'
import { heuristicGroups, slugify } from '../shared/parse'

const TYPES: CommitType[] = ['feat', 'fix', 'refactor', 'test', 'chore', 'docs', 'style', 'perf']

const SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { type: 'string', enum: TYPES },
          summary: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          commit: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'type', 'summary', 'bullets', 'commit', 'files']
      }
    },
    commit: { type: 'string' },
    branch: { type: 'string' }
  },
  required: ['groups', 'commit', 'branch']
}

const SYSTEM = `Você é um assistente que analisa alterações de código em um repositório Git.
Responda SEMPRE em português do Brasil e SOMENTE com JSON válido no formato pedido.

Regras:
- Agrupe os arquivos por mudança FUNCIONAL (ex.: "Nota de entrada", "Devoluções", "Permissões"), não por pasta.
- Use no máximo 10 grupos: junte mudanças pequenas relacionadas; testes ficam no grupo do código que testam.
- Todo arquivo da lista deve aparecer em exatamente um grupo, com o caminho idêntico ao informado.
- "title": nome curto do assunto (2 a 4 palavras).
- "summary": uma frase curta do que foi feito.
- "bullets": 1 a 3 itens curtos no particípio (ex.: "Adicionada rota de nota manual").
- "type": feat | fix | refactor | test | chore | docs | style | perf.
- "commit" do grupo: Conventional Commits, verbo no presente, minúsculo, com acentuação correta, até 72 caracteres (ex.: "feat: adiciona fluxo de criação de nota de entrada manual").
- Seja direto: não explique, só preencha o JSON.
- "commit" geral: uma mensagem única que descreva todas as alterações juntas.
- "branch": nome curto em kebab-case, sem o prefixo "feature/" (ex.: "nota-entrada-devolucoes").`

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  signal?.addEventListener('abort', () => ctrl.abort())
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json()
  } catch (e) {
    if ((e as Error).name === 'AbortError')
      throw new Error(signal?.aborted ? 'CANCELADO' : 'A IA demorou demais para responder.')
    throw e
  } finally {
    clearTimeout(t)
  }
}

export async function listModels(settings: Settings): Promise<string[]> {
  const data = (await fetchJson(`${trimUrl(settings.ollamaUrl)}/api/tags`, {}, 4000)) as {
    models?: { name: string }[]
  }
  return (data.models ?? []).map((m) => m.name)
}

const trimUrl = (u: string) => u.replace(/\/+$/, '')

interface RawGroup {
  title?: unknown
  type?: unknown
  summary?: unknown
  bullets?: unknown
  commit?: unknown
  files?: unknown
}

/** Valida a resposta da IA contra a lista real de arquivos; o que ela esquecer vai para "Outros". */
export function normalizeAnalysis(raw: unknown, files: FileChange[]): Analysis {
  const obj = (raw ?? {}) as { groups?: RawGroup[]; commit?: unknown; branch?: unknown }
  const known = new Set(files.map((f) => f.path))
  const used = new Set<string>()
  const groups: ChangeGroup[] = []

  for (const g of Array.isArray(obj.groups) ? obj.groups : []) {
    const gFiles = (Array.isArray(g.files) ? g.files : [])
      .map(String)
      .map((p) => p.replace(/^\.?\//, ''))
      .filter((p) => known.has(p) && !used.has(p))
    if (!gFiles.length) continue
    gFiles.forEach((p) => used.add(p))
    const type = TYPES.includes(g.type as CommitType) ? (g.type as CommitType) : 'chore'
    const title = String(g.title ?? 'Alterações').trim() || 'Alterações'
    groups.push({
      id: `g${groups.length}`,
      title,
      type,
      summary: String(g.summary ?? '').trim(),
      bullets: (Array.isArray(g.bullets) ? g.bullets : []).map(String).filter(Boolean).slice(0, 5),
      commit: String(g.commit ?? '').trim() || `${type}: ${title.toLowerCase()}`,
      files: gFiles
    })
  }

  const leftovers = files.filter((f) => !used.has(f.path))
  if (leftovers.length) {
    for (const h of heuristicGroups(leftovers)) {
      groups.push({ ...h, id: `g${groups.length}`, title: groups.length ? `${h.title} (outros)` : h.title })
    }
  }

  const commit = String(obj.commit ?? '').trim() || groups[0]?.commit || 'chore: atualiza arquivos'
  const branch = slugify(String(obj.branch ?? '')) || slugify(groups[0]?.title ?? 'nova-feature')
  return { groups, commit, branch, source: 'ai' }
}

export function heuristicAnalysis(files: FileChange[], warning?: string): Analysis {
  const groups = heuristicGroups(files)
  const commit =
    groups.length === 1
      ? groups[0].commit
      : `chore: atualiza ${groups
          .slice(0, 3)
          .map((g) => g.title.toLowerCase())
          .join(', ')}`
  return { groups, commit, branch: slugify(groups.map((g) => g.title).slice(0, 2).join('-')), source: 'heuristic', warning }
}

const CLI_TIMEOUT = 300_000

/** Um pedido à IA: instruções de sistema, formato da resposta e o que fazer com o contexto. */
interface Task {
  system: string
  schema: object
  instruction: string
}

const ANALYSIS_TASK: Task = { system: SYSTEM, schema: SCHEMA, instruction: 'Analise as alterações abaixo.' }

const MESSAGE_TASK: Task = {
  system: `Você escreve mensagens de commit para um repositório Git.
Responda SEMPRE em português do Brasil e SOMENTE com JSON válido no formato pedido.
- Uma única mensagem que descreva TODAS as alterações juntas.
- Conventional Commits (feat, fix, refactor, test, chore, docs, style, perf), verbo no presente, minúsculo,
  com acentuação correta, até 72 caracteres na primeira linha.
- Se houver vários assuntos, a primeira linha resume e depois de uma linha em branco vêm até 4 itens "- ...".
- Seja direto: não explique, só preencha o JSON.`,
  schema: {
    type: 'object',
    properties: { commit: { type: 'string' } },
    required: ['commit']
  },
  instruction: 'Escreva a mensagem de commit para as alterações abaixo.'
}

function userPrompt(task: Task, context: string, opts: { withSystem: boolean; withSchema: boolean }): string {
  const system = opts.withSystem ? `${task.system}\n\n` : ''
  const schema = opts.withSchema
    ? `\n\nResponda somente com um objeto JSON que siga este JSON Schema, sem markdown:\n${JSON.stringify(task.schema)}`
    : ''
  return `${system}${task.instruction}${schema}\n\n${context}`
}

let controller: AbortController | null = null

/** Cancela a análise em andamento (mata o CLI ou aborta a requisição). */
export function cancelAnalysis() {
  controller?.abort()
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('a resposta não contém JSON')
  return JSON.parse(text.slice(start, end + 1))
}

const safeModel = (m: string) => (/^[\w.:/-]+$/.test(m) ? m : '')

async function viaOllama(task: Task, settings: Settings, context: string, signal: AbortSignal): Promise<unknown> {
  if (!settings.model) throw new Error('nenhum modelo do Ollama configurado')
  const data = (await fetchJson(
    `${trimUrl(settings.ollamaUrl)}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        format: task.schema,
        options: { temperature: 0.2, num_ctx: 16384 },
        messages: [
          { role: 'system', content: task.system },
          { role: 'user', content: `${task.instruction}\n\n${context}` }
        ]
      })
    },
    180_000,
    signal
  )) as { message?: { content?: string } }
  return extractJson(data.message?.content ?? '')
}

/** Claude Code em modo não interativo: usa o login da assinatura Claude, sem API key. */
async function viaClaude(task: Task, settings: Settings, context: string, signal: AbortSignal): Promise<unknown> {
  const bin = await findBinary('claude')
  if (!bin) throw new Error('Claude Code não encontrado. Instale em claude.com/claude-code e faça login rodando "claude".')
  // No Windows com claude.cmd o shell não suporta argumentos longos/JSON: tudo vai no stdin
  const structured = !needsShell(bin)
  const args = [
    '-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '',
    '--strict-mcp-config', '--disable-slash-commands'
  ]
  // Substitui o system prompt enorme do Claude Code pelo nosso: bem menos tokens de entrada
  if (structured) args.push('--system-prompt', task.system, '--json-schema', JSON.stringify(task.schema))
  const model = safeModel(settings.claudeModel)
  if (model) args.push('--model', model)

  const prompt = userPrompt(task, context, { withSystem: !structured, withSchema: !structured })
  const r = await runCli(bin, args, prompt, os.tmpdir(), CLI_TIMEOUT, signal)
  let env: { is_error?: boolean; result?: string; structured_output?: unknown }
  try {
    env = JSON.parse(r.stdout)
  } catch {
    throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `claude saiu com código ${r.code}`)
  }
  if (env.is_error) {
    const msg = String(env.result ?? 'erro desconhecido')
    if (/auth|login|oauth|credential/i.test(msg)) throw new Error('sem login. Abra ⚙ Configurações e clique em "Entrar"')
    throw new Error(msg)
  }
  return env.structured_output ?? extractJson(env.result ?? '')
}

/** Codex CLI: usa o login da conta ChatGPT, sem API key. */
async function viaCodex(task: Task, settings: Settings, context: string, signal: AbortSignal): Promise<unknown> {
  const bin = await findBinary('codex')
  if (!bin) throw new Error('Codex CLI não encontrado. Instale com "npm i -g @openai/codex" e rode "codex login".')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovrgit-'))
  try {
    const schemaFile = path.join(dir, 'schema.json')
    const outFile = path.join(dir, 'out.txt')
    await writeFile(schemaFile, JSON.stringify(codexSchema(task.schema)))
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-schema', schemaFile, '--output-last-message', outFile]
    const model = safeModel(settings.codexModel)
    if (model) args.push('--model', model)
    args.push('-')
    const prompt = userPrompt(task, context, { withSystem: true, withSchema: false })
    const r = await runCli(bin, args, prompt, dir, CLI_TIMEOUT, signal)
    let text = ''
    try {
      text = await readFile(outFile, 'utf8')
    } catch {
      /* sem arquivo de saída: provavelmente falhou */
    }
    if (!text.trim()) {
      const msg = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')
      if (/login|auth|unauthorized|401/i.test(msg)) throw new Error('sem login. Abra ⚙ Configurações e clique em "Entrar"')
      throw new Error(msg || `codex saiu com código ${r.code}`)
    }
    return extractJson(text)
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** O modo estrito do Codex exige additionalProperties:false e todos os campos em "required". */
function codexSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(codexSchema)
  if (!schema || typeof schema !== 'object') return schema
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) o[k] = codexSchema(v)
  if (o.type === 'object' && o.properties) {
    o.additionalProperties = false
    o.required = Object.keys(o.properties as object)
  }
  return o
}

const PROVIDER_NAME: Record<AiProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
  none: 'IA'
}

/** Identifica o conteúdo analisado (e com qual IA): se mudar, a análise salva está desatualizada. */
export function analysisHash(settings: Settings, context: string): string {
  const model = { claude: settings.claudeModel, codex: settings.codexModel, ollama: settings.model, none: '' }[
    settings.provider
  ]
  return contextHash([settings.provider, model, context])
}

export interface AnalyzeOptions {
  /** Hash do contexto da última análise salva: se igual, reaproveita sem chamar a IA */
  cached?: { hash: string; analysis: Analysis } | null
  force?: boolean
}

export async function analyze(
  settings: Settings,
  files: FileChange[],
  context: string,
  opts: AnalyzeOptions = {}
): Promise<Analysis & { hash?: string }> {
  if (!files.length) return { groups: [], commit: '', branch: '', source: 'heuristic' }
  if (settings.provider === 'none') return heuristicAnalysis(files, 'IA desativada — agrupado por pasta.')

  const hash = analysisHash(settings, context)
  if (!opts.force && opts.cached?.hash === hash && opts.cached.analysis.source === 'ai') {
    return { ...opts.cached.analysis, hash, warning: undefined }
  }

  controller?.abort()
  const ctrl = new AbortController()
  controller = ctrl
  try {
    const raw = await runTask(ANALYSIS_TASK, settings, context, ctrl.signal)
    return { ...normalizeAnalysis(raw, files), provider: PROVIDER_NAME[settings.provider], hash }
  } catch (e) {
    let msg = (e as Error).message
    if (ctrl.signal.aborted || msg === 'CANCELADO') throw new Error('CANCELADO')
    if (settings.provider === 'ollama' && /fetch failed|ECONNREFUSED/i.test(msg))
      msg = `Ollama não está rodando em ${settings.ollamaUrl}`
    return heuristicAnalysis(files, `${PROVIDER_NAME[settings.provider]}: ${msg} — agrupado por pasta.`)
  } finally {
    if (controller === ctrl) controller = null
  }
}

function runTask(task: Task, settings: Settings, context: string, signal: AbortSignal): Promise<unknown> {
  if (settings.provider === 'claude') return viaClaude(task, settings, context, signal)
  if (settings.provider === 'codex') return viaCodex(task, settings, context, signal)
  return viaOllama(task, settings, context, signal)
}

/** Gera uma mensagem de commit única para os arquivos informados (botão de IA na caixa de mensagem). */
export async function commitMessage(settings: Settings, context: string): Promise<string> {
  if (settings.provider === 'none') throw new Error('Escolha uma IA nas Configurações.')
  controller?.abort()
  const ctrl = new AbortController()
  controller = ctrl
  try {
    const raw = (await runTask(MESSAGE_TASK, settings, context, ctrl.signal)) as { commit?: unknown }
    const msg = String(raw?.commit ?? '').trim()
    if (!msg) throw new Error('A IA não devolveu uma mensagem.')
    return msg
  } catch (e) {
    const msg = (e as Error).message
    if (ctrl.signal.aborted || msg === 'CANCELADO') throw new Error('CANCELADO')
    if (settings.provider === 'ollama' && /fetch failed|ECONNREFUSED/i.test(msg))
      throw new Error(`Ollama não está rodando em ${settings.ollamaUrl}`)
    throw new Error(`${PROVIDER_NAME[settings.provider]}: ${msg}`)
  } finally {
    if (controller === ctrl) controller = null
  }
}

export async function detectProviders(settings: Settings): Promise<ProviderStatus> {
  const [claude, codex, ollama] = await Promise.all([
    findBinary('claude'),
    findBinary('codex'),
    listModels(settings).then(
      () => true,
      () => false
    )
  ])
  return { claude, codex, ollama }
}
