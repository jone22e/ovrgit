import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseClaudeLine, parseCodexLine, type ClaudeParseState, type CodexParseState } from '../src/main/agentChat'
import { SubagentHistory } from '../src/main/subagentHistory'
import { subagentRows, type SubagentSummary, type SubagentUpdate } from '../src/shared/subagents'
import type { AgentChatEvent } from '../src/shared/types'

const root = (): ClaudeParseState => ({ cwd: '/repo', streamed: 0, done: false })
const codex = (): CodexParseState => ({ emitted: new Map(), done: false, error: null })
const updates = (events: AgentChatEvent[]) => events.flatMap((e) => e.type === 'subagent' ? [e.update] : [])
const parse = (data: object, state: ClaudeParseState) => parseClaudeLine(JSON.stringify(data), state)

describe('subagentes nativos do Claude', () => {
  it('mantém mensagens, ferramentas e conclusão do filho fora da resposta e do estado do principal', () => {
    const state = root()
    const start = parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-child', name: 'Agent', input: { description: 'Backend', prompt: 'Analise a API' } }] } }, state)
    expect(updates(start)[0]).toMatchObject({ id: 'claude:tool-child', name: 'Backend', prompt: 'Analise a API', status: 'live' })
    const delta = parse({ type: 'stream_event', parent_tool_use_id: 'tool-child', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Resposta do filho' } } }, state)
    expect(delta).toEqual([{ type: 'subagent', update: { id: 'claude:tool-child', provider: 'claude', event: { type: 'text', delta: 'Resposta do filho' } } }])
    const full = parse({ type: 'assistant', parent_tool_use_id: 'tool-child', message: { content: [{ type: 'text', text: 'Resposta do filho' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/repo/api.ts' } }] } }, state)
    expect(updates(full).some((e) => e.event?.type === 'text')).toBe(false)
    expect(updates(full).some((e) => e.event?.type === 'tool')).toBe(true)
    const finish = parse({ type: 'result', parent_tool_use_id: 'tool-child', is_error: true, result: 'Falha do filho' }, state)
    expect(updates(finish)[0].event).toMatchObject({ type: 'done', ok: false })
    expect(state.done).toBe(false)
    expect(state.streamed).toBe(0)
    expect(parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'Resposta do principal' }] } }, state)).toEqual([{ type: 'text', delta: 'Resposta do principal' }])
  })
  it('mantém netos ligados ao filho correto', () => {
    const state = root()
    const events = parse({ type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'tool_use', id: 'grandchild', name: 'Task', input: { description: 'Revisão', prompt: 'Revise a API' } }] } }, state)
    expect(updates(events)[0]).toMatchObject({ id: 'claude:grandchild', parentId: 'claude:child', name: 'Revisão' })
  })
  it('usa os vínculos reais de task_started, inclusive primeiro plano, e acompanha término assíncrono', () => {
    const state = root()
    parse({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'native-parent', tool_use_id: 'parent', description: 'Principal auxiliar', is_backgrounded: false }, state)
    const child = parse({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'native-child', tool_use_id: 'child', parent_task_id: 'native-parent', description: 'Filho', is_backgrounded: true }, state)
    expect(updates(child)[0]).toMatchObject({ id: 'claude:child', nativeId: 'native-child', parentId: 'claude:parent', status: 'live' })
    const result = parse({ type: 'user', tool_use_result: { isAsync: true, agentId: 'native-child' }, message: { content: [{ type: 'tool_result', tool_use_id: 'child', content: 'Executando em segundo plano' }] } }, state)
    expect(updates(result)[0].status).toBe('live')
    const finished = parse({ type: 'system', subtype: 'task_notification', task_id: 'native-child', status: 'completed', summary: 'Concluído sem erros' }, state)
    expect(updates(finished)[0]).toMatchObject({ id: 'claude:child', status: 'done', result: 'Concluído sem erros' })
    expect(updates(parse({ type: 'system', subtype: 'task_started', task_type: 'local_bash', task_id: 'shell', is_backgrounded: true }, state))).toEqual([])
  })
})

