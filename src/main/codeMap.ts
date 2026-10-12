import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { AgentEffort, CliProvider, MapEvent } from '../shared/types'
import {
  aliasesFromTsconfig, buildGraph, chunkFiles, chunkPrompt, dedupeCandidates, fileDigest, isFeatureFile, isMapFile, parseCandidates, parseReduce, reducePrompt,
  type Candidate, type FeatureMap, type ProjectMap, type Resolver
} from '../shared/codeGraph'
import { findBinary, needsShell } from './cli'
import { listSourceFiles } from './sourceFiles'
import { projectMap } from './projectMap'
import { knownModels } from './agentWatch'

/**
 * Mapa funcional do projeto (aba Mapa). A varredura dos imports é feita aqui, em milissegundos, e serve de insumo.
 * "Mapear com IA" roda em pequenos contextos: os arquivos vão em lotes a um pedido avulso do CLI (sem ferramentas,
 * sem sessão, vários em paralelo) que devolve as funcionalidades de cada lote; um último pedido consolida tudo em
 * áreas, funcionalidades e ligações.
 *
 * O mapa funcional fica no repositório, em `.ovseer/map.json` (pequeno, legível, versionável: o time compartilha).
 * O grafo de imports fica em cache na pasta de dados do app: é grande e se recalcula em milissegundos.
 */

const MAX_FILES = 4000
const MAX_BYTES = 400 * 1024
/** Quantos lotes a IA analisa ao mesmo tempo */
const PARALLEL = 6
const CHUNK_TIMEOUT = 150_000
const REDUCE_TIMEOUT = 420_000
const BIN: Record<CliProvider, string> = { claude: 'claude', codex: 'codex', agy: 'agy' }
const NAME: Record<CliProvider, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }

const mapsDir = () => path.join(app.getPath('userData'), 'maps')
const cacheFile = (root: string) => path.join(mapsDir(), `${createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16)}.json`)
/** O mapa funcional, no repositório */
export const MAP_FILE = '.ovseer/map.json'
const repoFile = (root: string) => path.join(root, MAP_FILE)

/** O mapa funcional gravado no repositório (null: ainda não mapeado) */
function readFeatures(root: string): FeatureMap | null {
  try {
    const f = repoFile(root)
    if (!existsSync(f)) return null
    const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<FeatureMap> & { version?: number }
    return j && j.version === 1 && Array.isArray(j.features) && Array.isArray(j.areas)
      ? { provider: String(j.provider ?? ''), model: String(j.model ?? ''), at: Number(j.at) || 0, areas: j.areas, features: j.features, links: Array.isArray(j.links) ? j.links : [] }
      : null
  } catch {
    return null
  }
}

function writeFeatures(root: string, fm: FeatureMap) {
  const f = repoFile(root)
  const next = JSON.stringify({ version: 1, generatedBy: 'Ovseer', ...fm }, null, 2)
  // só grava quando mudou: o arquivo é versionado, e um mapa igual não vira alteração no git
  if (existsSync(f) && readFileSync(f, 'utf8') === next) return
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, next)
}

/** O grafo de imports em cache (null: ainda não varrido) */
function readCache(root: string): ProjectMap | null {
  try {
    const f = cacheFile(root)
    if (!existsSync(f)) return null
    const m = JSON.parse(readFileSync(f, 'utf8')) as ProjectMap
    return m && m.version === 2 && Array.isArray(m.nodes) ? m : null
  } catch {
    return null
  }
}

/** O mapa do projeto: o grafo em cache (ou varrido agora) mais o mapa funcional do repositório */
export async function loadMap(root: string): Promise<ProjectMap | null> {
  const cached = readCache(root)
  let features = readFeatures(root)
  // mapas de antes de o arquivo ir para o repositório: migra o que estava no cache
  if (!features && cached?.features) {
    features = cached.features
    writeFeatures(root, features)
  }
  if (!cached && !features) return null
  const map = cached ?? (await scanProject(root))
  map.features = features ?? undefined
  return map
}

function saveMap(map: ProjectMap) {
  mkdirSync(mapsDir(), { recursive: true })
  const { features, ...graph } = map
  writeFileSync(cacheFile(map.root), JSON.stringify(graph))
  if (features) writeFeatures(map.root, features)
}

