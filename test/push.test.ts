import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { push } from '../src/main/git'
import { friendlyGitError } from '../src/shared/gitErrors'

let tmp: string, a: string, b: string
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const user = (cwd: string) => {
  sh(cwd, 'config', 'user.name', 'T')
  sh(cwd, 'config', 'user.email', 't@e')
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-push-'))
  const remote = path.join(tmp, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  a = path.join(tmp, 'a')
  b = path.join(tmp, 'b')
  execFileSync('git', ['clone', '-q', remote, a])
  user(a)
  writeFileSync(path.join(a, 'base.txt'), 'base\n')
  sh(a, 'add', '.')
  sh(a, 'commit', '-qm', 'base')
  sh(a, 'push', '-q', '-u', 'origin', 'main')
  execFileSync('git', ['clone', '-q', remote, b])
  user(b)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('Enviar quando o servidor está na frente', () => {
  it('baixa, junta e envia sozinho (mesmo com alterações não salvas)', async () => {
    writeFileSync(path.join(b, 'dela.txt'), 'b\n')
    sh(b, 'add', '.')
    sh(b, 'commit', '-qm', 'versao da colega')
    sh(b, 'push', '-q')

    writeFileSync(path.join(a, 'minha.txt'), 'a\n')
    sh(a, 'add', '.')
    sh(a, 'commit', '-qm', 'minha versao')
    writeFileSync(path.join(a, 'rascunho.txt'), 'nao salvo\n')

    const r = await push(a)
    expect(r.ok).toBe(true)
    expect(r.steps.map((s) => s.label)).toContain('O servidor tinha versões novas')
    sh(b, 'pull', '-q')
    expect(sh(b, 'log', '--format=%s')).toMatch(/minha versao/)
    expect(sh(a, 'status', '--porcelain')).toContain('rascunho.txt')
  })
})

describe('erros do Git em linguagem simples', () => {
  it('traduz os mais comuns', () => {
    expect(friendlyGitError(' ! [rejected]  main -> main (non-fast-forward)\nerror: failed to push')).toMatch(/versões mais novas/)
    expect(friendlyGitError('fatal: Could not resolve host: github.com')).toMatch(/internet/)
    expect(friendlyGitError('remote: error: GH006: Protected branch update failed')).toMatch(/protegida/)
    expect(friendlyGitError('algo inesperado')).toBeNull()
  })
})
