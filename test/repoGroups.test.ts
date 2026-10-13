import { describe, expect, it } from 'vitest'
import { applyGroup, groupMembers, groupOf, repoName, sameRepos, saveGroup } from '../src/shared/repoGroups'

const g = { id: '1', name: 'SmartConnect', dirs: ['/w/gateway', '/w/receiver', '/w/reader'] }

describe('sameRepos', () => {
  it('ignora a ordem, repetidos e a barra final', () => {
    expect(sameRepos(['/a', '/b'], ['/b/', '/a', '/a'])).toBe(true)
    expect(sameRepos(['/a'], ['/a', '/b'])).toBe(false)
    expect(sameRepos([], [])).toBe(true)
  })
})

describe('groupOf', () => {
  it('acha o grupo que é exatamente o principal mais os juntados', () => {
    expect(groupOf([g], '/w/receiver', ['/w/reader', '/w/gateway'])).toBe(g)
    expect(groupOf([g], '/w/gateway', ['/w/reader'])).toBeUndefined()
    expect(groupOf([g], '/w/gateway', ['/w/reader', '/w/receiver', '/w/outro'])).toBeUndefined()
    expect(groupOf([], '/w/gateway', [])).toBeUndefined()
  })
})

describe('applyGroup', () => {
  it('antes da conversa começar, o primeiro do grupo vira o principal se o atual está fora', () => {
    expect(applyGroup(g, '/w/outro', true)).toEqual({ cwd: '/w/gateway', extra: ['/w/receiver', '/w/reader'] })
  })
  it('com o principal dentro do grupo, ele fica e o resto é juntado', () => {
    expect(applyGroup(g, '/w/reader', true)).toEqual({ cwd: '/w/reader', extra: ['/w/gateway', '/w/receiver'] })
    expect(applyGroup(g, '/w/reader/', false)).toEqual({ cwd: '/w/reader/', extra: ['/w/gateway', '/w/receiver'] })
  })
  it('com a conversa começada e o principal fora, o grupo inteiro é juntado', () => {
    expect(applyGroup(g, '/w/outro', false)).toEqual({ cwd: '/w/outro', extra: ['/w/gateway', '/w/receiver', '/w/reader'] })
  })
})

describe('saveGroup', () => {
  it('cria o grupo com o nome limpo e as pastas sem repetidos', () => {
    const [n] = saveGroup([], '  Loja  ', ['/w/a', '/w/b/', '/w/a'])
    expect(n.name).toBe('Loja')
    expect(n.dirs).toEqual(['/w/a', '/w/b'])
    expect(n.id).toBeTruthy()
  })
  it('as mesmas pastas com outro nome renomeiam; o mesmo nome com outras pastas troca as pastas', () => {
    const renamed = saveGroup([g], 'Conectores', ['/w/reader', '/w/receiver', '/w/gateway'])
    expect(renamed.map((x) => x.name)).toEqual(['Conectores'])
    const swapped = saveGroup([g], 'smartconnect', ['/w/a', '/w/b'])
    expect(swapped).toHaveLength(1)
    expect(swapped[0].dirs).toEqual(['/w/a', '/w/b'])
    const other = saveGroup([g], 'Outro', ['/w/a'])
    expect(other.map((x) => x.name)).toEqual(['SmartConnect', 'Outro'])
  })
})

describe('nomes', () => {
  it('mostra os nomes das pastas', () => {
    expect(repoName('/w/gateway/')).toBe('gateway')
    expect(groupMembers(g)).toBe('gateway + receiver + reader')
  })
})
