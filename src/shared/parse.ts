import type { ChangeGroup, ChangeKind, CommitInfo, CommitType, FileChange } from './types'

export interface ParsedStatus {
  branch: string | null
  detached: boolean
  hasCommits: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
}

function kindFromXY(xy: string): ChangeKind {
  const [x, y] = xy
  if (x === 'R' || x === 'C') return 'renamed'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/** Interpreta a saída de `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatus(out: string): ParsedStatus {
  const res: ParsedStatus = {
    branch: null,
    detached: false,
    hasCommits: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: []
  }
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') res.hasCommits = value !== '(initial)'
      else if (key === 'branch.head') {
        res.detached = value === '(detached)'
        res.branch = res.detached ? null : value
      } else if (key === 'branch.upstream') res.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          res.ahead = Number(m[1])
          res.behind = Number(m[2])
        }
      }
      continue
    }
    const type = line[0]
    if (type === '?') {
      res.files.push({ path: line.slice(2), kind: 'untracked', staged: false, unstaged: true })
    } else if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = line.split(' ')
      const xy = parts[1]
      res.files.push({
        path: parts.slice(8).join(' '),
        kind: kindFromXY(xy),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.'
      })
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = line.split(' ')
      const xy = parts[1]
      res.files.push({
        path: parts.slice(9).join(' '),
        origPath: tokens[++i],
        kind: 'renamed',
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.'
      })
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = line.split(' ')
      res.files.push({ path: parts.slice(10).join(' '), kind: 'conflict', staged: false, unstaged: true })
    }
  }
  res.files.sort((a, b) => a.path.localeCompare(b.path))
  return res
}

export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'

export function parseLog(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, date, subject] = r.split('\x1f')
      return { hash, short, author, date, subject }
    })
}

/** Converte um texto livre em um nome de branch válido: "Nota de Entrada!" → "nota-de-entrada". */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^feature\//, '')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/\/+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.lock$/, '')
    .slice(0, 60)
}

function parseRemote(remoteUrl: string): { host: string; repo: string } | null {
  const m =
    /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(remoteUrl) ?? // scp: git@host:owner/repo.git
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl)
  return m ? { host: m[1].toLowerCase(), repo: m[2] } : null
}

/** Página web do repositório (https://github.com/dono/repo) a partir da URL do remote. */
export function repoWebUrl(remoteUrl: string): string | null {
  const r = parseRemote(remoteUrl)
  if (!r || !/github|gitlab|bitbucket/.test(r.host)) return null
  return `https://${r.host}/${r.repo}`
}

/** Link do commit no GitHub/GitLab/Bitbucket. */
export function commitWebUrl(remoteUrl: string, sha: string): string | null {
  const r = parseRemote(remoteUrl)
  const web = repoWebUrl(remoteUrl)
  if (!r || !web) return null
  if (r.host.includes('gitlab')) return `${web}/-/commit/${sha}`
  if (r.host.includes('bitbucket')) return `${web}/commits/${sha}`
  return `${web}/commit/${sha}`
}

/** Monta a URL de "novo Pull Request" a partir da URL do remote. Retorna null para hosts desconhecidos. */
export function pullRequestUrl(remoteUrl: string, branch: string, base: string): string | null {
  const r = parseRemote(remoteUrl)
  if (!r) return null
  const host = r.host
  const repo = r.repo
  const b = encodeURIComponent(branch)
  const t = encodeURIComponent(base)
  if (host.includes('github')) return `https://${host}/${repo}/compare/${t}...${b}?expand=1`
  if (host.includes('gitlab'))
    return `https://${host}/${repo}/-/merge_requests/new?merge_request[source_branch]=${b}&merge_request[target_branch]=${t}`
  if (host.includes('bitbucket')) return `https://${host}/${repo}/pull-requests/new?source=${b}&dest=${t}`
  if (host.includes('dev.azure.com') || host.includes('visualstudio.com')) {
    const path = repo.replace(/^v3\//, '').replace(/^([^/]+)\/([^/]+)\/([^/]+)$/, '$1/$2/_git/$3')
    return `https://dev.azure.com/${path}/pullrequestcreate?sourceRef=${b}&targetRef=${t}`
  }
  return null
}

const NOISE_DIRS = new Set([
  'src', 'source', 'app', 'apps', 'lib', 'libs', 'packages', 'modules', 'main', 'java', 'kotlin',
  'backend', 'frontend', 'server', 'client', 'web', 'api', 'core', 'components', 'views', 'pages',
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'resources', 'public', 'assets'
])

const isTest = (p: string) => /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z]+$/i.test(p)
const isDoc = (p: string) => /\.(md|mdx|txt|rst|adoc)$/i.test(p) || /(^|\/)docs?\//i.test(p)
const isConfig = (p: string) =>
  !p.includes('/') ||
  /(^|\/)(\.github|\.vscode|\.idea)\//.test(p) ||
  /(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|\.config\.[cm]?[jt]s|dockerfile|\.ya?ml|\.env.*)$/i.test(p)

