import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Mapa do projeto para a descoberta do Modo Arquiteto: o que o agente levaria minutos para levantar sozinho
 * (pastas, tecnologias, scripts, telas e módulos pelos nomes dos arquivos, começo do README) o app monta em
 * milissegundos e entrega pronto no pedido. Só nomes e trechos curtos; nada de conteúdo de código.
 */

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', 'vendor', 'target', 'tmp', 'temp', 'coverage',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.turbo', '.cache', '.DS_Store', 'release', 'bin', 'obj', '.gradle', 'Pods'
])
/** Pastas cujos arquivos dizem quais telas e módulos existem */
const INTERESTING = /^(pages?|views?|screens?|routes?|router|components?|controllers?|models?|entities|services?|modules?|features?|api|handlers?|stores?|migrations?|schemas?)$/i
const MAX_TREE_LINES = 160
const MAX_FILES_PER_DIR = 40
const MAX_GROUPS = 24

const cache = new Map<string, { at: number; text: string }>()
const designCache = new Map<string, { at: number; text: string }>()
const TTL_MS = 2 * 60_000

/** Bibliotecas de interface e de estilo reconhecidas pelas dependências */
const UI_LIBS = /^(tailwindcss|@tailwindcss\/.+|daisyui|bootstrap|bootstrap-vue.*|react-bootstrap|vuetify|quasar|element-plus|element-ui|ant-design-vue|antd|primevue|primereact|naive-ui|@mui\/material|@chakra-ui\/.+|@mantine\/core|@radix-ui\/themes|@headlessui\/.+|@nextui-org\/.+|@heroui\/.+|bulma|styled-components|@emotion\/react|sass|less|stylus|lucide-.+|@heroicons\/.+|@fortawesome\/.+|@phosphor-icons\/.+|@tabler\/icons.*|shadcn.*|class-variance-authority)$/
const STYLE_EXT = /\.(css|scss|sass|less|styl)$/i
/** Arquivos de estilo que costumam guardar a identidade visual, do mais ao menos provável */
const STYLE_RANK = [/^_?(design-)?tokens?\./i, /^_?(theme|themes)\./i, /^_?(variables?|vars)\./i, /^_?(colors?|palette)\./i, /^(globals?|base|root)\./i, /^(main|index|app|styles?)\./i]
const MAX_STYLE_FILES = 4
const MAX_VARS = 70

function list(dir: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = []
  const files: string[] = []
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue
      if (e.isDirectory()) dirs.push(e.name)
      else if (e.isFile()) files.push(e.name)
    }
  } catch {
    /* sem permissão: pasta vazia para o mapa */
  }
  return { dirs: dirs.sort(), files: files.sort() }
}

function readHead(file: string, maxChars: number): string {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) return ''
    return readFileSync(file, 'utf8').slice(0, maxChars)
  } catch {
    return ''
  }
}

export function projectMap(cwd: string): string {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text
  const out: string[] = [`Projeto: ${path.basename(cwd)}`]

  // tecnologias e scripts, pelos manifestos da raiz
  const pkgRaw = readHead(path.join(cwd, 'package.json'), 200_000)
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown }
      const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
      if (deps.length) out.push(`Dependências (package.json): ${deps.slice(0, 60).join(', ')}${deps.length > 60 ? ', …' : ''}`)
      const scripts = Object.keys(pkg.scripts ?? {})
      if (scripts.length) out.push(`Scripts: ${scripts.slice(0, 30).join(', ')}`)
      if (pkg.workspaces) out.push('Monorepo: sim (workspaces)')
    } catch {
      /* package.json inválido */
    }
  }
  const manifests = ['composer.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile', 'docker-compose.yml', 'Makefile', 'tsconfig.json']
    .filter((f) => existsSync(path.join(cwd, f)))
  if (manifests.length) out.push(`Outros arquivos da raiz: ${manifests.join(', ')}`)

  // árvore de pastas (3 níveis) e, de passagem, as pastas que dizem quais telas e módulos existem
  const tree: string[] = []
  const groups: string[] = []
  const walk = (dir: string, depth: number, rel: string) => {
    const { dirs, files } = list(dir)
    if (rel && INTERESTING.test(path.basename(dir)) && files.length && groups.length < MAX_GROUPS) {
      groups.push(`${rel}: ${files.slice(0, MAX_FILES_PER_DIR).join(', ')}${files.length > MAX_FILES_PER_DIR ? `, … (+${files.length - MAX_FILES_PER_DIR})` : ''}`)
    }
    for (const d of dirs) {
      const childRel = rel ? `${rel}/${d}` : d
      if (tree.length < MAX_TREE_LINES && depth < 3) tree.push(`${'  '.repeat(depth)}${d}/`)
      // além do terceiro nível só continua atrás das pastas interessantes, e sem listar na árvore
      if (depth < 5) walk(path.join(dir, d), depth + 1, childRel)
    }
  }
  walk(cwd, 0, '')
  if (tree.length) out.push(`Pastas:\n${tree.join('\n')}${tree.length >= MAX_TREE_LINES ? '\n…' : ''}`)
  if (groups.length) out.push(`Telas e módulos existentes (pelos nomes dos arquivos):\n${groups.map((g) => `- ${g}`).join('\n')}`)

  // começo do README e das instruções do projeto
  for (const f of ['README.md', 'readme.md', 'Readme.md']) {
    const head = readHead(path.join(cwd, f), 1800)
    if (head.trim()) {
      out.push(`README (começo):\n${head.trim()}`)
      break
    }
  }
  const design = designMap(cwd)
  if (design) out.push(design)
  const text = `<mapa_do_projeto>\n${out.join('\n\n')}\n</mapa_do_projeto>`
  cache.set(cwd, { at: Date.now(), text })
  return text
}

