import { dialog, type BrowserWindow } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportServices, normalizeRemote, parseServicesFile, resolveServices, type ImportedService, type RepoRef, type ServicesFile } from '../shared/servicesShare'
import { runJsonTask } from './ai'
import { suggestedParent } from './clone'
import { findRoot, run } from './git'
import { getSettings } from './settings'

/** Exportar e importar os serviços (a parte que toca disco e git; as regras estão em shared/servicesShare) */

/** Repositório a que a pasta pertence, com o remoto "origin" normalizado (null: não é um repositório) */
async function repoRef(dir: string): Promise<RepoRef | null> {
  if (!dir || !existsSync(dir)) return null
  try {
    const root = await findRoot(dir)
    const r = await run(root, ['remote', 'get-url', 'origin'])
    return { root, name: path.basename(root), remote: r.code === 0 ? normalizeRemote(r.stdout) : '' }
  } catch {
    return null
  }
}

/** Grava os serviços (todos, ou só os de `ids`) num arquivo escolhido pelo usuário, sem caminhos deste computador */
export async function exportToFile(win: BrowserWindow, ids?: string[]): Promise<{ path: string; count: number } | null> {
  const services = getSettings().services.filter((s) => !ids || ids.includes(s.id))
  if (!services.length) throw new Error('Não há serviços para exportar.')
  const refs = new Map<string, RepoRef | null>()
  for (const s of services) if (s.cwd && !refs.has(s.cwd)) refs.set(s.cwd, await repoRef(s.cwd))
  const file = exportServices(services, (cwd) => refs.get(cwd) ?? null, os.homedir())
  const res = await dialog.showSaveDialog(win, {
    title: 'Exportar serviços',
    defaultPath: path.join(os.homedir(), 'ovseer-servicos.json'),
    filters: [{ name: 'Serviços do Ovseer', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return null
  writeFileSync(res.filePath, JSON.stringify(file, null, 2) + '\n', 'utf8')
  return { path: res.filePath, count: file.services.length }
}

/** Abre um arquivo de serviços; devolve o conteúdo validado e a pasta raiz sugerida (onde ficam os projetos do usuário) */
export async function pickImport(win: BrowserWindow): Promise<{ file: ServicesFile; root: string } | null> {
  const res = await dialog.showOpenDialog(win, {
    title: 'Importar serviços',
    properties: ['openFile'],
    filters: [{ name: 'Serviços do Ovseer', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  if (statSync(res.filePaths[0]).size > 2_000_000) throw new Error('Arquivo grande demais.')
  const file = parseServicesFile(readFileSync(res.filePaths[0], 'utf8'))
  return { file, root: suggestedParent(getSettings().recentProjects) }
}

let repoCache: { root: string; at: number; repos: RepoRef[] } | null = null

/** Pastas onde não vale procurar repositórios */
const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Music', 'Pictures', 'Movies', 'Public', 'AppData', 'vendor', 'dist', 'build', 'out', 'target', 'Pods'])
const MAX_REPOS = 500
const SCAN_MS = 4000

/** Remoto "origin" lido direto do .git/config (sem rodar o git em centenas de pastas) */
function originOf(repo: string): string {
  try {
    const cfg = readFileSync(path.join(repo, '.git', 'config'), 'utf8')
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg)
    return m ? normalizeRemote(m[1]) : ''
  } catch {
    return ''
  }
}

/** Repositórios Git dentro das pastas dadas, até `depth` níveis (não entra em repositório achado nem em pasta oculta) */
function scanRepos(starts: { dir: string; depth: number }[]): RepoRef[] {
  const out: RepoRef[] = []
  const seen = new Set<string>()
  const until = Date.now() + SCAN_MS
  const walk = (dir: string, depth: number) => {
    if (seen.has(dir) || out.length >= MAX_REPOS || Date.now() > until) return
    seen.add(dir)
    if (existsSync(path.join(dir, '.git', 'config'))) {
      out.push({ root: dir, name: path.basename(dir), remote: originOf(dir) })
      return
    }
    if (depth <= 0) return
    let names: string[] = []
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => e.name)
    } catch {
      /* sem permissão */
    }
    for (const n of names) walk(path.join(dir, n), depth - 1)
  }
  for (const s of starts) if (s.dir && existsSync(s.dir)) walk(s.dir, s.depth)
  return out
}

/**
 * Repositórios deste computador, na ordem de preferência: os projetos abertos no app e depois os achados no
 * disco (na pasta raiz escolhida, ao lado dos projetos do app e na pasta do usuário).
 */
async function localRepos(root: string): Promise<RepoRef[]> {
  // a tela pede duas vezes seguidas (a lista e, em seguida, a busca com a IA): a varredura vale por alguns segundos
  if (repoCache && repoCache.root === root && Date.now() - repoCache.at < 20_000) return repoCache.repos
  const recent = getSettings().recentProjects
  const known: RepoRef[] = []
  for (const p of recent) {
    const r = await repoRef(p)
    if (r && !known.some((k) => k.root === r.root)) known.push(r)
  }
  const starts = [{ dir: root, depth: 4 }, ...[...new Set(recent.map((p) => path.dirname(p)))].map((dir) => ({ dir, depth: 2 })), { dir: os.homedir(), depth: 3 }]
  for (const r of scanRepos(starts)) if (!known.some((k) => k.root === r.root)) known.push(r)
  repoCache = { root, at: Date.now(), repos: known }
  return known
}

/** Só aceita da tela o que a IA poderia ter apontado: nome de repositório → pasta que existe */
function cleanPicked(picked: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (picked && typeof picked === 'object')
    for (const [k, v] of Object.entries(picked as Record<string, unknown>)) if (typeof v === 'string' && v && existsSync(path.join(v, '.git'))) out[k] = v
  return out
}

/** Pasta de cada serviço do arquivo neste computador, com o que o usuário precisa saber antes de importar */
export async function resolveImport(input: ServicesFile, root: string, picked?: Record<string, string>): Promise<ImportedService[]> {
  // o arquivo volta da janela: valida de novo
  const file = parseServicesFile(JSON.stringify(input))
  const mine = getSettings().services
  const base = root || os.homedir()
  return resolveServices(file, { root: base, known: await localRepos(base), home: os.homedir(), picked: cleanPicked(picked) }).map((s) => ({
    ...s,
    exists: !s.cwd || existsSync(s.cwd),
    duplicate: mine.some((m) => m.name === s.name && m.command === s.command && m.cwd === s.cwd)
  }))
}

/**
 * Para os repositórios do arquivo que não foram achados (nem pelo remoto, nem pelo nome), a IA compara o que o
 * arquivo diz deles (nome, remoto, caminho, comandos) com os repositórios deste computador (nome, remoto, o que
 * há na raiz) e aponta o correspondente, se houver. Só vale o que aponta para um repositório da lista em que o
 * caminho do serviço existe. Devolve nome do repositório no arquivo → pasta.
 */
export async function locateWithAi(input: ServicesFile, root: string): Promise<Record<string, string>> {
  const file = parseServicesFile(JSON.stringify(input))
  const base = root || os.homedir()
  const repos = await localRepos(base)
  const resolved = resolveServices(file, { root: base, known: repos, home: os.homedir() })
  const missing = new Map<string, { remote: string; paths: Set<string>; services: string[] }>()
  resolved.forEach((r, i) => {
    const s = file.services[i]
    // falta tanto o repositório que não existe quanto o achado pelo nome que não tem a pasta do serviço (é outro projeto)
    if (!s.repo || existsSync(r.cwd)) return
    const m = missing.get(s.repo) ?? { remote: s.remote ?? '', paths: new Set<string>(), services: [] }
    if (s.path) m.paths.add(s.path)
    m.services.push(`${s.name}: ${s.command.split('\n')[0].slice(0, 160)}`)
    missing.set(s.repo, m)
  })
  if (!missing.size || !repos.length) return {}
  // candidatos: só repositórios em que as pastas usadas por algum dos procurados existem
  const fits = (root: string, paths: Set<string>) => [...paths].every((p) => existsSync(path.join(root, p)))
  const candidates = repos.filter((c) => [...missing.values()].some((m) => fits(c.root, m.paths))).slice(0, 120)
  if (!candidates.length) return {}
  /** O que identifica um repositório além do nome: o que há na raiz, o nome no package.json e o título do README */
  const about = (dir: string) => {
    const parts: string[] = []
    try {
      parts.push(`raiz: ${readdirSync(dir).filter((n) => !n.startsWith('.git')).slice(0, 30).join(', ')}`)
    } catch {
      /* sem permissão */
    }
    try {
      const name = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name
      if (name) parts.push(`package.json: ${String(name).slice(0, 80)}`)
    } catch {
      /* sem package.json */
    }
    for (const f of ['README.md', 'readme.md', 'Readme.md']) {
      try {
        const line = readFileSync(path.join(dir, f), 'utf8').slice(0, 2000).split('\n').find((l) => l.trim())
        if (line) parts.push(`README: ${line.trim().slice(0, 140)}`)
        break
      } catch {
        /* sem README */
      }
    }
    return parts.join(' | ')
  }
  const context = [
    'REPOSITÓRIOS PROCURADOS (do arquivo importado):',
    ...[...missing].map(([name, m]) => `- nome: ${name}${m.remote ? ` | remoto: ${m.remote}` : ''}${m.paths.size ? ` | pastas usadas: ${[...m.paths].join(', ')}` : ''}\n  serviços: ${m.services.slice(0, 6).join(' ; ')}`),
    '',
    'REPOSITÓRIOS NESTE COMPUTADOR:',
    ...candidates.map((c, i) => `${i + 1}. ${c.root}${c.remote ? ` | remoto: ${c.remote}` : ''} | ${about(c.root)}`)
  ].join('\n')
  const r = await runJsonTask<{ matches?: { repo?: string; number?: number }[] }>(
    getSettings(),
    `Você ajuda a importar serviços de desenvolvimento de outro computador. Cada serviço roda dentro de um repositório Git; alguns repositórios do arquivo não foram achados neste computador pelo nome nem pelo remoto.
Para cada repositório procurado, diga qual repositório deste computador é o mesmo projeto (clonado com outro nome de pasta, de um fork ou de outro remoto), comparando nome, remoto, as pastas usadas e os comandos com o que se sabe de cada candidato (remoto, raiz, package.json, README).
Só aponte quando houver boa evidência de que é o mesmo projeto; na dúvida, não aponte (número 0). Responda SOMENTE com JSON.`,
    {
      type: 'object',
      properties: { matches: { type: 'array', items: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'number' } }, required: ['repo', 'number'] } } },
      required: ['matches']
    },
    'Aponte, para cada repositório procurado, o número do repositório correspondente neste computador (0 se nenhum).',
    context.slice(0, 60_000)
  )
  const out: Record<string, string> = {}
  for (const m of r.matches ?? []) {
    const want = missing.get(String(m.repo ?? ''))
    const c = candidates[Number(m.number) - 1]
    // confere: é um candidato da lista e as pastas que os serviços usam existem nele
    if (want && c && fits(c.root, want.paths)) out[String(m.repo)] = c.root
  }
  return out
}
