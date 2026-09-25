import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as b from '../src/main/branches'
import * as g from '../src/main/git'

let tmp: string, remote: string, repo: string
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const write = (rel: string, c: string) => writeFileSync(path.join(repo, rel), c)

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-br-'))
  remote = path.join(tmp, 'r.git')
  repo = path.join(tmp, 'repo')
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', remote)
  sh(tmp, 'clone', '-q', remote, repo)
  sh(repo, 'config', 'user.name', 'T')
  sh(repo, 'config', 'user.email', 't@e')
  write('a.txt', 'a\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'inicial')
  sh(repo, 'push', '-q', '-u', 'origin', 'main')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('linhas de trabalho', () => {
  it('lista locais e as que só existem no servidor', async () => {
    const other = path.join(tmp, 'o')
    sh(tmp, 'clone', '-q', remote, other)
    sh(other, 'switch', '-q', '-c', 'feature/remota')
    sh(other, 'push', '-q', '-u', 'origin', 'feature/remota')
    sh(repo, 'fetch', '-q')
    sh(repo, 'branch', 'fix/local')
    const list = await b.listBranches(repo)
    expect(list.find((x) => x.name === 'main')).toMatchObject({ where: 'local', current: true, published: true })
    expect(list.find((x) => x.name === 'fix/local')).toMatchObject({ where: 'local', published: false })
    expect(list.find((x) => x.name === 'feature/remota')).toMatchObject({ where: 'remote' })
  })

  it('troca para linha que só existe no servidor (cria a local)', async () => {
    const other = path.join(tmp, 'o')
    sh(tmp, 'clone', '-q', remote, other)
    sh(other, 'switch', '-q', '-c', 'feature/remota')
    sh(other, 'push', '-q', '-u', 'origin', 'feature/remota')
    sh(repo, 'fetch', '-q')
    expect((await b.switchBranch(repo, 'feature/remota', 'carry')).ok).toBe(true)
    expect((await g.status(repo)).branch).toBe('feature/remota')
  })

  it('"guardar e trocar": alterações ficam guardadas e voltam ao retornar', async () => {
    sh(repo, 'branch', 'outra')
    write('a.txt', 'minha alteração\n')
    const r = await b.switchBranch(repo, 'outra', 'stash')
    expect(r.ok, r.error).toBe(true)
    expect((await g.status(repo)).files).toEqual([])
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    const back = await b.switchBranch(repo, 'main', 'carry')
    expect(back.steps.map((s) => s.label)).toContain('Suas alterações desta linha voltaram')
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('minha alteração\n')
  })

  it('"levar junto" recusa com explicação quando conflita', async () => {
    sh(repo, 'switch', '-q', '-c', 'outra')
    write('a.txt', 'versão da outra\n')
    sh(repo, 'commit', '-qam', 'outra')
    sh(repo, 'switch', '-q', 'main')
    write('a.txt', 'mexi na main\n')
    const r = await b.switchBranch(repo, 'outra', 'carry')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Guardar e trocar/)
    expect((await g.status(repo)).branch).toBe('main')
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('mexi na main\n')
  })

  it('cria linha nova e recusa nome inválido ou repetido', async () => {
    expect((await b.createBranch(repo, '-x')).ok).toBe(false)
    expect((await b.createBranch(repo, 'nova linha')).ok).toBe(false)
    expect((await b.createBranch(repo, 'feature/nova')).ok).toBe(true)
    expect((await g.status(repo)).branch).toBe('feature/nova')
    expect((await b.createBranch(repo, 'feature/nova')).error).toMatch(/Já existe/)
  })

  it('limpeza: sugere incorporadas e backups; remove só as candidatas', async () => {
    sh(repo, 'branch', 'feature/pronta') // igual à main: já incorporada
    sh(repo, 'branch', 'backup/auto-2026-01-01-000000')
    sh(repo, 'switch', '-q', '-c', 'feature/em-andamento')
    write('b.txt', 'b\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'wip')
    sh(repo, 'switch', '-q', 'main')
    const c = await b.cleanupCandidates(repo)
    expect(c.map((x) => `${x.name}:${x.reason}`).sort()).toEqual(['backup/auto-2026-01-01-000000:backup', 'feature/pronta:merged'])
    const r = await b.deleteBranches(repo, ['feature/pronta', 'backup/auto-2026-01-01-000000', 'feature/em-andamento', 'main'])
    expect(r.steps.filter((s) => s.ok).length).toBe(2)
    expect(sh(repo, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['feature/em-andamento', 'main'])
  })
})
