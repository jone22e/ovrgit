import type { RepoGroup } from './types'

/**
 * Grupos de repositórios: um nome para o conjunto de pastas que costumam ir juntas numa conversa
 * (o principal e os juntados). Quando o espaço de trabalho da conversa é exatamente um grupo salvo,
 * o seletor mostra o nome do grupo no lugar dos chips.
 */

/** Caminho sem a barra final, para comparar */
const norm = (p: string) => p.replace(/[\\/]+$/, '')
/** Nome da pasta */
export const repoName = (p: string) => norm(p).split(/[\\/]/).pop() || p

/** Mesmo conjunto de pastas, em qualquer ordem e sem repetidos */
export function sameRepos(a: string[], b: string[]): boolean {
  const sa = new Set(a.map(norm))
  const sb = new Set(b.map(norm))
  return sa.size === sb.size && [...sa].every((p) => sb.has(p))
}

/** O grupo salvo que é exatamente o espaço de trabalho atual (principal + juntados), se houver */
export function groupOf(groups: RepoGroup[], cwd: string, extra: string[] = []): RepoGroup | undefined {
  return groups.find((g) => sameRepos(g.dirs, [cwd, ...extra]))
}

/** "a + b + c": os nomes das pastas do grupo */
export const groupMembers = (g: RepoGroup) => g.dirs.map(repoName).join(' + ')

/** Minúsculas e sem acento: "configuracao" acha "Configuração" */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
/** Palavras do campo de busca do seletor de repositórios */
export const searchWords = (query: string) => fold(query).split(/\s+/).filter(Boolean)
/** Todas as palavras aparecem em algum dos textos, em qualquer ordem (sem palavras, tudo passa) */
export function hasWords(words: string[], ...texts: string[]): boolean {
  const t = fold(texts.join(' '))
  return words.every((w) => t.includes(w))
}
/** Busca normal pelo nome da pasta; com separador, pelo caminho completo */
const pathQuery = (words: string[]) => words.some((w) => /[\\/]/.test(w))
export const repoMatches = (words: string[], path: string) => hasWords(words, pathQuery(words) ? path : repoName(path))
/** O grupo bate pelo nome ou pelos nomes das pastas que reúne */
export const groupMatches = (words: string[], g: RepoGroup) =>
  hasWords(words, g.name, ...(pathQuery(words) ? g.dirs : g.dirs.map(repoName)))

/**
 * Espaço de trabalho ao aplicar um grupo. Com a conversa ainda sem começar (`switchable`) e o principal fora do
 * grupo, o primeiro repositório do grupo vira o principal; senão o principal fica e o resto do grupo é juntado.
 */
export function applyGroup(g: RepoGroup, cwd: string, switchable: boolean): { cwd: string; extra: string[] } {
  const dirs = [...new Set(g.dirs.map(norm))]
  const swap = switchable && !!dirs[0] && !dirs.includes(norm(cwd))
  const main = swap ? dirs[0] : cwd
  return { cwd: main, extra: dirs.filter((d) => d !== norm(main)) }
}

/** Salva um grupo: um grupo com as mesmas pastas (renomear) ou o mesmo nome (trocar as pastas) é substituído */
export function saveGroup(groups: RepoGroup[], name: string, dirs: string[]): RepoGroup[] {
  const clean = name.trim()
  const kept = groups.filter((g) => !sameRepos(g.dirs, dirs) && g.name.toLowerCase() !== clean.toLowerCase())
  const previous = groups.find((g) => sameRepos(g.dirs, dirs) || g.name.toLowerCase() === clean.toLowerCase())
  return [...kept, { id: previous?.id ?? crypto.randomUUID(), name: clean, dirs: [...new Set(dirs.map(norm))], ...(previous?.icon ? { icon: previous.icon } : {}) }].slice(-30)
}
