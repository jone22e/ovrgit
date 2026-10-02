import { describe, expect, it } from 'vitest'
import { archPlanRequest, designRequest, designScreens, extractHtml, hasInterface, previewDocument, stripArchMarkers } from '../src/shared/architect'

describe('descoberta', () => {
  it('lê o marcador de interface e o tira do texto exibido', () => {
    const t = '# Planejamento de compras\n## Objetivo\n- sugerir pedidos\n\n[interface] sim\n'
    expect(hasInterface(t)).toBe(true)
    expect(hasInterface('# X\n[interface] não')).toBe(false)
    expect(hasInterface('# X\n[Interface] nao (só backend)')).toBe(false)
    expect(hasInterface('# X\nsem marcador')).toBeUndefined()
    expect(stripArchMarkers(t)).toBe('# Planejamento de compras\n## Objetivo\n- sugerir pedidos\n\n')
  })
  it('o pedido do plano cita o arquivo do conceito quando há', () => {
    expect(archPlanRequest().hidden).not.toContain('conceito visual aprovado está em')
    const withConcept = archPlanRequest('tmp/conceito.html')
    expect(withConcept.visible).toContain('tmp/conceito.html')
    expect(withConcept.hidden).toContain('tmp/conceito.html')
    // a exigência do checklist vai no próprio pedido
    expect(withConcept.hidden).toContain('## Checklist')
  })
})

describe('conceito visual', () => {
  it('extrai o HTML do bloco, mesmo ainda aberto', () => {
    expect(extractHtml('Aqui está:\n```html\n<!doctype html><html><body>oi</body></html>\n```\nfim')).toBe('<!doctype html><html><body>oi</body></html>')
    expect(extractHtml('```html\n<!doctype html>\n<html><body><h1>par')).toBe('<!doctype html>\n<html><body><h1>par')
    expect(extractHtml('<!DOCTYPE html><html></html>')).toBe('<!DOCTYPE html><html></html>')
    expect(extractHtml('ainda pensando…')).toBe('')
    expect(extractHtml('```\nsó texto\n```')).toBe('')
  })
  it('a prévia ganha a política que bloqueia cargas de fora', () => {
    const doc = previewDocument('<html><head><title>x</title></head><body></body></html>')
    expect(doc).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'/)
    expect(previewDocument('<div>solto</div>')).toContain('<body><div>solto</div></body>')
    expect(previewDocument('<html><body></body></html>')).toContain('<head><meta http-equiv')
  })
  it('a prévia sai sem scripts, redirecionamento e <base>', () => {
    const doc = previewDocument('<html><head><base href="https://x.test/"><meta http-equiv="refresh" content="0;url=https://x.test"><script>alert(1)</script></head><body><p>ok</p><script src="https://x.test/a.js"></script></body></html>')
    expect(doc).not.toMatch(/<script|refresh|<base/i)
    expect(doc).toContain('<p>ok</p>')
  })
  it('lista as telas do conceito', () => {
    expect(designScreens('<section data-tela="Análise"></section><section class="a" data-tela=\'Configuração\'>')).toEqual(['Análise', 'Configuração'])
    expect(designScreens('<div></div>')).toEqual([])
  })
  it('a revisão leva o HTML atual e o que ajustar; a primeira versão, não', () => {
    const first = designRequest({ request: 'criar tela', brief: '# Tela' })
    expect(first).toContain('primeira versão')
    expect(first).not.toContain('Versão atual')
    const rev = designRequest({ request: 'criar tela', brief: '# Tela', currentHtml: '<html></html>', note: 'botão maior', history: ['tirar a barra lateral'] })
    expect(rev).toContain('<html></html>')
    expect(rev).toContain('botão maior')
    expect(rev).toContain('- tirar a barra lateral')
  })
})
