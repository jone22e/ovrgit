import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOllamaTurn } from '../src/main/ollamaAgent'
import type { AgentChatEvent } from '../src/shared/types'

vi.mock('../src/main/settings', () => ({ getSettings: () => ({ ollamaUrl: 'http://127.0.0.1:11434', agentInstructions: '' }) }))

afterEach(() => vi.unstubAllGlobals())

describe('agente Ollama', () => {
  it('lê um arquivo pelo protocolo de ferramentas e continua a conversa local', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-ollama-test-'))
    try {
      await writeFile(path.join(dir, 'exemplo.txt'), 'conteúdo verificado')
      const sent: { model: string; think: string; options: { num_ctx: number }; messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[] = []
      const answers = [
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'exemplo.txt' } } }] },
        { role: 'assistant', content: 'O arquivo contém conteúdo verificado.' }
      ]
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ message: answers.shift(), prompt_eval_count: 100, eval_count: 12 }), { status: 200 })
      }))
      const events: AgentChatEvent[] = []
      await runOllamaTurn({
        model: 'SparkLLM/Spark-X2.6-4B:latest', effort: 'low', mode: 'plan', cwd: dir,
        prompt: 'Leia exemplo.txt', turns: [], signal: new AbortController().signal, onEvent: (e) => events.push(e)
      })
      expect(sent).toHaveLength(2)
      expect(sent[0]).toMatchObject({ model: 'SparkLLM/Spark-X2.6-4B:latest', think: 'low', options: { num_ctx: 32768 } })
      expect(sent[0].tools.map((t) => t.function.name)).not.toContain('run_command')
      expect(sent[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'conteúdo verificado' })
      expect(events).toContainEqual({ type: 'text', delta: 'O arquivo contém conteúdo verificado.' })
      expect(events).toContainEqual({ type: 'context', context: { used: 112, window: 32768 } })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
