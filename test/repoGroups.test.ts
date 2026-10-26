import { describe, expect, it } from 'vitest'
import { applyGroup, groupMatches, groupMembers, groupOf, hasWords, promoteConversationIcons, repoMatches, repoName, sameRepos, saveGroup, searchWords } from '../src/shared/repoGroups'

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

describe('promoteConversationIcons', () => {
  it('leva uma imagem antiga para o grupo inteiro e um símbolo para o repositório', () => {
    const image = 'data:image/png;base64,abc='
    const result = promoteConversationIcons([g], {}, [
      { cwd: '/w/gateway', extraDirs: ['/w/reader', '/w/receiver'], icon: image },
      { cwd: '/w/receiver', extraDirs: ['/w/gateway', '/w/reader'] },
      { cwd: '/w/other', icon: 'archive' }
    ])
    expect(result.repoGroups[0].icon).toBe(image)
    expect(result.repoIcons).toEqual({ '/w/other': 'archive' })
  })

  it('preserva ícones do grupo/repositório e não escolhe entre conversas conflitantes', () => {
    const result = promoteConversationIcons([{ ...g, icon: 'folder' }], { '/w/other': 'server' }, [
      { cwd: '/w/gateway', extraDirs: ['/w/reader', '/w/receiver'], icon: 'archive' },
      { cwd: '/w/other', icon: 'cloud' },
      { cwd: '/w/conflict', icon: 'archive' },
      { cwd: '/w/conflict', icon: 'server' }
    ])
    expect(result.repoGroups[0].icon).toBe('folder')
    expect(result.repoIcons).toEqual({ '/w/other': 'server' })
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
  it('mantém o ícone escolhido quando o grupo é renomeado', () => {
    const [renamed] = saveGroup([{ ...g, icon: 'sparkles' }], 'Conectores', [...g.dirs])
    expect(renamed.icon).toBe('sparkles')
    expect(renamed.id).toBe(g.id)
  })
})

describe('nomes', () => {
  it('mostra os nomes das pastas', () => {
    expect(repoName('/w/gateway/')).toBe('gateway')
    expect(groupMembers(g)).toBe('gateway + receiver + reader')
  })
})

describe('busca', () => {
  it('todas as palavras, em qualquer ordem, sem acento nem maiúsculas', () => {
    const words = searchWords('  Recéiver   w ')
    expect(words).toEqual(['receiver', 'w'])
    expect(hasWords(words, '/w/receiver')).toBe(true)
    expect(hasWords(words, '/x/receiver')).toBe(false)
    expect(hasWords(searchWords('configuracao'), '/w/Configuração')).toBe(true)
    expect(hasWords([], '/qualquer')).toBe(true)
  })
  it('o grupo bate pelo nome ou pelas pastas', () => {
    expect(groupMatches(searchWords('smart'), g)).toBe(true)
    expect(groupMatches(searchWords('reader'), g)).toBe(true)
    expect(groupMatches(searchWords('outro'), g)).toBe(false)
  })
  it('não confunde o nome da pasta com um diretório ancestral compartilhado', () => {
    const root = '/Users/jone/Flexi'
    expect(repoMatches(searchWords('flexi'), `${root}/flexi2`)).toBe(true)
    expect(repoMatches(searchWords('flexi'), `${root}/printer-laser`)).toBe(false)
    expect(groupMatches(searchWords('flexi'), { id: '2', name: 'SmartConnect', dirs: [`${root}/gateway`, `${root}/smartconnect`] })).toBe(false)
    expect(groupMatches(searchWords('flexi'), { id: '3', name: 'WMS', dirs: [`${root}/flexi2`, `${root}/separador`] })).toBe(true)
    expect(repoMatches(searchWords('/Flexi/printer'), `${root}/printer-laser`)).toBe(true)
  })
})
