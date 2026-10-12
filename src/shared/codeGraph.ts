/**
 * Mapa do projeto: cada arquivo de código é um nó e cada import é uma ligação, como o gráfico do Obsidian faz com as
 * notas. A parte exata (quem importa quem) sai de expressões regulares sobre o código; a IA entra por cima, agrupando
 * os arquivos em áreas, descrevendo os mais importantes e apontando ligações que não aparecem nos imports
 * (canais IPC, rotas HTTP, eventos, tabelas).
 */

export interface MapNode {
  /** Caminho relativo à raiz do projeto */
  id: string
  lines: number
}
export interface MapEdge {
  from: string
  to: string
}
/** Área do sistema (módulo de negócio): "Nota fiscal", "Clientes", "Marketplaces" */
export interface MapArea {
  id: string
  name: string
  description?: string
}
/** Funcionalidade: o que o usuário faz ou o sistema faz sozinho ("Imprimir nota fiscal", "Enviar por email") */
export interface MapFeature {
  id: string
  name: string
  area: string
  description?: string
  /** screen, action, job, integration, api, report, config ou outro */
  kind?: string
  /** Arquivos que a implementam (caminhos relativos à raiz) */
  files: string[]
}
export interface MapLink {
  from: string
  to: string
  why?: string
}
/** O mapa funcional, gerado pela IA */
export interface FeatureMap {
  provider: string
  model: string
  at: number
  areas: MapArea[]
  features: MapFeature[]
  links: MapLink[]
}
export interface ProjectMap {
  version: 2
  root: string
  at: number
  /** Arquivos de código e os imports entre eles: insumo para a IA e para ligar funcionalidades */
  nodes: MapNode[]
  edges: MapEdge[]
  features?: FeatureMap
}

/** Extensões que viram nós do mapa */
export const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|php|rb|go|rs|java|kt|swift|cs|c|cc|cpp|h|hpp|css|scss|sass|less|html|sql|graphql|json|ya?ml|toml|sh)$/i
/** Arquivos que nunca interessam, mesmo com extensão de código */
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|.*\.min\.(js|css)|.*\.d\.ts|\.ovseer\/.*)$/i
export const isMapFile = (p: string) => CODE_EXT.test(p) && !SKIP.test(p)

const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json', '.css', '.scss', '.sass', '.less']
const isJsLike = (p: string) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|html)$/i.test(p)

/** Especificadores de import de um arquivo, como escritos no código (sem resolver) */
export function extractImports(text: string, file: string): string[] {
  const out = new Set<string>()
  const add = (s: string | undefined) => s && out.add(s.trim())
  if (isJsLike(file)) {
    for (const m of text.matchAll(/(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]*?\s+from\s+)?['"]([^'"\n]+)['"]/g)) add(m[1])
    for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) add(m[1])
    if (/\.(vue|svelte|html)$/i.test(file)) for (const m of text.matchAll(/<(?:script|link)[^>]*\s(?:src|href)=["']([^"']+)["']/g)) add(m[1])
  } else if (/\.(css|scss|sass|less)$/i.test(file)) {
    for (const m of text.matchAll(/@(?:import|use|forward)\s+(?:url\()?['"]([^'"\n)]+)['"]/g)) add(m[1])
  } else if (/\.py$/i.test(file)) {
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) add(`py:${m[1]}`)
    for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const mod of m[1].split(',')) add(`py:${mod.trim()}`)
  } else if (/\.php$/i.test(file)) {
    for (const m of text.matchAll(/^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm)) add(`php:${m[1]}`)
    for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"\n]+)['"]/g)) add(m[1])
  } else if (/\.rs$/i.test(file)) {
    for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) add(`rs:mod:${m[1]}`)
    for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+crate::([\w:]+)/gm)) add(`rs:crate:${m[1]}`)
  } else if (/\.go$/i.test(file)) {
    for (const m of text.matchAll(/^\s*(?:import\s+)?(?:\w+\s+)?"([^"\n]+)"\s*$/gm)) add(`go:${m[1]}`)
  }
  return [...out]
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
/** Normaliza "a/./b/../c" → "a/c" (caminhos relativos à raiz, com barras normais) */
export function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

