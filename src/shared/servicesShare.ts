/**
 * Exportar e importar serviços entre computadores.
 *
 * O arquivo não guarda caminhos da máquina de quem exportou: a pasta de cada serviço vira "repositório + caminho
 * dentro dele" (com o remoto, para achar o repositório pelo que ele é e não por onde está), e os caminhos
 * absolutos dentro dos comandos viram marcadores ({repo:nome}, {home}). Na importação, cada repositório é
 * procurado entre os projetos do usuário (pelo remoto, depois pelo nome da pasta) e, se não achar, dentro da
 * pasta raiz que ele escolher.
 */

import type { Service } from './types'

export interface SharedService {
  name: string
  command: string
  /** Nome da pasta do repositório onde o serviço roda */
  repo?: string
  /** Remoto do repositório, sem protocolo nem credenciais ("github.com/org/nome") */
  remote?: string
  /** Caminho dentro do repositório (vazio: a raiz dele) */
  path?: string
  /** Pasta fora de qualquer repositório: "{home}/…" ou absoluta */
  cwd?: string
}
export interface ServicesFile {
  ovseer: 'servicos'
  version: 1
  services: SharedService[]
}

/** Um repositório local: raiz, nome da pasta e remoto normalizado */
export interface RepoRef {
  root: string
  name: string
  remote: string
}

/** Serviço do arquivo já com a pasta deste computador */
export interface ResolvedService {
  name: string
  command: string
  cwd: string
  /** Repositório a que pertence (nome), se pertence a um */
  repo?: string
  /** De onde saiu a pasta: de um repositório achado no computador, da IA, da pasta raiz escolhida, ou do próprio arquivo */
  via: 'project' | 'ai' | 'root' | 'file'
}

/** O que a tela de importação mostra de cada serviço */
export interface ImportedService extends ResolvedService {
  /** A pasta existe neste computador (ou o serviço não tem pasta) */
  exists: boolean
  /** Já existe um serviço igual (mesmo nome, comando e pasta) */
  duplicate: boolean
}

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const baseName = (p: string) => slash(p).split('/').pop() ?? ''
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "git@github.com:Org/Nome.git" e "https://user:token@github.com/Org/Nome" → "github.com/org/nome" */
export function normalizeRemote(url: string): string {
  let u = url.trim()
  if (!u) return ''
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '')
  u = u.replace(/^([^/:]+):(?!\d+\/)/, '$1/').replace(/^([^/:]+):\d+\//, '$1/')
  return u.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
}

/** Caminho de `child` dentro de `parent` ('' se é a própria pasta), ou null se está fora */
function relativeTo(child: string, parent: string): string | null {
  const c = slash(child)
  const p = slash(parent)
  if (!p) return null
  if (c === p) return ''
  return c.startsWith(p + '/') ? c.slice(p.length + 1) : null
}

