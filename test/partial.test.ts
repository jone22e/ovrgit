import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as g from '../src/main/git'
import { commitWithHunks, fileDiff, splitHunks } from '../src/main/partial'

let tmp: string, repo: string
const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n'

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-part-'))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  sh('config', 'user.name', 'T')
  sh('config', 'user.email', 't@e')
  writeFileSync(path.join(repo, 'f.txt'), lines(40, (i) => `linha ${i}`))
  writeFileSync(path.join(repo, 'g.txt'), 'g\n')
  sh('add', '.')
  sh('commit', '-qm', 'inicial')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('salvar só alguns trechos', () => {
  it('salva o 2º trecho e deixa o 1º pendente, sem mexer no arquivo', async () => {
    const edited = lines(40, (i) => (i === 2 ? 'linha 2 ALTERADA' : i === 35 ? 'linha 35 ALTERADA' : `linha ${i}`))
    writeFileSync(path.join(repo, 'f.txt'), edited)
    writeFileSync(path.join(repo, 'g.txt'), 'g mudou\n')
    expect(splitHunks(await fileDiff(repo, 'f.txt')).hunks).toHaveLength(2)

    const r = await commitWithHunks(repo, ['g.txt'], [{ path: 'f.txt', hunks: [1] }], 'fix: só a linha 35')
    expect(r.ok, r.error).toBe(true)
    const inHead = sh('show', 'HEAD:f.txt')
    expect(inHead).toContain('linha 35 ALTERADA')
    expect(inHead).toContain('linha 2\n')
    expect(sh('show', 'HEAD:g.txt')).toBe('g mudou')
    // o arquivo no disco continua com as duas mudanças; a linha 2 segue pendente
    expect(readFileSync(path.join(repo, 'f.txt'), 'utf8')).toBe(edited)
    const st = await g.status(repo)
    expect(st.files.map((f) => `${f.path}:${f.staged}`)).toEqual(['f.txt:false'])
    const pending = splitHunks(await fileDiff(repo, 'f.txt')).hunks
    expect(pending).toHaveLength(1)
    expect(pending[0]).toContain('linha 2 ALTERADA')
  })

  it('recusa seleção vazia e arquivo novo parcial', async () => {
    writeFileSync(path.join(repo, 'novo.txt'), 'x\n')
    expect((await commitWithHunks(repo, [], [{ path: 'f.txt', hunks: [] }], 'x')).error).toMatch(/Nenhum trecho/)
    expect((await commitWithHunks(repo, [], [{ path: 'novo.txt', hunks: [0] }], 'x')).error).toMatch(/só pode ser salvo inteiro/)
    expect(sh('log', '--oneline').split('\n')).toHaveLength(1)
  })
})
