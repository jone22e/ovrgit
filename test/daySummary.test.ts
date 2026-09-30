import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(os.tmpdir(), 'ovseer-day-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const now = Date.now()
const item = (sessionId: string, title: string, status: string) => ({
  sessionId, title, status, provider: 'codex', model: '', effort: 'high', mode: 'safe', cwd: '/p', project: 'p', createdAt: now, updatedAt: now, turns: 1
})
const tool = (detail: string, ok: boolean, output = '') => ({ kind: 'tool', id: detail, name: 'Bash', title: 'Rodou comando', detail, ok, output, open: false })
const files = (stats: Record<string, { add: number; del: number }>) => ({ kind: 'files', paths: Object.keys(stats), stats })
const turn = (blocks: unknown[]) => ({ id: String(Math.random()), user: 'x', attachments: [], blocks, running: false, thinking: false, startedAt: now })

describe('resumo do dia', () => {
  it('conta agentes, arquivos e deploys; pendências no topo; entregues com testes ou linhas', async () => {
    const dir = path.join(userData, 'agent-history')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: [item('a', 'Tema escuro', 'done'), item('b', 'Sessão única', 'done'), item('c', 'Plano X', 'waiting')] }))
    // a mesma alteração aparece nas duas respostas: conta uma vez, pela mais recente
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', turns: [turn([files({ 'src/a.ts': { add: 5, del: 1 } })]), turn([files({ 'src/a.ts': { add: 7, del: 2 } })])] }))
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ sessionId: 'b', turns: [turn([files({ 'b.md': { add: 1, del: 0 } }), tool('npx vitest run', true, 'Tests  47 passed (47)'), tool('./deploy-console.sh', true)])] }))
    writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ sessionId: 'c', turns: [turn([])] }))
    const { daySummary } = await import('../src/main/agentHistory')
    const s = daySummary(new Set())
    expect(s).toMatchObject({ agents: 3, files: 2, deploys: 1 })
    expect(s.pending).toEqual(['Typecheck não rodado em 1 conversa', 'Aguardando sua resposta: Plano X'])
    expect(s.delivered.map((d) => [d.title, d.detail])).toEqual(
      expect.arrayContaining([['Tema escuro', '+7 −2'], ['Sessão única', '47 testes']])
    )
  })
})
