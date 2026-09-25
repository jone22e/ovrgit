import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { quickCheck } from '../src/main/assist'

let tmp: string, repo: string
const sh = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-assist-'))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  sh('config', 'user.name', 'T')
  sh('config', 'user.email', 't@e')
  writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1\n')
  sh('add', '.')
  sh('commit', '-qm', 'base')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('checagem antes de salvar', () => {
  it('encontra segredo, .env, debug e marca de conflito', async () => {
    writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1\nconsole.log(a)\nconst t = "ghp_' + 'a'.repeat(36) + '"\n<<<<<<< HEAD\n')
    writeFileSync(path.join(repo, '.env'), 'DB_PASS=segredo\n')
    writeFileSync(path.join(repo, 'ok.ts'), 'export const b = 2\n')
    const f = await quickCheck(repo, ['app.ts', '.env', 'ok.ts'])
    const msgs = f.map((x) => `${x.file}:${x.severity}:${x.message}`)
    expect(msgs.some((m) => m.startsWith('.env:high:Arquivo sensível'))).toBe(true)
    expect(msgs.some((m) => m.startsWith('app.ts:high:Parece ter um token do GitHub'))).toBe(true)
    expect(msgs.some((m) => m.startsWith('app.ts:low:Console.log esquecido'))).toBe(true)
    expect(msgs.some((m) => m.startsWith('app.ts:high:Sobrou uma marca de conflito'))).toBe(true)
    expect(f.some((x) => x.file === 'ok.ts')).toBe(false)
    expect(f.find((x) => x.message.includes('token'))?.line).toBe(3)
  })

  it('chave privada só conta com o corpo; testes podem ter console.log', async () => {
    const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'
    writeFileSync(path.join(repo, 'real.txt'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`)
    writeFileSync(path.join(repo, 'citada.ts'), "const k = '-----BEGIN RSA PRIVATE KEY-----\\nsegredo'\n")
    writeFileSync(path.join(repo, 'x.test.ts'), "write('console.log(1)')\nconsole.log('saida')\n")
    const f = await quickCheck(repo, ['real.txt', 'citada.ts', 'x.test.ts'])
    expect(f.map((x) => x.file)).toEqual(['real.txt'])
    expect(f[0].message).toMatch(/chave privada/)
  })

  it('só olha o que vai ser salvo (arquivos não marcados ficam de fora)', async () => {
    writeFileSync(path.join(repo, 'app.ts'), 'console.log(1)\n')
    expect(await quickCheck(repo, [])).toEqual([])
  })
})
