import { describe, expect, it } from 'vitest'
import { assign, move, reasoningPrompt, taskPrompt } from '../src/shared/queue'
import type { QueueTask } from '../src/shared/types'

const t = (id: string, status: QueueTask['status'] = 'queued', cwd?: string): QueueTask => ({ id, text: id, status, cwd, createdAt: 0 })
const agents = [
  { uid: 'a', cwd: '/p/one', title: 'A' },
  { uid: 'b', cwd: '/p/two', title: 'B' },
  { uid: 'c', cwd: '/p/one', title: 'C' }
]

describe('fila de tarefas', () => {
  it('entrega na ordem, um agente por tarefa, respeitando o repositório', () => {
    const pairs = assign([t('1'), t('2', 'queued', '/p/two'), t('3', 'queued', '/p/three'), t('4'), t('5', 'running')], agents, new Set())
    expect(pairs.map((p) => [p.task.id, p.agent.uid])).toEqual([['1', 'a'], ['2', 'b'], ['4', 'c']])
  })
  it('agente já ocupado não pega outra', () => {
    expect(assign([t('1'), t('2')], agents, new Set(['a', 'c'])).map((p) => p.agent.uid)).toEqual(['b'])
  })
  it('sobe e desce só entre as que esperam', () => {
    const list = [t('1', 'done'), t('2'), t('3'), t('4')]
    expect(move(list, '3', -1).map((x) => x.id)).toEqual(['1', '3', '2', '4'])
    expect(move(list, '2', -1).map((x) => x.id)).toEqual(['1', '2', '3', '4'])
    expect(move(list, '4', 1).map((x) => x.id)).toEqual(['1', '2', '3', '4'])
  })
})

import { affinity, clearlyRelated, parsePick, pickPrompt, rankRelated, tokens } from '../src/shared/queue'

describe('fila: afinidade entre a tarefa e as conversas', () => {
  it('palavras com sentido, sem acentos e sem as comuns', () => {
    expect([...tokens('Trocar a mensagem de bloqueio do login por "Acesso negado"')]).toEqual(['trocar', 'mensag', 'bloque', 'login', 'acesso', 'negado'])
  })
  it('pontua e ordena as conversas relacionadas', () => {
    const agents = [
      { uid: 'a', cwd: '/p', title: 'Login: acesso negado', fresh: false, context: 'Login: acesso negado. A tela de login mostra Acesso negado. Tarefas feitas: Trocar a mensagem de bloqueio do login' },
      { uid: 'b', cwd: '/p', title: 'Relatório de vendas', fresh: false, context: 'Relatório de vendas por período em PDF' },
      { uid: 'c', cwd: '/p', title: 'Nova conversa', fresh: true, context: '' }
    ]
    const r = rankRelated('Ajustar a mensagem de acesso negado na tela de login', agents)
    expect(r.map((x) => x.agent.uid)).toEqual(['a'])
    expect(clearlyRelated(r[0])).toBe(true)
    expect(clearlyRelated(affinity('Corrigir o cálculo de frete', 'Relatório de vendas'))).toBe(false)
  })
  it('pedido à IA e leitura da resposta', () => {
    const p = pickPrompt('Ajustar o login', [{ uid: 'a', cwd: '/p', title: 'Login', fresh: false, context: 'Login: acesso negado' }])
    expect(p).toContain('1. Login: acesso negado')
    expect(p).toContain('Responda SÓ com o número')
    expect(parsePick('1', 3)).toBe(1)
    expect(parsePick('Escolho a conversa 2.', 3)).toBe(2)
    expect(parsePick('0', 3)).toBe(0)
    expect(parsePick('7', 3)).toBeNull()
    expect(parsePick('nenhuma', 3)).toBeNull()
  })
})

describe('fila de raciocínio', () => {
  const t = (id: string, extra: Partial<QueueTask> = {}): QueueTask => ({ id, text: `tarefa ${id}`, status: 'queued', createdAt: 1, ...extra })
  it('em raciocínio, a tarefa não vai para agente nenhum; na execução, vai', () => {
    const agents = [{ uid: 'a1', cwd: '/p', title: 'A' }]
    expect(assign([t('r', { stage: 'reasoning' }), t('e')], agents, new Set()).map((x) => x.task.id)).toEqual(['e'])
  })
  it('subir e descer só troca de lugar dentro da mesma fila', () => {
    const list = [t('r1', { stage: 'reasoning' }), t('e1'), t('r2', { stage: 'reasoning' }), t('e2')]
    expect(move(list, 'r2', -1).map((x) => x.id)).toEqual(['r2', 'e1', 'r1', 'e2'])
    expect(move(list, 'e2', -1).map((x) => x.id)).toEqual(['r1', 'e2', 'r2', 'e1'])
    expect(move(list, 'r1', -1)).toBe(list)
  })
  it('o pedido ao agente de raciocínio leva a análise anterior e as observações; o de execução, o raciocínio formado', () => {
    const fresh = t('x', { text: 'Trocar o fuso do relatório', stage: 'reasoning' })
    const p1 = reasoningPrompt(fresh)
    expect(p1).toContain('Tarefa:\nTrocar o fuso do relatório')
    expect(p1).not.toContain('Análise anterior')
    expect(p1).toContain('não altere arquivos')
    expect(p1).not.toContain('mais de um repositório')
    expect(reasoningPrompt({ ...fresh, cwd: '/w/gateway', extraDirs: ['/w/receiver'] })).toContain('Principal: /w/gateway. Outros, também disponíveis para leitura: /w/receiver.')
    const reviewed = { ...fresh, analysis: '**Do que se trata**: o relatório usa UTC.', notes: [{ at: 1, text: 'Usar o fuso do usuário, não o do servidor' }] }
    const p2 = reasoningPrompt(reviewed)
    expect(p2).toContain('Análise anterior:\n**Do que se trata**: o relatório usa UTC.')
    expect(p2).toContain('Observações do usuário, em ordem:\n1. Usar o fuso do usuário, não o do servidor')
    expect(p2).toContain('marque com ✓')
    expect(taskPrompt(fresh)).toBe('Trocar o fuso do relatório')
    const run = taskPrompt(reviewed)
    expect(run.startsWith('Trocar o fuso do relatório\n\n---\n')).toBe(true)
    expect(run).toContain('Análise:\n**Do que se trata**: o relatório usa UTC.')
    expect(run).toContain('Observações do usuário:\n- Usar o fuso do usuário, não o do servidor')
  })
})