export interface Resolver {
  /** Todos os arquivos do projeto (caminhos relativos) */
  files: Set<string>
  /** Apelidos do tsconfig/vite: "@shared/*" → "src/shared/*", "@" → "src" */
  aliases: Record<string, string>
  /** Caminho do módulo Go (go.mod), para resolver imports internos */
  goModule?: string
}

function firstExisting(files: Set<string>, base: string, exts = JS_EXT): string | null {
  if (files.has(base) && !base.endsWith('/')) return base
  for (const e of exts) if (files.has(base + e)) return base + e
  for (const e of exts) if (files.has(`${base}/index${e}`)) return `${base}/index${e}`
  // import "x.js" apontando para x.ts (estilo ESM em TypeScript)
  const m = base.match(/^(.*)\.(js|jsx|mjs)$/)
  if (m) for (const e of ['.ts', '.tsx', '.mts']) if (files.has(m[1] + e)) return m[1] + e
  return null
}

/** Caminho (relativo à raiz) do arquivo que o import aponta, ou null quando é pacote externo ou não foi achado */
export function resolveImport(from: string, spec: string, r: Resolver): string | null {
  const files = r.files
  if (spec.startsWith('py:')) {
    const mod = spec.slice(3)
    const rel = mod.match(/^(\.+)(.*)$/)
    let base: string
    if (rel) {
      let dir = dirOf(from)
      for (let i = 1; i < rel[1].length; i++) dir = dirOf(dir)
      base = normalizePath(`${dir}/${rel[2].replace(/\./g, '/')}`)
    } else base = mod.replace(/\./g, '/')
    const roots = rel ? [''] : ['', 'src/', 'app/', 'lib/']
    for (const root of roots) {
      const b = root + base
      if (files.has(`${b}.py`)) return `${b}.py`
      if (files.has(`${b}/__init__.py`)) return `${b}/__init__.py`
    }
    // "from a.b import c" onde c é um módulo
    if (!rel && mod.includes('.')) return resolveImport(from, `py:${mod.slice(0, mod.lastIndexOf('.'))}`, r)
    return null
  }
  if (spec.startsWith('php:')) {
    const parts = spec.slice(4).split('\\').filter(Boolean)
    if (parts.length < 2) return null
    const tail = parts.slice(1).join('/')
    for (const root of [parts[0].toLowerCase(), parts[0], 'src', 'app', 'lib', '']) {
      const p = root ? `${root}/${tail}.php` : `${tail}.php`
      if (files.has(p)) return p
    }
    return null
  }
  if (spec.startsWith('rs:')) {
    const kind = spec.startsWith('rs:mod:') ? 'mod' : 'crate'
    const name = spec.slice(kind === 'mod' ? 7 : 9)
    if (kind === 'mod') {
      const dir = dirOf(from)
      const self = from.replace(/\.rs$/, '')
      for (const c of [`${dir}/${name}.rs`, `${dir}/${name}/mod.rs`, `${self}/${name}.rs`]) if (files.has(c)) return c
      return null
    }
    const segs = name.split('::')
    for (let n = segs.length; n > 0; n--) {
      const b = `src/${segs.slice(0, n).join('/')}`
      if (files.has(`${b}.rs`)) return `${b}.rs`
      if (files.has(`${b}/mod.rs`)) return `${b}/mod.rs`
    }
    return null
  }
  if (spec.startsWith('go:')) {
    const imp = spec.slice(3)
    if (!r.goModule || !imp.startsWith(r.goModule)) return null
    const dir = imp.slice(r.goModule.length).replace(/^\//, '')
    const inDir = [...files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && dirOf(f) === dir).sort()
    return inDir[0] ?? null
  }
  // JS/TS/CSS
  const clean = spec.replace(/[?#].*$/, '')
  if (!clean) return null
  if (clean.startsWith('.')) return firstExisting(files, normalizePath(`${dirOf(from)}/${clean}`))
  if (clean.startsWith('/')) return firstExisting(files, normalizePath(clean))
  // apelidos: o mais longo primeiro ("@shared" antes de "@")
  for (const [alias, target] of Object.entries(r.aliases).sort((a, b) => b[0].length - a[0].length)) {
    if (clean === alias || clean.startsWith(`${alias}/`)) return firstExisting(files, normalizePath(target + clean.slice(alias.length)))
  }
  if (clean.startsWith('~/')) return firstExisting(files, normalizePath(clean.slice(2)))
  // caminho a partir da raiz sem apelido ("src/x/y")
  const direct = firstExisting(files, normalizePath(clean))
  if (direct && /^(src|app|lib|packages|apps)\//.test(clean)) return direct
  return null
}

/** Apelidos a partir do `paths` do tsconfig ("@shared/*": ["src/shared/*"]) e dos padrões comuns dos bundlers */
export function aliasesFromTsconfig(json: unknown, files: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  const co = (json as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | null)?.compilerOptions
  const base = (co?.baseUrl ?? '.').replace(/^\.\/?/, '').replace(/\/$/, '')
  for (const [k, v] of Object.entries(co?.paths ?? {})) {
    const target = v[0]
    if (!target) continue
    const alias = k.replace(/\/?\*$/, '')
    const to = normalizePath(`${base}/${target.replace(/\/?\*$/, '')}`)
    if (alias) out[alias] = to
  }
  // "@/…" costuma ser src/ (Vite e Nuxt), quando o tsconfig não diz
  if (!out['@']) {
    if ([...files].some((f) => f.startsWith('src/'))) out['@'] = 'src'
  }
  return out
}

/** Monta nós e ligações a partir dos arquivos e dos seus textos */
export function buildGraph(root: string, texts: Map<string, string>, r: Resolver): ProjectMap {
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const seen = new Set<string>()
  for (const [file, text] of texts) {
    nodes.push({ id: file, lines: text ? text.split('\n').length : 0 })
    for (const spec of extractImports(text, file)) {
      const to = resolveImport(file, spec, r)
      if (!to || to === file) continue
      const key = `${file}→${to}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: file, to })
    }
  }
  return { version: 2, root, at: Date.now(), nodes, edges }
}

// ---------- a parte da IA: o mapa funcional, em pequenos contextos ----------
//
// 1. O app escolhe os arquivos que podem ter funcionalidades e tira de cada um um "resumo" (começo do arquivo e as
//    linhas que denunciam rotas, telas, comandos, exports).
// 2. Os arquivos vão em lotes à IA, sem ferramentas, vários em paralelo: cada lote devolve as funcionalidades que
//    aqueles arquivos implementam (candidatas). É o que dá o percentual.
// 3. Um último pedido consolida as candidatas: define as áreas, junta repetidas e aponta as ligações.

/** Arquivos que podem implementar funcionalidades (testes, migrações, estilos e configurações ficam de fora) */
export function isFeatureFile(p: string): boolean {
  if (!isMapFile(p)) return false
  if (/(^|\/)(__tests__|__mocks__|tests?|specs?|migrations?|fixtures|stories|storybook|\.github|\.vscode|\.idea)\//i.test(p)) return false
  if (/\.(test|spec|stories)\.[a-z]+$/i.test(p)) return false
  if (/\.(css|scss|sass|less|sql|json|ya?ml|toml|lock)$/i.test(p)) return false
  return true
}

/** Linhas que denunciam o que o arquivo faz: rotas, telas, comandos, classes, exports, textos de interface */
const SIGNAL = /\b(router|app|server|fastify|express|api)\.(get|post|put|patch|delete|route|use)\s*\(|@(Get|Post|Put|Patch|Delete|Controller|Route|Command|Cron|Schedule|Event|Job)\b|\b(export\s+(default\s+)?(async\s+)?(function|class|const|interface|enum)|def\s+\w+|class\s+\w+|fn\s+\w+|func\s+\w+|public\s+function)\b|\b(cron|schedule|queue|worker|job|webhook|listen|on\(['"]|emit\(['"]|ipcMain\.(handle|on)|invoke\(['"])|<(h1|h2|h3|title|Button|button|form)\b|(title|label|placeholder|aria-label)=["']|\bt\(['"]|Route\s*path|name:\s*['"]|path:\s*['"]/

/** Resumo de um arquivo para a IA: começo do arquivo e as linhas-sinal, com limite de tamanho */
export function fileDigest(text: string, maxChars = 3200): string {
  const lines = text.split('\n')
  const picked = new Map<number, string>()
  const clip = (l: string) => (l.length > 160 ? `${l.slice(0, 157)}…` : l)
  for (let i = 0; i < Math.min(28, lines.length); i++) if (lines[i].trim()) picked.set(i, clip(lines[i].trimEnd()))
  for (let i = 28; i < lines.length && picked.size < 90; i++) if (SIGNAL.test(lines[i])) picked.set(i, clip(lines[i].trim()))
  let out = ''
  let last = -1
  for (const [i, l] of [...picked.entries()].sort((a, b) => a[0] - b[0])) {
    if (last >= 0 && i > last + 1) out += '…\n'
    out += `${l}\n`
    last = i
    if (out.length > maxChars) break
  }
  return out.trimEnd()
}

/** Lotes de arquivos: vizinhos de pasta juntos, até `maxFiles` arquivos ou `maxChars` de resumo por lote */
export function chunkFiles(digests: { path: string; digest: string }[], maxFiles = 30, maxChars = 48_000): { path: string; digest: string }[][] {
  const sorted = [...digests].sort((a, b) => a.path.localeCompare(b.path))
  const out: { path: string; digest: string }[][] = []
  let cur: { path: string; digest: string }[] = []
  let chars = 0
  let dir = ''
  for (const f of sorted) {
    const d = dirOf(f.path)
    const tooBig = cur.length >= maxFiles || chars + f.digest.length > maxChars
    // pasta mudou e o lote já tem um tamanho razoável: fecha para o lote ser coeso
    if (cur.length && (tooBig || (d !== dir && cur.length >= 10))) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(f)
    chars += f.digest.length
    dir = d
  }
  if (cur.length) out.push(cur)
  return out
}

/** Pedido de um lote: as funcionalidades que estes arquivos implementam */
export function chunkPrompt(project: string, summary: string, files: { path: string; digest: string }[]): string {
  const body = files.map((f) => `### ${f.path}\n${f.digest}`).join('\n\n')
  return `Projeto "${project}". ${summary ? `Resumo: ${summary}\n` : ''}
Abaixo estão resumos de ${files.length} arquivos do projeto (começo de cada um e linhas relevantes). Liste as FUNCIONALIDADES do sistema que esses arquivos implementam, em linguagem de quem usa o sistema: o que o usuário faz (tela, ação, relatório) ou o que o sistema faz sozinho (rotina, integração, API, importação). Exemplos: "Imprimir nota fiscal", "Enviar nota por email", "Sincronizar estoque com o Mercado Livre", "Login com Google".

Responda SÓ com um bloco JSON, sem texto antes ou depois:
\`\`\`json
{ "features": [ { "name": "Imprimir nota fiscal", "area": "Nota fiscal", "kind": "action", "description": "Gera o DANFE em PDF para impressão", "files": ["backend/src/fiscal/danfe.ts"] } ] }
\`\`\`

Regras:
- De 0 a 15 funcionalidades. Agrupe o que é a mesma coisa; não liste utilitários técnicos, tipos, configurações ou helpers (eles não são funcionalidades). Se nenhum arquivo implementar uma funcionalidade, devolva "features": [].
- "name": curto, em português do Brasil, começando pelo verbo ou pelo substantivo da ação. "area": o módulo do sistema a que pertence ("Nota fiscal", "Clientes", "Estoque"…). "kind": screen, action, report, job, integration, api, config ou outro. "description": até 15 palavras.
- "files": só caminhos exatos da lista abaixo, os que implementam a funcionalidade.
- Não leia nem peça mais nada: responda com o que está aqui.

${body}`
}

export interface Candidate {
  id: string
  name: string
  area: string
  kind?: string
  description?: string
  files: string[]
}

/** Lê as candidatas de um lote; só caminhos que existem no lote valem */
export function parseCandidates(text: string, chunk: number, allowed: Set<string>): Candidate[] {
  const j = jsonIn(text)
  const list = Array.isArray(j?.features) ? (j!.features as Record<string, unknown>[]) : []
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const out: Candidate[] = []
  list.forEach((f, i) => {
    const name = str(f.name).slice(0, 80)
    const files = [...new Set((Array.isArray(f.files) ? f.files : []).map((p) => str(p).replace(/^\.?\//, '')).filter((p) => allowed.has(p)))]
    if (!name || !files.length) return
    out.push({ id: `c${chunk}-${i}`, name, area: str(f.area).slice(0, 60) || 'Outras', kind: str(f.kind).toLowerCase().slice(0, 20) || undefined, description: str(f.description).slice(0, 200) || undefined, files })
  })
  return out
}

/** Pedido final: áreas, junção das repetidas e ligações */
export function reducePrompt(project: string, summary: string, candidates: Candidate[]): string {
  const lines = candidates.map((c) => `${c.id} | ${c.name} | ${c.area}${c.kind ? ` | ${c.kind}` : ''}${c.description ? ` | ${c.description}` : ''}`)
  return `Projeto "${project}". ${summary ? `Resumo: ${summary}\n` : ''}
Abaixo estão ${candidates.length} funcionalidades candidatas, levantadas lote a lote a partir do código (id | nome | área sugerida | tipo | descrição). Monte o mapa funcional final do sistema.

Responda SÓ com um bloco JSON, sem texto antes ou depois:
\`\`\`json
{
  "areas": [ { "id": "fiscal", "name": "Nota fiscal", "description": "Emissão e gestão das notas fiscais" } ],
  "features": [ { "id": "c3-1", "name": "Imprimir nota fiscal", "area": "fiscal", "merge": ["c7-0", "c12-4"] } ],
  "links": [ { "from": "c3-1", "to": "c3-2", "why": "anexa o PDF gerado" } ]
}
\`\`\`

Regras:
- areas: de 5 a 20 áreas do sistema (módulos de negócio ou do produto), com nomes curtos em português do Brasil; "id" em minúsculas sem espaços nem acentos. Junte áreas sugeridas que são a mesma coisa.
- features: TODAS as candidatas devem entrar, ou como uma funcionalidade ("id" é o id da candidata) ou dentro do "merge" de outra (a mesma funcionalidade vista em lotes diferentes, ou detalhes pequenos demais para serem um nó). Pode melhorar o "name". Cada uma com a sua "area".
- links: ligações entre funcionalidades finais quando uma usa, dispara ou depende da outra (não ligue à própria área). "why" curto. Até 300.
- Use só ids da lista.

${lines.join('\n')}`
}

/** Monta o mapa final a partir da resposta da consolidação e das candidatas */
export function parseReduce(text: string, candidates: Candidate[]): Omit<FeatureMap, 'provider' | 'model' | 'at'> | null {
  const j = jsonIn(text)
  if (!j) return null
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const areas: MapArea[] = arr(j.areas)
    .map((a) => ({ id: slug(str(a.id) || str(a.name)), name: str(a.name) || str(a.id), description: str(a.description).slice(0, 200) || undefined }))
    .filter((a) => a.id && a.name)
  const areaIds = new Set(areas.map((a) => a.id))
  const used = new Set<string>()
  const features: MapFeature[] = []
  for (const f of arr(j.features)) {
    const id = str(f.id)
    const base = byId.get(id)
    if (!base || used.has(id)) continue
    used.add(id)
    const merged = (Array.isArray(f.merge) ? f.merge : []).map(str).filter((m) => byId.has(m) && !used.has(m) && m !== id)
    for (const m of merged) used.add(m)
    const files = [...new Set([base, ...merged.map((m) => byId.get(m)!)].flatMap((c) => c.files))].slice(0, 40)
    let area = slug(str(f.area)) || slug(base.area)
    if (!areaIds.has(area)) {
      areas.push({ id: area || 'outras', name: str(f.area) || base.area || 'Outras' })
      area = area || 'outras'
      areaIds.add(area)
    }
    features.push({ id, name: str(f.name).slice(0, 80) || base.name, area, description: base.description, kind: base.kind, files })
  }
  // candidatas que a IA esqueceu entram do jeito que vieram, na área sugerida
  for (const c of candidates) {
    if (used.has(c.id)) continue
    used.add(c.id)
    let area = slug(c.area) || 'outras'
    if (!areaIds.has(area)) {
      const existing = areas.find((a) => a.name.toLowerCase() === c.area.toLowerCase())
      if (existing) area = existing.id
      else {
        areas.push({ id: area, name: c.area || 'Outras' })
        areaIds.add(area)
      }
    }
    features.push({ id: c.id, name: c.name, area, description: c.description, kind: c.kind, files: c.files })
  }
  if (!features.length) return null
  const ids = new Set(features.map((f) => f.id))
  const seen = new Set<string>()
  const links: MapLink[] = arr(j.links)
    .map((l) => ({ from: str(l.from), to: str(l.to), why: str(l.why).slice(0, 120) || undefined }))
    .filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to && !seen.has(`${l.from}|${l.to}`) && seen.add(`${l.from}|${l.to}`))
  return { areas: areas.filter((a) => features.some((f) => f.area === a.id)), features, links }
}

/** Candidatas com o mesmo nome (ignorando caixa e acentos) viram uma só antes da consolidação */
export function dedupeCandidates(list: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const c of list) {
    const k = slug(c.name)
    const prev = byKey.get(k)
    if (prev) prev.files = [...new Set([...prev.files, ...c.files])].slice(0, 40)
    else byKey.set(k, { ...c, files: [...c.files] })
  }
  return [...byKey.values()]
}

/** O objeto JSON da resposta (dentro de cerca de código ou solto); null se não houver */
function jsonIn(text: string): Record<string, unknown> | null {
  const fence = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).filter((s) => s.trim().startsWith('{'))
  const candidates = [...fence.reverse()]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as Record<string, unknown>
      if (j && typeof j === 'object') return j
    } catch {
      /* próximo */
    }
  }
  return null
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Nó do gráfico funcional: uma área (núcleo) ou uma funcionalidade */
export interface FeatureNode {
  id: string
  name: string
  kind: 'area' | 'feature'
  area: string
  description?: string
  featureKind?: string
  files: string[]
  /** Ligações, fora as da área */
  degree: number
}
export interface FeatureEdge {
  from: string
  to: string
  /** area: funcionalidade à sua área; ai: apontada pela IA; import: deduzida dos imports entre os arquivos */
  kind: 'area' | 'ai' | 'import'
  why?: string
  /** Quantos imports sustentam a ligação deduzida */
  weight?: number
}

/**
 * O gráfico funcional: áreas como núcleos ligados às suas funcionalidades, ligações apontadas pela IA e, por baixo,
 * as deduzidas dos imports (um arquivo de uma funcionalidade importando um de outra). Arquivos compartilhados por
 * muitas funcionalidades (utilitários) não geram ligações, senão tudo se ligaria a tudo.
 */
export function featureGraph(map: ProjectMap): { nodes: FeatureNode[]; edges: FeatureEdge[]; areas: MapArea[] } {
  const fm = map.features
  if (!fm) return { nodes: [], edges: [], areas: [] }
  const known = new Set(map.nodes.map((n) => n.id))
  const areaNodes: FeatureNode[] = fm.areas.map((a) => ({ id: `area:${a.id}`, name: a.name, kind: 'area', area: a.id, description: a.description, files: [], degree: 0 }))
  const featNodes: FeatureNode[] = fm.features.map((f) => ({
    id: f.id, name: f.name, kind: 'feature', area: f.area, description: f.description, featureKind: f.kind,
    files: f.files.filter((p) => known.has(p) || !known.size), degree: 0
  }))
  const edges: FeatureEdge[] = []
  const seen = new Set<string>()
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  for (const f of fm.features) {
    edges.push({ from: `area:${f.area}`, to: f.id, kind: 'area' })
  }
  for (const l of fm.links) {
    if (seen.has(key(l.from, l.to))) continue
    seen.add(key(l.from, l.to))
    edges.push({ from: l.from, to: l.to, kind: 'ai', why: l.why })
  }
  // deduzidas dos imports: só por arquivos de uma funcionalidade só
  const owner = new Map<string, string | null>()
  for (const f of fm.features) for (const p of f.files) owner.set(p, owner.has(p) ? null : f.id)
  const weight = new Map<string, number>()
  for (const e of map.edges) {
    const a = owner.get(e.from)
    const b = owner.get(e.to)
    if (!a || !b || a === b || seen.has(key(a, b))) continue
    weight.set(`${a}|${b}`, (weight.get(`${a}|${b}`) ?? 0) + 1)
  }
  for (const [k, w] of weight) {
    const [a, b] = k.split('|')
    if (seen.has(key(a, b))) continue
    seen.add(key(a, b))
    edges.push({ from: a, to: b, kind: 'import', weight: w })
  }
  const nodes = [...areaNodes, ...featNodes]
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    if (e.kind === 'area') continue
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (a) a.degree++
    if (b) b.degree++
  }
  return { nodes, edges, areas: fm.areas }
}
