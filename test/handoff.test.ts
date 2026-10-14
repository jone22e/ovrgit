import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../src/shared/types'
import { handoffDigest, handoffPreamble, handoffTranscript } from '../src/shared/handoff'
import { CONTINUE_REQUEST } from '../src/shared/autoRetry'

const turn = (user: string, extra: Partial<AgentTurn> = {}): AgentTurn => ({ id: user, user, attachments: [], blocks: [], running: false, thinking: false, ...extra })
const text = (t: string): AgentTurn['blocks'][number] => ({ kind: 'text', text: t })
const files = (...paths: string[]): AgentTurn['blocks'][number] => ({ kind: 'files', paths })

describe('handoffDigest', () => {
  it('pedido inicial, pedidos seguintes, arquivos alterados e onde parou', () => {
    const turns = [
      turn('Cria a tela de login com e-mail e senha', { blocks: [text('Pronto. A tela de login está em src/Login.vue, com validação dos dois campos.'), files('src/Login.vue', 'src/router.ts')] }),
      turn(CONTINUE_REQUEST, { blocks: [text('Continuei.')] }),
      turn('Agora adiciona "esqueci a senha"', { blocks: [text('## Feito\n\nO link "esqueci a senha" leva para /recuperar e manda o e-mail pelo serviço existente.'), files('src/Login.vue', 'src/Recover.vue')] })
    ]
    const d = handoffDigest(turns)
    expect(d).toContain('Pedido inicial: Cria a tela de login com e-mail e senha')
    expect(d).toContain('Pedidos seguintes: Agora adiciona "esqueci a senha"')
    expect(d).not.toContain('Continue a tarefa')
    expect(d).toContain('Arquivos alterados: src/Login.vue, src/router.ts, src/Recover.vue')
    expect(d).toContain('Onde parou: O link "esqueci a senha" leva para /recuperar')
  })
  it('a última resposta falhou: diz o erro; mensagens silenciosas não contam', () => {
    const turns = [turn('Roda os testes', { blocks: [text('Rodando…')] }), turn('', { silent: true }), turn('De novo', { error: 'Codex saiu com código 1' })]
    const d = handoffDigest(turns)
    expect(d).toContain('A última resposta falhou: Codex saiu com código 1')
    expect(d).toContain('Pedidos seguintes: De novo')
  })
})

describe('handoffTranscript', () => {
  it('condensa cada vez e corta do começo quando passa do limite', () => {
    const turns = [turn('Primeiro pedido', { blocks: [text('Primeira resposta'), files('a.ts')] }), turn('Segundo pedido', { blocks: [text('Segunda resposta')] })]
    expect(handoffTranscript(turns)).toBe('Usuário: Primeiro pedido\nAgente: Primeira resposta\nArquivos alterados: a.ts\n\nUsuário: Segundo pedido\nAgente: Segunda resposta')
    const cut = handoffTranscript(turns, 40)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('Segunda resposta')).toBe(true)
    expect(cut.length).toBe(41)
  })
})

describe('handoffPreamble', () => {
  it('apresenta o contexto como sequência de outra conversa, com o título quando há', () => {
    expect(handoffPreamble('Objetivo: login.', 'Tela de login')).toMatch(/sequência a outra.*“Tela de login”[\s\S]*Objetivo: login\./)
    expect(handoffPreamble('x')).not.toContain('“')
  })
})
