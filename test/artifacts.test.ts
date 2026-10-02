import { describe, expect, it } from 'vitest'
import { artifactKind, artifactsDir, findArtifacts, formatSize, splitPath } from '../src/shared/artifacts'

describe('findArtifacts', () => {
  it('acha caminhos absolutos de arquivos gerados no texto', () => {
    const t = 'O Excel está aqui: `/Users/jone/Flexi/flexi2/importacao_2490703_produtos.xlsx`. Veja também /tmp/ovseer/flexi2/relatorio.pdf, ok?'
    expect(findArtifacts(t)).toEqual(['/Users/jone/Flexi/flexi2/importacao_2490703_produtos.xlsx', '/tmp/ovseer/flexi2/relatorio.pdf'])
  })
  it('não repete e ignora código-fonte', () => {
    const t = 'Editei /src/app/main.ts e gerei /tmp/a.csv e de novo /tmp/a.csv (file:///tmp/b.png)'
    expect(findArtifacts(t)).toEqual(['/tmp/a.csv', '/tmp/b.png'])
  })
  it('aceita Windows e ~', () => {
    expect(findArtifacts('salvo em C:\\Temp\\ovseer\\x\\dados.xlsx e ~/Desktop/foto.jpeg')).toEqual(['C:\\Temp\\ovseer\\x\\dados.xlsx', '~/Desktop/foto.jpeg'])
  })
})

describe('utilitários', () => {
  it('splitPath', () => {
    expect(splitPath('/tmp/ovseer/x/a.xlsx')).toEqual({ name: 'a.xlsx', dir: '/tmp/ovseer/x' })
    expect(splitPath('C:\\Temp\\a.pdf')).toEqual({ name: 'a.pdf', dir: 'C:\\Temp' })
  })
  it('artifactKind', () => {
    expect(artifactKind('a.xlsx')).toBe('sheet')
    expect(artifactKind('a.PDF')).toBe('pdf')
    expect(artifactKind('a.tar.gz')).toBe('archive')
    expect(artifactKind('a.webp')).toBe('image')
  })
  it('artifactsDir', () => {
    expect(artifactsDir('/Users/jone/Flexi/flexi2/')).toBe('/Users/jone/Flexi/flexi2/tmp')
    expect(artifactsDir('C:\\Users\\j\\proj')).toBe('C:\\Users\\j\\proj\\tmp')
  })
  it('formatSize', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
