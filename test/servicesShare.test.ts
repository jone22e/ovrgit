import { describe, expect, it } from 'vitest'
import { exportServices, normalizeRemote, parseServicesFile, resolveServices, type RepoRef } from '../src/shared/servicesShare'
import type { Service } from '../src/shared/types'

const flexi: RepoRef = { root: '/Users/jone/Flexi/flexi2', name: 'flexi2', remote: 'github.com/c2s/flexi2' }
const loja: RepoRef = { root: '/Users/jone/Flexi/loja', name: 'loja', remote: '' }
const repoOf = (cwd: string) => [flexi, loja].find((r) => cwd === r.root || cwd.startsWith(r.root + '/')) ?? null

const services: Service[] = [
  { id: '1', name: 'Backend', command: 'npm run dev', cwd: '/Users/jone/Flexi/flexi2/backend' },
  { id: '2', name: 'Loja', command: 'cd /Users/jone/Flexi/loja/web && npm run dev -- --config /Users/jone/Flexi/flexi2/vite.config.ts', cwd: '/Users/jone/Flexi/loja' },
  { id: '3', name: 'Banco', command: 'aws ssm start-session --profile x', cwd: '' },
  { id: '4', name: 'Script', command: 'sh /Users/jone/bin/run.sh', cwd: '/Users/jone/scripts' },
  { id: '5', name: 'Fora', command: 'ls', cwd: '/opt/coisas' }
]

describe('remoto normalizado', () => {
  it('ignora protocolo, credenciais, .git e caixa', () => {
    expect(normalizeRemote('git@github.com:C2S/Flexi2.git')).toBe('github.com/c2s/flexi2')
    expect(normalizeRemote('https://user:token@github.com/c2s/flexi2/')).toBe('github.com/c2s/flexi2')
    expect(normalizeRemote('ssh://git@host.com:2222/org/app.git')).toBe('host.com/org/app')
    expect(normalizeRemote('')).toBe('')
  })
})

describe('exportar serviços', () => {
  const file = exportServices(services, repoOf, '/Users/jone')
  it('pasta vira repositório + caminho dentro dele', () => {
    expect(file.services[0]).toEqual({ name: 'Backend', command: 'npm run dev', repo: 'flexi2', remote: 'github.com/c2s/flexi2', path: 'backend' })
    expect(file.services[1].repo).toBe('loja')
    expect(file.services[1].path).toBe('')
    expect(file.services[1].remote).toBeUndefined()
  })
  it('caminhos absolutos dos comandos viram marcadores', () => {
    expect(file.services[1].command).toBe('cd {repo:loja}/web && npm run dev -- --config {repo:flexi2}/vite.config.ts')
    expect(file.services[3].command).toBe('sh {home}/bin/run.sh')
  })
  it('fora de repositório: relativa à pasta do usuário, ou absoluta', () => {
    expect(file.services[2].cwd).toBeUndefined()
    expect(file.services[3].cwd).toBe('{home}/scripts')
    expect(file.services[4].cwd).toBe('/opt/coisas')
  })
  it('nada do arquivo cita a pasta de quem exportou', () => {
    expect(JSON.stringify(file)).not.toContain('/Users/jone')
  })
})

describe('importar serviços', () => {
  const file = parseServicesFile(JSON.stringify(exportServices(services, repoOf, '/Users/jone')))
  it('troca a raiz pela pasta do outro usuário', () => {
    const out = resolveServices(file, { root: '/home/ana/dev', known: [], home: '/home/ana' })
    expect(out[0]).toEqual({ name: 'Backend', command: 'npm run dev', cwd: '/home/ana/dev/flexi2/backend', repo: 'flexi2', via: 'root' })
    expect(out[1].cwd).toBe('/home/ana/dev/loja')
    expect(out[1].command).toBe('cd /home/ana/dev/loja/web && npm run dev -- --config /home/ana/dev/flexi2/vite.config.ts')
    expect(out[2].cwd).toBe('')
    expect(out[3]).toMatchObject({ cwd: '/home/ana/scripts', command: 'sh /home/ana/bin/run.sh', via: 'file' })
    expect(out[4].cwd).toBe('/opt/coisas')
  })
  it('acha o repositório entre os projetos do usuário: pelo remoto, depois pelo nome', () => {
    const known: RepoRef[] = [
      { root: '/home/ana/trabalho/flexi-novo', name: 'flexi-novo', remote: 'github.com/c2s/flexi2' },
      { root: '/home/ana/outros/loja', name: 'loja', remote: 'github.com/ana/loja' }
    ]
    const out = resolveServices(file, { root: '/home/ana/dev', known, home: '/home/ana' })
    expect(out[0]).toMatchObject({ cwd: '/home/ana/trabalho/flexi-novo/backend', via: 'project' })
    expect(out[1]).toMatchObject({ cwd: '/home/ana/outros/loja', via: 'project' })
    expect(out[1].command).toContain('--config /home/ana/trabalho/flexi-novo/vite.config.ts')
  })
  it('no Windows os caminhos saem com a barra de lá', () => {
    const out = resolveServices(file, { root: 'C:\\dev', known: [], home: 'C:\\Users\\ana' })
    expect(out[0].cwd).toBe('C:\\dev\\flexi2\\backend')
    expect(out[3].cwd).toBe('C:\\Users\\ana\\scripts')
  })
})

describe('arquivo de serviços', () => {
  it('recusa o que não é uma exportação', () => {
    expect(() => parseServicesFile('x')).toThrow(/JSON/)
    expect(() => parseServicesFile('{"a":1}')).toThrow(/não é uma exportação/)
    expect(() => parseServicesFile('{"ovseer":"servicos","services":[{"name":"","command":"x"}]}')).toThrow(/nenhum serviço/)
  })
  it('não deixa o arquivo apontar para fora da raiz', () => {
    const f = parseServicesFile(JSON.stringify({ ovseer: 'servicos', version: 1, services: [{ name: 'a', command: 'b', repo: '../../etc', path: '../../x/./y' }] }))
    expect(f.services[0]).toMatchObject({ repo: 'etc', path: 'x/y' })
  })
})
