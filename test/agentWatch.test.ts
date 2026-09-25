import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/shared/types'

const root = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-codex-'))
process.env.OVRGIT_CODEX_DIR = root
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
