import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: (p: string) => p === '/k/id_ed25519' }))
const { sshArgs } = await import('../src/main/terminal')

const base = { id: '1', name: 'prod', host: 'ip-10-20-4-200', user: 'ubuntu', port: 22 }

describe('sshArgs', () => {
  it('monta o comando básico', () => {
    expect(sshArgs(base)).toEqual(['-p', '22', '-o', 'ServerAliveInterval=30', 'ubuntu@ip-10-20-4-200'])
  })

  it('usa chave, porta e pasta inicial (com -t antes do destino)', () => {
    const args = sshArgs({ ...base, port: 2222, identityFile: '/k/id_ed25519', remoteDir: "/home/apps/o'vseer" })
    expect(args).toEqual([
      '-p', '2222', '-o', 'ServerAliveInterval=30', '-i', '/k/id_ed25519', '-t', 'ubuntu@ip-10-20-4-200',
      `cd '/home/apps/o'\\''vseer' && exec "$SHELL" -l`
    ])
  })

  it('recusa injeção de opções e valores inválidos', () => {
    expect(() => sshArgs({ ...base, host: '-oProxyCommand=touch /tmp/x' })).toThrow(/Host inválido/)
    expect(() => sshArgs({ ...base, host: 'a b' })).toThrow(/Host inválido/)
    expect(() => sshArgs({ ...base, user: '-oX' })).toThrow(/Usuário inválido/)
    expect(() => sshArgs({ ...base, port: 70000 })).toThrow(/Porta inválida/)
    expect(() => sshArgs({ ...base, identityFile: '/nao/existe' })).toThrow(/Chave não encontrada/)
  })

  it('sem usuário usa só o host (vale o ~/.ssh/config)', () => {
    expect(sshArgs({ ...base, user: '', host: 'meu-servidor' }).at(-1)).toBe('meu-servidor')
  })
})