describe('delegações nativas do Codex', () => {
  it('usa ids reais e não confunde conclusão de spawn com conclusão do filho', () => {
    const state = codex()
    parseCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'root-session' }), state)
    const spawn = parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'call-1', type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['child-session'], prompt: 'Revise o backend', agents_states: { 'child-session': { status: 'running' } } } }), state)
    expect(updates(spawn)[0]).toMatchObject({ id: 'codex:child-session', name: 'Revise o backend', prompt: 'Revise o backend' })
    expect(updates(spawn)[0].status).toBeUndefined()
    expect(state.done).toBe(false)
    const wait = parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'call-2', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: ['child-session'], agents_states: { 'child-session': { status: 'completed', message: 'Sem problemas' } } } }), state)
    expect(updates(wait)[0]).toMatchObject({ id: 'codex:child-session', status: 'done', result: 'Sem problemas' })
    expect(updates(wait)[0].name).toBeUndefined()
  })
  it('preserva pais informados e não cria um filho antes de receber seu id', () => {
    const state = codex(); state.sessionId = 'root'
    expect(updates(parseCodexLine(JSON.stringify({ type: 'item.started', item: { id: 'c', type: 'collab_tool_call', receiver_thread_ids: [] } }), state))).toEqual([])
    const nested = parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'nested', type: 'collab_tool_call', sender_thread_id: 'child', receiver_thread_ids: ['grandchild'], agents_states: { grandchild: { status: 'errored', message: 'Falha' } } } }), state)
    expect(updates(nested)[0]).toMatchObject({ id: 'codex:grandchild', parentId: 'codex:child', status: 'error', result: 'Falha' })
  })
})

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function history() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovseer-subagents-')); dirs.push(dir)
  return { dir, store: new SubagentHistory(() => dir) }
}
const update = (patch: Partial<SubagentUpdate> = {}): SubagentUpdate => ({ id: 'claude:child', provider: 'claude', name: 'Backend', ...patch })

describe('histórico e árvore dos filhos', () => {
  it('persiste hierarquia, pedidos, ferramentas e resultado sem misturar sessões', () => {
    const { dir, store } = history()
    store.apply('root', update({ prompt: 'Analise a API' }))
    store.apply('root', update({ prompt: 'Revise os testes' }))
    store.apply('root', update({ event: { type: 'text', delta: 'Tudo ' } }))
    store.apply('root', update({ event: { type: 'text', delta: 'certo' } }))
    store.apply('root', update({ event: { type: 'tool', id: 't', name: 'Bash', title: 'Testes', detail: 'npm test' } }))
    store.apply('root', update({ event: { type: 'toolResult', id: 't', ok: true, output: 'Passou' } }))
    store.apply('root', update({ status: 'done', result: 'Resumo final' }))
    store.apply('root', update({ id: 'claude:grandchild', parentId: 'claude:child', name: 'Revisão', status: 'done' }))
    store.flush()
    const reopened = new SubagentHistory(() => dir)
    const detail = reopened.detail('root', 'claude:child')!
    expect(detail).toMatchObject({ name: 'Backend', prompt: 'Analise a API', requests: ['Revise os testes'], result: 'Resumo final', status: 'done' })
    expect(detail.blocks).toEqual([{ kind: 'text', text: 'Tudo certo' }, expect.objectContaining({ kind: 'tool', title: 'Testes', ok: true, output: 'Passou' })])
    expect(reopened.list('root')).toHaveLength(2)
    expect(reopened.list('root')[0]).not.toHaveProperty('blocks')
    expect(reopened.list('root')[0]).not.toHaveProperty('result')
    expect(reopened.list('other-root')).toEqual([])
    expect(subagentRows(reopened.list('root')).map((r) => [r.agent.id, r.depth])).toEqual([['claude:child', 0], ['claude:grandchild', 1]])
  })
  it('mantém a mesma instância de filho ao receber novos estados e marca interrupção ao reabrir', () => {
    const { dir, store } = history()
    store.apply('root', update())
    store.apply('root', update({ name: 'Nome posterior', result: 'Atualização' }))
    expect(store.list('root')).toHaveLength(1)
    expect(store.list('root')[0].name).toBe('Backend')
    store.flush()
    expect(new SubagentHistory(() => dir).list('root')[0].status).toBe('stopped')
    store.interrupt('root'); store.flush()
    expect(store.list('root')[0].status).toBe('stopped')
  })
  it('recolhe descendentes, mantém órfãos visíveis e termina mesmo se o CLI informar um ciclo', () => {
    const node = (id: string, parentId?: string): SubagentSummary => ({ id, parentId, name: id, provider: 'claude', status: 'done', createdAt: 1, updatedAt: 1 })
    const list = [node('a'), node('b', 'a'), node('c', 'b'), node('orphan', 'missing')]
    expect(subagentRows(list, new Set(['a'])).map((r) => r.agent.id)).toEqual(['a', 'orphan'])
    expect(subagentRows([node('a', 'b'), node('b', 'a')])).toHaveLength(2)
  })
})
