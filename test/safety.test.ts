import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as g from '../src/main/git'
import * as s from '../src/main/safety'

let tmp: string, remote: string, repo: string
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const write = (rel: string, c: string) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  writeFileSync(path.join(repo, rel), c)
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-safe-'))
  remote = path.join(tmp, 'r.git')
  repo = path.join(tmp, 'repo')
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', remote)
  sh(tmp, 'clone', '-q', remote, repo)
  sh(repo, 'config', 'user.name', 'T')
  sh(repo, 'config', 'user.email', 't@e')
  write('a.txt', 'original\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'inicial')
  sh(repo, 'push', '-q', '-u', 'origin', 'main')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('descartar e recuperar', () => {
  it('descarta modificado e novo, guarda na Lixeira e recupera', async () => {
    write('a.txt', 'mudei\n')
    write('novo/b.txt', 'novo\n')
    write('fica.txt', 'fica\n')
    const r = await s.discard(repo, ['a.txt', 'novo/b.txt'])
    expect(r.ok, r.error).toBe(true)
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(path.join(repo, 'novo/b.txt'))).toBe(false)
    expect((await g.status(repo)).files.map((f) => f.path)).toEqual(['fica.txt'])

    const saved = await s.savedChanges(repo)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ kind: 'trash', ref: 'stash@{0}' })
    expect(saved[0].label).toMatch(/^Descartado: 2 arquivo/)
    expect(saved[0].files.sort()).toEqual(['a.txt', 'novo/b.txt'])

    expect((await s.restoreSaved(repo, 'stash@{0}')).ok).toBe(true)
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('mudei\n')
    expect(readFileSync(path.join(repo, 'novo/b.txt'), 'utf8')).toBe('novo\n')
    expect(await s.savedChanges(repo)).toEqual([])
  })

  it('apagar de vez remove da lista; ref inválida é recusada', async () => {
    write('a.txt', 'x\n')
    await s.discard(repo, ['a.txt'])
    expect((await s.dropSaved(repo, 'stash@{0}; rm -rf /')).ok).toBe(false)
    expect((await s.dropSaved(repo, 'stash@{0}')).ok).toBe(true)
    expect(await s.savedChanges(repo)).toEqual([])
  })
})

describe('desfazer e editar a última versão', () => {
  it('desfaz versão local mantendo as alterações', async () => {
    write('c.txt', 'c\n')
    await g.commit(repo, ['c.txt'], 'feat: c')
    expect((await g.log(repo))[0]).toMatchObject({ subject: 'feat: c', local: true })
    const r = await s.undoLastCommit(repo)
    expect(r.ok, r.error).toBe(true)
    expect(sh(repo, 'log', '-1', '--pretty=%s')).toBe('inicial')
    expect((await g.status(repo)).files.map((f) => f.path)).toEqual(['c.txt'])
  })

  it('edita a mensagem da versão local sem incluir outros arquivos', async () => {
    write('c.txt', 'c\n')
    await g.commit(repo, ['c.txt'], 'feat: c')
    write('d.txt', 'd\n')
    sh(repo, 'add', 'd.txt')
    expect((await s.editLastMessage(repo, 'feat: c corrigido')).ok).toBe(true)
    expect(sh(repo, 'log', '-1', '--pretty=%s')).toBe('feat: c corrigido')
    expect(sh(repo, 'show', '--name-only', '--pretty=format:', 'HEAD')).toBe('c.txt')
  })

  it('recusa desfazer/editar versão já enviada', async () => {
    expect((await g.log(repo))[0].local).toBe(false)
    expect((await s.undoLastCommit(repo)).error).toMatch(/já foi enviada/)
    expect((await s.editLastMessage(repo, 'x')).error).toMatch(/já foi enviada/)
    expect(sh(repo, 'log', '-1', '--pretty=%s')).toBe('inicial')
  })
})

describe('versões de junção', () => {
  it('não deixa desfazer um merge pelo app', async () => {
    sh(repo, 'switch', '-q', '-c', 'outra')
    write('x.txt', 'x\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'x')
    sh(repo, 'switch', '-q', 'main')
    write('y.txt', 'y\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'y')
    sh(repo, 'merge', '-q', '--no-edit', 'outra')
    expect((await g.log(repo))[0].merge).toBe(true)
    expect((await s.undoLastCommit(repo)).error).toMatch(/juntou atualizações/)
  })
})