/**
 * Identidade visual do projeto, levantada pelo app: bibliotecas de interface, arquivos de estilo e as variáveis
 * de cor, tipografia e espaçamento que eles declaram. Vai no mapa da descoberta (para o entendimento já dizer que
 * design as telas novas seguem) e no pedido do conceito visual (para o designer partir do que existe).
 * Vazio se o projeto não tem nada de estilo.
 */
export function designMap(cwd: string): string {
  const hit = designCache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text
  const out: string[] = []

  const pkgRaw = readHead(path.join(cwd, 'package.json'), 200_000)
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const libs = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter((d) => UI_LIBS.test(d))
      if (libs.length) out.push(`Bibliotecas de interface e estilo: ${libs.slice(0, 20).join(', ')}`)
    } catch {
      /* package.json inválido */
    }
  }

  // arquivos de estilo (e a configuração do Tailwind), até 5 níveis
  const styles: { rel: string; rank: number }[] = []
  const walk = (dir: string, depth: number, rel: string) => {
    const { dirs, files } = list(dir)
    for (const f of files) {
      const isTailwind = /^tailwind\.config\.(js|cjs|mjs|ts)$/i.test(f)
      if (!isTailwind && !STYLE_EXT.test(f)) continue
      const rank = isTailwind ? 0 : STYLE_RANK.findIndex((r) => r.test(f))
      if (styles.length < 200) styles.push({ rel: rel ? `${rel}/${f}` : f, rank: rank < 0 ? STYLE_RANK.length : rank })
    }
    if (depth < 5) for (const d of dirs) walk(path.join(dir, d), depth + 1, rel ? `${rel}/${d}` : d)
  }
  walk(cwd, 0, '')
  styles.sort((a, b) => a.rank - b.rank || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
  const main = styles.filter((s) => s.rank < STYLE_RANK.length).slice(0, MAX_STYLE_FILES)
  if (styles.length) out.push(`Arquivos de estilo: ${(main.length ? main : styles.slice(0, MAX_STYLE_FILES)).map((s) => s.rel).join(', ')}${styles.length > MAX_STYLE_FILES ? ` (de ${styles.length})` : ''}`)

  // variáveis declaradas nos arquivos principais (CSS: --nome; Sass/Less: $nome, @nome) e as fontes usadas
  const vars = new Map<string, string>()
  const fonts = new Set<string>()
  for (const s of main) {
    const text = readHead(path.join(cwd, s.rel), 60_000)
    if (/^tailwind\.config\./i.test(path.basename(s.rel))) {
      // o trecho do tema diz as cores e fontes próprias do projeto
      const theme = /theme\s*:\s*\{[\s\S]{0,1800}/.exec(text)
      if (theme) out.push(`Tema do Tailwind (${s.rel}, começo):\n${theme[0].trim()}`)
      continue
    }
    for (const m of text.matchAll(/(?:^|[\s;{])(--[\w-]+|\$[\w-]+|@[\w-]+)\s*:\s*([^;{}\n]{1,80});/g)) {
      if (vars.size >= MAX_VARS) break
      if (/^@(media|import|use|include|apply|tailwind|layer|font-face|keyframes|supports|charset)$/i.test(m[1])) continue
      if (!vars.has(m[1])) vars.set(m[1], m[2].trim())
    }
    for (const m of text.matchAll(/font-family\s*:\s*([^;{}\n]{1,120})/g)) if (fonts.size < 4) fonts.add(m[1].trim())
  }
  if (vars.size) out.push(`Variáveis de estilo (cores, tipografia, espaçamento):\n${[...vars].map(([k, v]) => `${k}: ${v}`).join('\n')}`)
  if (fonts.size) out.push(`Fontes: ${[...fonts].join(' | ')}`)

  const text = out.length ? `Identidade visual existente (as telas novas seguem este design):\n${out.join('\n')}` : ''
  designCache.set(cwd, { at: Date.now(), text })
  return text
}
