import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as g from '../src/main/git'

let tmp: string
let remote: string
let repo: string

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()

function write(rel: string, content: string) {
  const p = path.join(repo, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content)
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-test-'))
  remote = path.join(tmp, 'remote.git')
  repo = path.join(tmp, 'repo')
  sh(tmp, 'init', '--bare', '-b', 'main', remote)
  sh(tmp, 'clone', remote, repo)
  sh(repo, 'config', 'user.name', 'Teste')
  sh(repo, 'config', 'user.email', 'teste@example.com')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  write('README.md', 'inicial\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-m', 'inicial')
  sh(repo, 'push', '-u', 'origin', 'main')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('git', () => {
  it('status lista alterações, arquivos novos e upstream', async () => {
    write('README.md', 'mudou\n')
    write('src/novo.ts', 'x\n')
    const st = await g.status(repo)
    expect(st).toMatchObject({ branch: 'main', upstream: 'origin/main', hasRemote: true, ahead: 0 })
    expect(st.files.map((f) => [f.path, f.kind])).toEqual([
      ['README.md', 'modified'],
      ['src/novo.ts', 'untracked']
    ])
  })

  it('diff funciona para arquivo modificado e novo', async () => {
    write('README.md', 'mudou\n')
    write('novo.txt', 'conteudo\n')
    const st = await g.status(repo)
    expect(await g.diff(repo, st.files.find((f) => f.path === 'README.md')!)).toContain('+mudou')
    expect(await g.diff(repo, st.files.find((f) => f.path === 'novo.txt')!)).toContain('+conteudo')
  })

  it('commit inclui só os arquivos escolhidos, mesmo com outros já no stage', async () => {
    write('a.txt', 'a\n')
    write('b.txt', 'b\n')
    sh(repo, 'add', 'b.txt')
    const r = await g.commit(repo, ['a.txt'], 'feat: adiciona a')
    expect(r.ok).toBe(true)
    expect(sh(repo, 'show', '--name-only', '--pretty=format:%s', 'HEAD')).toBe('feat: adiciona a\na.txt')
    const st = await g.status(repo)
    expect(st.files.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('commit de arquivo renomeado leva a remoção junto', async () => {
    renameSync(path.join(repo, 'README.md'), path.join(repo, 'LEIAME.md'))
    sh(repo, 'add', '-A')
    const st = await g.status(repo)
    expect(st.files[0]).toMatchObject({ kind: 'renamed', path: 'LEIAME.md', origPath: 'README.md' })
    expect((await g.commit(repo, ['LEIAME.md'], 'docs: renomeia')).ok).toBe(true)
    expect((await g.status(repo)).files).toEqual([])
  })

  it('commitGroups cria um commit por grupo', async () => {
    write('x/1.ts', '1')
    write('y/2.ts', '2')
    const r = await g.commitGroups(repo, [
      { files: ['x/1.ts'], message: 'feat: x' },
      { files: ['y/2.ts'], message: 'feat: y' }
    ])
    expect(r.ok).toBe(true)
    expect(sh(repo, 'log', '-3', '--pretty=%s').split('\n')).toEqual(['feat: y', 'feat: x', 'inicial'])
  })

  it('push configura upstream em branch nova', async () => {
    sh(repo, 'switch', '-c', 'outra')
    write('o.txt', 'o')
    await g.commit(repo, ['o.txt'], 'feat: o')
    const r = await g.push(repo)
    expect(r.ok).toBe(true)
    expect((await g.status(repo)).upstream).toBe('origin/outra')
  })

  it('pull recusa com alterações locais e funciona com stash', async () => {
    // outro clone publica um commit
    const other = path.join(tmp, 'other')
    sh(tmp, 'clone', remote, other)
    sh(other, 'config', 'user.name', 'O')
    sh(other, 'config', 'user.email', 'o@example.com')
    writeFileSync(path.join(other, 'remoto.txt'), 'r')
    sh(other, 'add', '.')
    sh(other, 'commit', '-m', 'remoto')
    sh(other, 'push')

    write('README.md', 'local sujo\n')
    expect((await g.pull(repo, false)).error).toBe('DIRTY')
    const r = await g.pull(repo, true)
    expect(r.ok).toBe(true)
    expect(sh(repo, 'log', '-1', '--pretty=%s')).toBe('remoto')
    const st = await g.status(repo)
    expect(st.files.map((f) => f.path)).toEqual(['README.md'])
    expect(sh(repo, 'stash', 'list')).toBe('')
  })

  it('criar feature move commits locais, preserva alterações e restaura main', async () => {
    write('f1.ts', '1')
    await g.commit(repo, ['f1.ts'], 'feat: 1')
    write('f2.ts', '2')
    await g.commit(repo, ['f2.ts'], 'feat: 2')
    write('wip.ts', 'em andamento')
    const originMain = sh(repo, 'rev-parse', 'origin/main')

    const preview = await g.featurePreview(repo)
    expect(preview).toMatchObject({ branch: 'main', baseRef: 'origin/main', localCommits: 2, changedFiles: 3, dirty: true })

    const r = await g.createFeature(repo, 'Nota de Entrada')
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)

    const st = await g.status(repo)
    expect(st.branch).toBe('feature/nota-de-entrada')
    expect(st.upstream).toBe('origin/feature/nota-de-entrada')
    expect(st.files.map((f) => f.path)).toEqual(['wip.ts'])
    expect(sh(repo, 'log', '-2', '--pretty=%s').split('\n')).toEqual(['feat: 2', 'feat: 1'])
    expect(sh(repo, 'rev-parse', 'main')).toBe(originMain)
    expect(sh(repo, 'rev-parse', 'origin/main')).toBe(originMain)
    expect(sh(repo, 'branch', '--list', 'backup/auto-*')).toMatch(/backup\/auto-/)
    expect(sh(remote, 'rev-parse', 'feature/nota-de-entrada')).toBe(sh(repo, 'rev-parse', 'HEAD'))
  })

  it('criar feature recusa nome repetido', async () => {
    sh(repo, 'branch', 'feature/dup')
    const r = await g.createFeature(repo, 'dup')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('já existe')
  })

  it('aiContext inclui numstat, diff e conteúdo de arquivos novos', async () => {
    write('README.md', 'mudou\n')
    write('novo.ts', 'export const x = 1\n')
    const ctx = await g.aiContext(repo, (await g.status(repo)).files)
    expect(ctx).toContain('[modified] README.md')
    expect(ctx).toContain('+mudou')
    expect(ctx).toContain('export const x = 1')
  })
})

describe('git — remoções', () => {
  it('commita remoção já no stage e remoção fora do stage', async () => {
    write('x.txt', 'x')
    write('y.txt', 'y')
    await g.commit(repo, ['x.txt', 'y.txt'], 'feat: xy')
    sh(repo, 'rm', '-q', 'x.txt')
    rmSync(path.join(repo, 'y.txt'))
    const r = await g.commit(repo, ['x.txt', 'y.txt'], 'chore: remove')
    expect(r.ok, r.error).toBe(true)
    expect((await g.status(repo)).files).toEqual([])
  })
})

describe('git — merge com conflito', () => {
  function conflictSetup() {
    const other = path.join(tmp, 'other2')
    sh(tmp, 'clone', remote, other)
    sh(other, 'config', 'user.name', 'O')
    sh(other, 'config', 'user.email', 'o@example.com')
    writeFileSync(path.join(other, 'README.md'), 'REMOTO\n')
    sh(other, 'commit', '-qam', 'remoto')
    sh(other, 'push', '-q')
    write('README.md', 'LOCAL\n')
    sh(repo, 'commit', '-qam', 'local')
    write('wip.txt', 'trabalho em andamento\n') // força o stash
  }

  it('pull com conflito mostra os arquivos, e concluir restaura o stash', async () => {
    conflictSetup()
    const r = await g.pull(repo, true)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/conflito em 1 arquivo/)
    expect(r.steps.some((s) => s.label.startsWith('Conflito no merge') && s.detail === 'README.md')).toBe(true)

    let st = await g.status(repo)
    expect(st).toMatchObject({ operation: 'merge', conflicts: 1 })
    expect((await g.commit(repo, ['README.md'], 'x')).error).toMatch(/merge em andamento/)
    expect((await g.continueOperation(repo)).error).toMatch(/1 arquivo\(s\) em conflito/)

    expect((await g.resolveConflict(repo, 'README.md', 'theirs')).ok).toBe(true)
    st = await g.status(repo)
    expect(st.conflicts).toBe(0)

    const c = await g.continueOperation(repo)
    expect(c.ok, JSON.stringify(c.steps)).toBe(true)
    expect(c.steps.map((s) => s.label)).toContain('Alterações locais restauradas')
    st = await g.status(repo)
    expect(st.operation).toBeNull()
    expect(st.files.map((f) => f.path)).toEqual(['wip.txt'])
    expect(sh(repo, 'show', 'HEAD:README.md')).toBe('REMOTO')
  })

  it('abortar merge volta ao estado anterior e restaura o stash', async () => {
    conflictSetup()
    await g.pull(repo, true)
    const r = await g.abortOperation(repo)
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)
    const st = await g.status(repo)
    expect(st.operation).toBeNull()
    expect(st.files.map((f) => f.path)).toEqual(['wip.txt'])
    expect(sh(repo, 'show', 'HEAD:README.md')).toBe('LOCAL')
  })

  it('escolher a minha versão mantém o arquivo local', async () => {
    conflictSetup()
    await g.pull(repo, true)
    await g.resolveConflict(repo, 'README.md', 'mine')
    expect((await g.continueOperation(repo)).ok).toBe(true)
    expect(sh(repo, 'show', 'HEAD:README.md')).toBe('LOCAL')
  })
})

describe('git — criar feature sobre a main atual', () => {
  function remoteCommit(file: string, content: string) {
    const other = path.join(tmp, `other-${Math.random().toString(36).slice(2)}`)
    sh(tmp, 'clone', '-q', remote, other)
    sh(other, 'config', 'user.name', 'O')
    sh(other, 'config', 'user.email', 'o@example.com')
    writeFileSync(path.join(other, file), content)
    sh(other, 'add', '.')
    sh(other, 'commit', '-qm', `remoto ${file}`)
    sh(other, 'push', '-q')
  }

  it('atualiza a main e reaplica os commits locais em cima dela antes de enviar', async () => {
    write('meu.ts', 'meu\n')
    await g.commit(repo, ['meu.ts'], 'feat: meu')
    write('wip.ts', 'wip\n')
    remoteCommit('deles.ts', 'deles\n')

    const preview = await g.featurePreview(repo)
    expect(preview).toMatchObject({ localCommits: 1, remoteNew: 1 })

    const r = await g.createFeature(repo, 'minha')
    expect(r.ok, JSON.stringify(r.steps, null, 1)).toBe(true)

    const originMain = sh(repo, 'rev-parse', 'origin/main')
    expect(sh(repo, 'rev-parse', 'main')).toBe(originMain)
    // feature = main atual + meu commit por cima
    expect(sh(repo, 'rev-parse', 'HEAD~1')).toBe(originMain)
    expect(sh(repo, 'log', '-1', '--pretty=%s')).toBe('feat: meu')
    expect(sh(remote, 'rev-parse', 'feature/minha')).toBe(sh(repo, 'rev-parse', 'HEAD'))
    // alteração não commitada preservada
    expect((await g.status(repo)).files.map((f) => f.path)).toEqual(['wip.ts'])
  })

  it('com conflito, para no rebase e envia a feature ao concluir', async () => {
    write('README.md', 'LOCAL\n')
    await g.commit(repo, ['README.md'], 'feat: local')
    remoteCommit('README.md', 'REMOTO\n')

    const r = await g.createFeature(repo, 'conflito')
    expect(r.ok).toBe(false)
    expect(r.steps.some((s) => s.label.startsWith('Conflito ao atualizar a feature'))).toBe(true)
    expect(await g.currentOperation(repo)).toBe('rebase')
    expect(sh(repo, 'rev-parse', 'main')).toBe(sh(repo, 'rev-parse', 'origin/main'))

    await g.resolveConflict(repo, 'README.md', 'mine')
    const c = await g.continueOperation(repo)
    expect(c.ok, JSON.stringify(c.steps, null, 1)).toBe(true)
    expect(c.steps.map((s) => s.label)).toContain('Feature enviada para origin')
    expect(sh(repo, 'show', 'HEAD:README.md')).toBe('LOCAL')
    expect(sh(repo, 'rev-parse', 'HEAD~1')).toBe(sh(repo, 'rev-parse', 'origin/main'))
    expect(sh(remote, 'rev-parse', 'feature/conflito')).toBe(sh(repo, 'rev-parse', 'HEAD'))
  })
})

describe('git — publicar', () => {
  it('branch publicada normalmente', async () => {
    const st = await g.status(repo)
    expect(st).toMatchObject({ published: true, unpublished: 0 })
  })

  it('upstream configurado mas inexistente no remoto ("gone") conta como não publicada', async () => {
    const empty = path.join(tmp, 'vazio.git')
    sh(tmp, 'init', '-q', '--bare', '-b', 'main', empty)
    sh(repo, 'remote', 'set-url', 'origin', empty)
    sh(repo, 'fetch', '-q', '--prune', 'origin')
    let st = await g.status(repo)
    expect(st.upstream).toBe('origin/main')
    expect(st).toMatchObject({ published: false, unpublished: 1 })

    const r = await g.push(repo)
    expect(r.ok, r.error).toBe(true)
    expect(r.steps[0].label).toBe('Branch publicada: origin/main')
    st = await g.status(repo)
    expect(st).toMatchObject({ published: true, unpublished: 0 })
  })

  it('sem remote: valida a URL e publica depois de ligar o remote', async () => {
    sh(repo, 'remote', 'remove', 'origin')
    let st = await g.status(repo)
    expect(st).toMatchObject({ hasRemote: false, published: false, unpublished: 1 })
    expect((await g.publishToUrl(repo, 'nao é url')).error).toMatch(/URL de repositório válida/)
    expect((await g.status(repo)).hasRemote).toBe(false)

    const novo = path.join(tmp, 'novo.git')
    sh(tmp, 'init', '-q', '--bare', '-b', 'main', novo)
    // caminho feliz com um remote local (publishToUrl só aceita URLs de servidor)
    sh(repo, 'remote', 'add', 'origin', novo)
    expect((await g.push(repo)).ok).toBe(true)
    st = await g.status(repo)
    expect(st).toMatchObject({ hasRemote: true, published: true })
  })
})

describe('git — SHA dos commits criados', () => {
  it('commit e commitGroups devolvem os SHAs na ordem', async () => {
    write('x.ts', 'x')
    write('y.ts', 'y')
    const r = await g.commitGroups(repo, [
      { files: ['x.ts'], message: 'feat: x' },
      { files: ['y.ts'], message: 'feat: y' }
    ])
    expect(r.commits?.map((c) => c.message)).toEqual(['feat: x', 'feat: y'])
    expect(r.commits?.[1].sha).toBe(sh(repo, 'rev-parse', 'HEAD'))
    expect(r.commits?.[0].sha).toBe(sh(repo, 'rev-parse', 'HEAD~1'))
  })
})

describe('git — prefixo da branch', () => {
  it('cria fix/<nome> e recusa prefixo inválido', async () => {
    write('b.ts', 'b')
    await g.commit(repo, ['b.ts'], 'fix: b')
    expect((await g.createFeature(repo, 'x', 'não vale')).error).toMatch(/Prefixo inválido/)
    const r = await g.createFeature(repo, 'Corrige Login', 'fix')
    expect(r.ok, JSON.stringify(r.steps)).toBe(true)
    expect((await g.status(repo)).branch).toBe('fix/corrige-login')
  })
})