/** Apelidos de caminho do projeto (tsconfig e, por cima, o jsconfig) e o módulo Go */
async function resolverFor(root: string, files: Set<string>): Promise<Resolver> {
  let aliases: Record<string, string> = {}
  for (const name of ['tsconfig.json', 'tsconfig.web.json', 'tsconfig.app.json', 'jsconfig.json']) {
    try {
      // tsconfig aceita comentários e vírgulas sobrando: limpa antes de ler
      const raw = (await readFile(path.join(root, name), 'utf8')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')
      aliases = { ...aliasesFromTsconfig(JSON.parse(raw), files), ...aliases }
    } catch {
      /* sem esse arquivo */
    }
  }
  if (!Object.keys(aliases).length) aliases = aliasesFromTsconfig(null, files)
  let goModule: string | undefined
  try {
    goModule = (await readFile(path.join(root, 'go.mod'), 'utf8')).match(/^module\s+(\S+)/m)?.[1]
  } catch {
    /* não é Go */
  }
  return { files, aliases, goModule }
}

/** Lê os arquivos de código do projeto (em lotes: milhares abertos de uma vez estouram o limite do sistema) */
async function readTexts(root: string): Promise<Map<string, string>> {
  const all = (await listSourceFiles(root)).filter(isMapFile).slice(0, MAX_FILES)
  const texts = new Map<string, string>()
  for (let i = 0; i < all.length; i += 64) {
    await Promise.all(
      all.slice(i, i + 64).map(async (rel) => {
        const abs = path.join(root, rel)
        try {
          const st = await stat(abs)
          texts.set(rel, st.size <= MAX_BYTES ? await readFile(abs, 'utf8') : '')
        } catch {
          texts.set(rel, '')
        }
      })
    )
  }
  return texts
}

/** Varre os imports do projeto e grava o mapa, mantendo o mapa funcional que a IA já tinha gerado */
export async function scanProject(root: string, texts?: Map<string, string>): Promise<ProjectMap> {
  texts ??= await readTexts(root)
  const map = buildGraph(root, texts, await resolverFor(root, new Set(texts.keys())))
  map.features = readFeatures(root) ?? undefined
  saveMap(map)
  return map
}

// ---------- pedidos avulsos ao CLI (sem ferramentas, sem sessão) ----------

interface Run {
  root: string
  children: Set<ChildProcessWithoutNullStreams>
  cancelled: boolean
  /** Último andamento publicado: quem abre a aba no meio do mapeamento recebe a barra no ponto certo */
  last: MapEvent | null
}
const runs = new Map<string, Run>()
/** Andamento do mapeamento em curso (null: nenhum) */
export function mappingState(root: string): MapEvent | null {
  const run = runs.get(path.resolve(root))
  return run ? (run.last ?? { type: 'status', text: 'Mapeando…' }) : null
}

/**
 * Um pedido ao CLI com a resposta em texto. Roda numa pasta temporária (sem acesso ao projeto: tudo o que a IA
 * precisa está no pedido) e sem gravar sessão.
 */
async function askOnce(run: Run, bin: string, provider: CliProvider, model: string, effort: AgentEffort | undefined, prompt: string, timeoutMs: number): Promise<string> {
  if (run.cancelled) throw new Error('Interrompido.')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-map-'))
  try {
    let args: string[]
    let outFile: string | null = null
    if (provider === 'claude') {
      args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']
      if (model) args.push('--model', model)
      if (effort) args.push('--effort', effort)
    } else if (provider === 'codex') {
      outFile = path.join(dir, 'out.txt')
      args = ['exec', '--ephemeral', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '--output-last-message', outFile]
      if (model) args.push('-m', model)
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
      args.push('-')
    } else {
      args = ['--output-format', 'json', '--effort', effort ?? 'low', '--mode', 'plan', `--print=${prompt}`]
      if (model) args.push('--model', model)
    }
    const shellMode = needsShell(bin)
    const child = spawn(shellMode ? `"${bin}"` : bin, args, { cwd: dir, shell: shellMode, windowsHide: true, env: { ...process.env, NO_COLOR: '1', ...(provider === 'claude' && effort === 'low' ? { MAX_THINKING_TOKENS: '0' } : {}) } })
    run.children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-8000)))
    child.stdin.on('error', () => undefined)
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', (c) => resolve(c))
      if (provider === 'agy') child.stdin.end()
      else child.stdin.end(prompt)
    })
    clearTimeout(timer)
    run.children.delete(child)
    if (run.cancelled) throw new Error('Interrompido.')
    if (provider === 'claude') {
      const env = JSON.parse(stdout) as { is_error?: boolean; result?: string }
      if (env.is_error) throw new Error(String(env.result ?? 'A IA respondeu com erro.').slice(0, 300))
      return String(env.result ?? '')
    }
    if (provider === 'codex') {
      const text = await readFile(outFile!, 'utf8').catch(() => '')
      if (!text.trim()) {
        const tail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ')
        throw new Error(tail || `Codex saiu com código ${code}`)
      }
      return text
    }
    try {
      const env = JSON.parse(stdout) as { response?: string; result?: { response?: string } }
      return String(env.response ?? env.result?.response ?? stdout)
    } catch {
      return stdout
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Pasta curta para a tela de andamento: os dois últimos nomes ("…/precificacao/campanhas") */
function shortDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir || '(raiz)'
}

/** Resumo curto do projeto para os pedidos (primeiras linhas do mapa do Modo Arquiteto) */
function shortSummary(root: string): string {
  return projectMap(root).split('\n').filter((l) => l.trim()).slice(0, 12).join(' ').replace(/\s+/g, ' ').slice(0, 600)
}

/**
 * Mapeia com IA em pequenos contextos: resumos dos arquivos em lotes (em paralelo) e uma consolidação no fim.
 * O andamento vai por `onEvent` (lotes feitos do total).
 */
