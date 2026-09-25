import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/shared/types'

const root = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-codex-'))
process.env.OVRGIT_CODEX_DIR = root
process.env.OVRGIT_CLAUDE_DIR = path.join(root, 'sem-claude')
const { startAgentWatch, stopAgentWatch, listAgents } = await import('../src/main/agentWatch')
afterAll(() => {
  stopAgentWatch()
  rmSync(root, { recursive: true, force: true })
})

const d = new Date()
const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
const line = (o: object) => JSON.stringify(o) + '\n'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('acompanhar tarefas do Codex', () => {
  it('detecta trabalhando → terminou, com pasta, linha, título e última mensagem', async () => {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rollout-teste.jsonl')
    writeFileSync(
      file,
      line({ type: 'session_meta', payload: { id: 's1', cwd: '/Users/jone/Flexi/flexi2', git: { branch: 'feature/road-20-comissao' } } }) +
        line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }) +
        line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Atualização explícita da comissão do indicador na venda' }] } })
    )
    const finished: AgentSession[] = []
    startAgentWatch({ onUpdate: () => {}, onFinished: (s) => finished.push(s) })
    appendFileSync(file, line({ type: 'event_msg', payload: { type: 'task_started', started_at: Math.floor(Date.now() / 1000) } }))
    await wait(6000)
    let list = listAgents()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ running: true, branch: 'feature/road-20-comissao', cwd: '/Users/jone/Flexi/flexi2' })
    expect(list[0].title).toBe('Atualização explícita da comissão do indicador na venda')

    appendFileSync(
      file,
      line({ type: 'event_msg', payload: { type: 'task_complete', completed_at: Math.floor(Date.now() / 1000), duration_ms: 263000, last_agent_message: 'Pronto: 2 arquivos alterados.' } })
    )
    await wait(6000)
    list = listAgents()
    expect(list[0]).toMatchObject({ running: false, durationMs: 263000, lastMessage: 'Pronto: 2 arquivos alterados.' })
    expect(finished.map((f) => f.title)).toEqual(['Atualização explícita da comissão do indicador na venda'])
  }, 20000)
})

describe('títulos e mensagens do Codex', () => {
  it('tira o que o app injeta e o markdown', async () => {
    const { cleanRequest, plainText } = await import('../src/main/agentWatch')
    const req = '\n# Files mentioned by the user:\n\n## codex-clipboard-1.png: /tmp/x.png\n\nDistinguish instructions.\n\n## My request:\npor que esse item nao calcula imposto?\n <image name=[Image #1] path="/tmp/x.png">  </image>'
    expect(cleanRequest(req)).toBe('por que esse item nao calcula imposto?')
    expect(cleanRequest('# Files mentioned by the user:\n\n## a.png: /x')).toBe('')
    expect(plainText('Implementado.\n- A venda usa **5%** em [`x.ts`](/a/x.ts).')).toBe('Implementado. A venda usa 5% em x.ts.')
  })
})

describe('Claude (app e Claude Code)', () => {
  it('acompanha a vez: pedido → trabalhando → end_turn → terminou', async () => {
    const croot = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-claude-'))
    process.env.OVRGIT_CLAUDE_DIR = croot
    const proj = path.join(croot, '-Users-x-loja')
    mkdirSync(proj)
    const file = path.join(proj, 'abc.jsonl')
    const L = (o: object) => JSON.stringify(o) + '\n'
    const base = { cwd: '/Users/x/loja', gitBranch: 'feature/road-7-frete', sessionId: 'abc' }
    writeFileSync(file, L({ type: 'custom-title', customTitle: 'Calcular frete grátis', sessionId: 'abc' }))
    stopAgentWatch()
    const finished: AgentSession[] = []
    startAgentWatch({ onUpdate: () => {}, onFinished: (s) => finished.push(s) })
    const t0 = Date.now()
    appendFileSync(file, L({ ...base, type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'frete grátis acima de 200' } }))
    appendFileSync(file, L({ ...base, type: 'assistant', timestamp: new Date(t0 + 1000).toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } }))
    appendFileSync(file, L({ ...base, type: 'user', timestamp: new Date(t0 + 2000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }))
    await new Promise((r) => setTimeout(r, 5600))
    let a = listAgents().find((x) => x.source === 'claude')!
    expect(a).toMatchObject({ running: true, title: 'Calcular frete grátis', branch: 'feature/road-7-frete', cwd: '/Users/x/loja' })
    appendFileSync(file, L({ ...base, type: 'assistant', timestamp: new Date(t0 + 90_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Pronto: **frete grátis** ativo.' }] } }))
    await new Promise((r) => setTimeout(r, 5600))
    a = listAgents().find((x) => x.source === 'claude')!
    expect(a).toMatchObject({ running: false, durationMs: 90_000, lastMessage: 'Pronto: frete grátis ativo.' })
    expect(finished.filter((f) => f.source === 'claude')).toHaveLength(1)
    stopAgentWatch()
    rmSync(croot, { recursive: true, force: true })
  }, 20_000)
})