function groupKey(path: string): string {
  if (isDoc(path)) return 'Documentação'
  if (isConfig(path)) return 'Configuração'
  const dirs = path.split('/').slice(0, -1)
  const meaningful = dirs.filter((d) => !NOISE_DIRS.has(d.toLowerCase()) && !d.startsWith('.'))
  // Prefere o diretório mais específico que ainda seja "de domínio" (ex.: src/compras/nota → compras)
  const key = meaningful[0] ?? dirs[dirs.length - 1] ?? 'Raiz'
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function guessType(files: FileChange[], title: string): CommitType {
  if (title === 'Documentação') return 'docs'
  if (title === 'Configuração') return 'chore'
  if (files.every((f) => isTest(f.path))) return 'test'
  if (files.some((f) => f.kind === 'added' || f.kind === 'untracked')) return 'feat'
  return 'refactor'
}

const VERB: Record<CommitType, string> = {
  feat: 'adiciona alterações em',
  fix: 'corrige',
  refactor: 'ajusta',
  test: 'atualiza testes de',
  chore: 'atualiza',
  docs: 'atualiza documentação de',
  style: 'formata',
  perf: 'melhora desempenho de'
}

const MAX_HEURISTIC_GROUPS = 10

/** Agrupamento de reserva, por diretório, usado quando a IA não está disponível. */
export function heuristicGroups(files: FileChange[]): ChangeGroup[] {
  const map = new Map<string, FileChange[]>()
  for (const f of files) {
    const k = groupKey(f.path)
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(f)
  }
  let entries = [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  // muitos grupos pequenos viram ruído: os menores são juntados em "Outros"
  if (entries.length > MAX_HEURISTIC_GROUPS) {
    const rest = entries.slice(MAX_HEURISTIC_GROUPS - 1).flatMap(([, fs]) => fs)
    entries = [...entries.slice(0, MAX_HEURISTIC_GROUPS - 1), ['Outros', rest]]
  }
  return entries
    .map(([title, fs], i) => {
      const type = guessType(fs, title)
      const counts = countKinds(fs)
      return {
        id: `g${i}`,
        title,
        type,
        summary: `${fs.length} arquivo${fs.length > 1 ? 's' : ''} alterado${fs.length > 1 ? 's' : ''}`,
        bullets: counts,
        commit:
          title === 'Documentação' || title === 'Configuração'
            ? `${type}: atualiza ${title.toLowerCase()}`
            : `${type}: ${VERB[type]} ${title.toLowerCase()}`,
        files: fs.map((f) => f.path)
      }
    })
}

function countKinds(files: FileChange[]): string[] {
  const labels: Partial<Record<ChangeKind, string>> = {
    added: 'adicionado',
    untracked: 'adicionado',
    modified: 'modificado',
    deleted: 'removido',
    renamed: 'renomeado',
    conflict: 'em conflito',
    typechange: 'modificado'
  }
  const c = new Map<string, number>()
  for (const f of files) {
    const l = labels[f.kind] ?? 'modificado'
    c.set(l, (c.get(l) ?? 0) + 1)
  }
  return [...c.entries()].map(([l, n]) => `${n} ${l}${n > 1 ? 's' : ''}`)
}