export async function mapWithAi(root: string, o: { provider: CliProvider; model: string; effort?: AgentEffort }, onEvent: (ev: MapEvent) => void): Promise<void> {
  const key = path.resolve(root)
  if (runs.has(key)) throw new Error('O mapeamento deste projeto já está em andamento.')
  const provider = o.provider
  const bin = await findBinary(BIN[provider])
  if (!bin) throw new Error(`${NAME[provider]} não encontrado neste computador.`)
  const model = /^[\w.:/-]+$/.test(o.model ?? '') ? o.model : ''
  // os lotes vão para um modelo rápido e barato (o "mini" do catálogo, se houver); a consolidação, para o modelo
  // escolhido, com esforço no máximo médio (alto demora minutos e não melhora a lista)
  const mini = provider === 'codex' ? knownModels().codexCatalog.find((m) => /mini/i.test(m.id))?.id : undefined
  const fastModel = provider === 'claude' ? 'haiku' : (mini ?? model)
  const fastEffort: AgentEffort = 'low'
  const reduceEffort: AgentEffort = !o.effort || ['high', 'xhigh', 'max', 'ultra'].includes(o.effort) ? 'medium' : o.effort
  const run: Run = { root: key, children: new Set(), cancelled: false, last: null }
  runs.set(key, run)
  const emit = onEvent
  onEvent = (ev) => {
    if (ev.type !== 'done') run.last = ev
    emit(ev)
  }
  const finish = (ev: MapEvent) => {
    runs.delete(key)
    emit(ev)
  }
  try {
    onEvent({ type: 'status', text: 'Levantando os imports…' })
    const texts = await readTexts(root)
    const map = await scanProject(root, texts)
    if (!map.nodes.length) throw new Error('Nenhum arquivo de código encontrado no projeto.')
    const digests = [...texts.entries()].filter(([p, t]) => isFeatureFile(p) && t.trim()).map(([p, t]) => ({ path: p, digest: fileDigest(t) }))
    if (!digests.length) throw new Error('Nenhum arquivo com funcionalidades encontrado (só testes, estilos e configurações).')
    const chunks = chunkFiles(digests)
    const total = chunks.length + 1
    const project = path.basename(root)
    const summary = shortSummary(root)
    let done = 0
    let foundCount = 0
    onEvent({ type: 'progress', done, total, text: `${chunks.length} lotes de arquivos para o ${NAME[provider]}`, stage: 'chunks', found: 0 })
    // lotes em paralelo: cada um devolve as candidatas; um lote que falha não derruba o resto
    const found: Candidate[][] = new Array(chunks.length)
    let failures = 0
    let next = 0
    const worker = async () => {
      while (next < chunks.length && !run.cancelled) {
        const i = next++
        const chunk = chunks[i]
        try {
          const text = await askOnce(run, bin, provider, fastModel, fastEffort, chunkPrompt(project, summary, chunk), CHUNK_TIMEOUT)
          found[i] = parseCandidates(text, i, new Set(chunk.map((f) => f.path)))
        } catch (e) {
          if (run.cancelled) throw e
          failures++
          found[i] = []
          console.error(`Mapa: lote ${i} falhou:`, (e as Error).message)
        }
        done++
        foundCount += found[i].length
        const dir = chunk[0].path.includes('/') ? chunk[0].path.slice(0, chunk[0].path.lastIndexOf('/')) : chunk[0].path
        onEvent({ type: 'progress', done, total, text: shortDir(dir), stage: 'chunks', found: foundCount, sample: found[i].slice(0, 4).map((c) => c.name) })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker))
    if (run.cancelled) throw new Error('Interrompido.')
    if (failures === chunks.length) throw new Error('Nenhum lote foi analisado. Confira o login da IA em ⚙ Configurações.')
    const candidates = dedupeCandidates(found.flat())
    if (!candidates.length) throw new Error('A IA não encontrou funcionalidades nos arquivos do projeto.')
    onEvent({ type: 'progress', done, total, text: `${candidates.length} funcionalidades candidatas`, stage: 'reduce', found: candidates.length })
    const reduced = await askOnce(run, bin, provider, model, reduceEffort, reducePrompt(project, summary, candidates), REDUCE_TIMEOUT)
    const features = parseReduce(reduced, candidates)
    if (!features) throw new Error('A consolidação não veio no formato esperado. Tente de novo.')
    map.features = { ...features, provider, model, at: Date.now() }
    saveMap(map)
    finish({ type: 'done', ok: true, map })
  } catch (e) {
    let error = run.cancelled ? 'Interrompido.' : String((e as Error).message ?? e)
    if (/auth|login|oauth|credential|unauthorized|401/i.test(error)) error = 'Sem login. Abra ⚙ Configurações e clique em "Entrar".'
    finish({ type: 'done', ok: false, error })
  }
}

export function cancelMap(root: string) {
  const run = runs.get(path.resolve(root))
  if (!run) return
  run.cancelled = true
  for (const child of run.children) {
    child.kill('SIGTERM')
    setTimeout(() => !child.killed && child.kill('SIGKILL'), 3000)
  }
}
