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
const TTL_MS = 2 * 60_000

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
  const text = `<mapa_do_projeto>\n${out.join('\n\n')}\n</mapa_do_projeto>`
  cache.set(cwd, { at: Date.now(), text })
  return text
}
