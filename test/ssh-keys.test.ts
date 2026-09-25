import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const home = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-home-'))
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  const mocked = { ...real, homedir: () => home }
  return { ...mocked, default: mocked }
})
const { listSshKeys } = await import('../src/main/terminal')

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('listSshKeys', () => {
  it('lista só chaves privadas (pelo cabeçalho), sem .pub, known_hosts ou config', () => {
    const ssh = path.join(home, '.ssh')
    mkdirSync(ssh)
    writeFileSync(path.join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsegredo\n')
    writeFileSync(path.join(ssh, 'id_ed25519.pub'), 'ssh-ed25519 AAAA teste')
    writeFileSync(path.join(ssh, 'deploy.pem'), '-----BEGIN RSA PRIVATE KEY-----\nsegredo\n')
    writeFileSync(path.join(ssh, 'known_hosts'), 'host ssh-ed25519 AAAA')
    writeFileSync(path.join(ssh, 'config'), 'Host x\n  HostName y')
    writeFileSync(path.join(ssh, 'anotacoes.txt'), 'nada de chave aqui')
    expect(listSshKeys().map((p) => path.basename(p))).toEqual(['deploy.pem', 'id_ed25519'])
  })
})
