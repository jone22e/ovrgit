import { describe, expect, it } from 'vitest'
import { heuristicGroups, parseStatus, pullRequestUrl, slugify } from '../src/shared/parse'
import { normalizeAnalysis } from '../src/main/ai'
import type { FileChange } from '../src/shared/types'

describe('parseStatus', () => {
  it('interpreta branch, upstream, ahead/behind e tipos de arquivo', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 a b src/app.ts',
      '1 A. N... 000000 100644 100644 0 b src/novo arquivo.ts',
      '1 D. N... 100644 000000 000000 a 0 old.ts',
      '2 R. N... 100644 100644 100644 a b R100 src/depois.ts',
      'src/antes.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflito.ts',
      '? solto.txt',
      ''
    ].join('\0')
    const s = parseStatus(out)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 3, behind: 1, hasCommits: true })
    const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]))
    expect(byPath['src/app.ts']).toMatchObject({ kind: 'modified', staged: false, unstaged: true })
    expect(byPath['src/novo arquivo.ts']).toMatchObject({ kind: 'added', staged: true })
    expect(byPath['old.ts'].kind).toBe('deleted')
    expect(byPath['src/depois.ts']).toMatchObject({ kind: 'renamed', origPath: 'src/antes.ts' })
    expect(byPath['conflito.ts'].kind).toBe('conflict')
    expect(byPath['solto.txt'].kind).toBe('untracked')
  })

  it('reconhece repositório sem commits e HEAD destacado', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0').hasCommits).toBe(false)
    const d = parseStatus('# branch.oid abc\0# branch.head (detached)\0')
    expect(d).toMatchObject({ detached: true, branch: null })
  })
})

describe('slugify', () => {
  it('gera nomes de branch válidos', () => {
    expect(slugify('Nota de Entrada + Devoluções!')).toBe('nota-de-entrada-devolucoes')
    expect(slugify('feature/já existe')).toBe('ja-existe')
    expect(slugify('  ..x..lock ')).toBe('x')
    expect(slugify('---')).toBe('')
  })
})

describe('pullRequestUrl', () => {
  it('suporta GitHub, GitLab, Bitbucket e Azure', () => {
    expect(pullRequestUrl('git@github.com:acme/app.git', 'feature/x', 'main')).toBe(
      'https://github.com/acme/app/compare/main...feature%2Fx?expand=1'
    )
    expect(pullRequestUrl('https://github.com/acme/app', 'f', 'main')).toContain('github.com/acme/app/compare')
    expect(pullRequestUrl('https://gitlab.com/g/sub/app.git', 'f', 'main')).toContain(
      'gitlab.com/g/sub/app/-/merge_requests/new'
    )
    expect(pullRequestUrl('git@bitbucket.org:t/app.git', 'f', 'main')).toContain('bitbucket.org/t/app/pull-requests/new')
    expect(pullRequestUrl('https://dev.azure.com/org/proj/_git/repo', 'f', 'main')).toContain(
      'dev.azure.com/org/proj/_git/repo/pullrequestcreate'
    )
    expect(pullRequestUrl('/caminho/local/repo.git', 'f', 'main')).toBeNull()
  })
})

const fc = (path: string, kind: FileChange['kind'] = 'modified'): FileChange => ({
  path, kind, staged: false, unstaged: true
})

describe('heuristicGroups', () => {
  it('agrupa por diretório de domínio e separa config/docs', () => {
    const groups = heuristicGroups([
      fc('backend/src/compras/notaRoutes.ts'),
      fc('backend/src/compras/nota.test.ts', 'untracked'),
      fc('backend/src/devolucoes/x.ts'),
      fc('package.json'),
      fc('README.md')
    ])
    const titles = groups.map((g) => g.title)
    expect(titles).toContain('Compras')
    expect(titles).toContain('Devolucoes')
    expect(titles).toContain('Configuração')
    expect(titles).toContain('Documentação')
    expect(groups.find((g) => g.title === 'Compras')!.files).toHaveLength(2)
    expect(groups.flatMap((g) => g.files)).toHaveLength(5)
  })
})

describe('normalizeAnalysis', () => {
  it('descarta arquivos inventados, evita duplicados e agrupa o que a IA esqueceu', () => {
    const files = [fc('a.ts'), fc('src/b.ts'), fc('src/c.ts')]
    const a = normalizeAnalysis(
      {
        groups: [
          { title: 'Nota', type: 'feat', summary: 's', bullets: ['x'], commit: 'feat: nota', files: ['./a.ts', 'inventado.ts'] },
          { title: 'Dup', type: 'bogus', summary: '', bullets: [], commit: '', files: ['a.ts', 'src/b.ts'] }
        ],
        commit: 'feat: tudo',
        branch: 'Nota Entrada'
      },
      files
    )
    expect(a.groups[0].files).toEqual(['a.ts'])
    expect(a.groups[1]).toMatchObject({ files: ['src/b.ts'], type: 'chore', commit: 'chore: dup' })
    expect(a.groups.flatMap((g) => g.files).sort()).toEqual(['a.ts', 'src/b.ts', 'src/c.ts'])
    expect(a.branch).toBe('nota-entrada')
  })
})

describe('heuristicGroups — limite', () => {
  it('junta os grupos menores em "Outros" quando passam de 10', () => {
    const files = Array.from({ length: 25 }, (_, i) => fc(`src/mod${i}/a.ts`))
    const groups = heuristicGroups(files)
    expect(groups).toHaveLength(10)
    expect(groups[9].title).toBe('Outros')
    expect(groups.flatMap((g) => g.files)).toHaveLength(25)
  })
})

describe('links do repositório', () => {
  it('monta a página e o link do commit', async () => {
    const { repoWebUrl, commitWebUrl } = await import('../src/shared/parse')
    expect(repoWebUrl('git@github.com:jone22e/ovrgit.git')).toBe('https://github.com/jone22e/ovrgit')
    expect(commitWebUrl('https://github.com/jone22e/ovrgit.git', 'abc')).toBe('https://github.com/jone22e/ovrgit/commit/abc')
    expect(commitWebUrl('git@gitlab.com:g/app.git', 'abc')).toBe('https://gitlab.com/g/app/-/commit/abc')
    expect(repoWebUrl('/local/repo.git')).toBeNull()
  })
})