/** Troca um caminho absoluto dentro do texto de um comando, nas duas grafias de barra, só em fronteira de caminho */
function replacePath(text: string, abs: string, marker: string): string {
  const a = slash(abs)
  if (a.length < 2) return text
  const variants = [...new Set([a, a.replace(/\//g, '\\')])]
  for (const v of variants) text = text.replace(new RegExp(escapeRe(v) + '(?![\\w.-])', 'g'), marker)
  return text
}

/** Monta o arquivo de exportação. `repoOf` diz a que repositório pertence cada pasta (null: nenhum). */
export function exportServices(services: Service[], repoOf: (cwd: string) => RepoRef | null, home: string): ServicesFile {
  const repos = new Map<string, RepoRef>()
  for (const s of services) {
    const r = s.cwd ? repoOf(s.cwd) : null
    if (r) repos.set(slash(r.root), r)
  }
  // caminhos mais longos primeiro: um repositório dentro da pasta do usuário vira {repo:…}, não {home}/…
  const roots = [...repos.values()].sort((a, b) => b.root.length - a.root.length)
  const portable = (command: string) => {
    let c = command
    for (const r of roots) c = replacePath(c, r.root, `{repo:${r.name}}`)
    return home ? replacePath(c, home, '{home}') : c
  }
  return {
    ovseer: 'servicos',
    version: 1,
    services: services.map((s) => {
      const out: SharedService = { name: s.name, command: portable(s.command) }
      const r = s.cwd ? repoOf(s.cwd) : null
      if (r) {
        out.repo = r.name
        if (r.remote) out.remote = r.remote
        out.path = relativeTo(s.cwd, r.root) ?? ''
      } else if (s.cwd) {
        const rel = home ? relativeTo(s.cwd, home) : null
        out.cwd = rel === null ? s.cwd : rel ? `{home}/${rel}` : '{home}'
      }
      return out
    })
  }
}

const MAX_SERVICES = 200
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Lê e valida o arquivo de serviços; lança erro com a explicação se não for um */
export function parseServicesFile(text: string): ServicesFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('O arquivo não é um JSON válido.')
  }
  const d = data as Partial<ServicesFile> | null
  if (!d || d.ovseer !== 'servicos' || !Array.isArray(d.services)) throw new Error('Este arquivo não é uma exportação de serviços do Ovseer.')
  const services: SharedService[] = []
  for (const raw of d.services.slice(0, MAX_SERVICES)) {
    const r = raw as Partial<SharedService> | null
    const name = str(r?.name, 80).trim()
    const command = str(r?.command, 20_000).trim()
    if (!name || !command) continue
    const item: SharedService = { name, command }
    // o nome do repositório vira parte de um caminho: só o nome de uma pasta, nada de "../"
    const repo = baseName(str(r?.repo, 200)).replace(/^\.+$/, '')
    if (repo) {
      item.repo = repo
      item.remote = str(r?.remote, 400)
      item.path = slash(str(r?.path, 1000)).split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/')
    } else if (r?.cwd) item.cwd = str(r.cwd, 1000)
    services.push(item)
  }
  if (!services.length) throw new Error('O arquivo não tem nenhum serviço.')
  return { ovseer: 'servicos', version: 1, services }
}

/**
 * Pasta de cada serviço neste computador. `known` são os repositórios que o usuário já tem (projetos do app);
 * `root` é a pasta onde ficam os repositórios dele, usada para os que não foram achados.
 * A ordem de `known` é a de preferência (os projetos abertos no app antes dos achados no disco).
 */
export function resolveServices(file: ServicesFile, o: { root: string; known: RepoRef[]; home: string; picked?: Record<string, string> }): ResolvedService[] {
  const native = (p: string) => (/\\/.test(o.home) || /^[a-z]:/i.test(o.root) ? p.replace(/\//g, '\\') : p)
  const found = new Map<string, { root: string; via: 'project' | 'ai' | 'root' }>()
  const repoRoot = (s: SharedService) => {
    const key = `${s.repo}\n${s.remote ?? ''}`
    let hit = found.get(key)
    if (!hit) {
      // `picked`: repositórios que a IA apontou (pelo nome que têm no arquivo) para os que não serviram pelo
      // remoto nem pelo nome; quem chama só manda os que faltavam, então valem antes da busca comum
      const ai = s.repo ? o.picked?.[s.repo] : undefined
      const k = ai ? undefined : (s.remote && o.known.find((r) => r.remote && r.remote === s.remote)) || o.known.find((r) => r.name === s.repo)
      hit = ai ? { root: slash(ai), via: 'ai' } : k ? { root: slash(k.root), via: 'project' } : { root: `${slash(o.root)}/${s.repo}`, via: 'root' }
      found.set(key, hit)
    }
    return hit
  }
  // os marcadores {repo:nome} dos comandos apontam para os repositórios do próprio arquivo
  const byName = new Map<string, string>()
  for (const s of file.services) if (s.repo && !byName.has(s.repo)) byName.set(s.repo, repoRoot(s).root)
  const local = (command: string) =>
    command.replace(/\{repo:([^}]+)\}/g, (m, name: string) => (byName.has(name) ? native(byName.get(name)!) : m)).replace(/\{home\}/g, o.home)

  return file.services.map((s) => {
    if (s.repo) {
      const r = repoRoot(s)
      return { name: s.name, command: local(s.command), cwd: native(s.path ? `${r.root}/${s.path}` : r.root), repo: s.repo, via: r.via }
    }
    const cwd = (s.cwd ?? '').replace(/^\{home\}/, slash(o.home))
    return { name: s.name, command: local(s.command), cwd: cwd ? native(cwd) : '', via: 'file' as const }
  })
}
