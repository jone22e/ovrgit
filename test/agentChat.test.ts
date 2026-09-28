import { describe, expect, it } from 'vitest'
import type { AgentChatEvent } from '../src/shared/types'
import { claudeArgs, codexArgs, parseClaudeLine, parseCodexLine, type ClaudeParseState, type CodexParseState } from '../src/main/agentChat'
import { QUESTION_FORMAT, formatAnswers, splitQuestions } from '../src/shared/questions'
import { modelLabel } from '../src/shared/models'

const j = (o: object) => JSON.stringify(o)

describe('argumentos dos CLIs', () => {
  it('claude: modelo, esforço, permissões e retomada', () => {
    expect(claudeArgs({ model: 'opus', effort: 'xhigh', mode: 'safe', resume: null })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json',
      '--append-system-prompt', QUESTION_FORMAT, '--model', 'opus', '--effort', 'xhigh', '--permission-mode', 'acceptEdits'
    ])
    expect(claudeArgs({ model: '', effort: 'high', mode: 'safe', resume: null, instructions: 'Responda em PT' })).toContain(`Responda em PT\n\n${QUESTION_FORMAT}`)
    const full = claudeArgs({ model: '', effort: 'high', mode: 'full', resume: 'abc-123' })
    expect(full).toContain('--dangerously-skip-permissions')
    expect(full).not.toContain('--model')
    expect(full.slice(-2)).toEqual(['--resume', 'abc-123'])
  })

  it('codex: exec e exec resume com o pedido pelo stdin', () => {
    expect(codexArgs({ model: 'gpt-5.6-sol', effort: 'high', mode: 'safe', resume: null })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-c', 'sandbox_mode="workspace-write"', '-'
    ])
    const r = codexArgs({ model: '', effort: 'low', mode: 'full', resume: 'thread-1' })
    expect(r.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(r).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(r.slice(-2)).toEqual(['thread-1', '-'])
  })
})

describe('saída do Claude Code (stream-json)', () => {
  const st = (): ClaudeParseState => ({ cwd: '/p', streamed: 0, done: false })

  it('sessão, texto em pedaços, ferramenta com resultado e fim', () => {
    const s = st()
    const evs: AgentChatEvent[] = [
      ...parseClaudeLine(j({ type: 'system', subtype: 'init', session_id: 'S1', model: 'claude-opus-5-5' }), s),
      ...parseClaudeLine(j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá ' } } }), s),
      ...parseClaudeLine(j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'mundo' } } }), s),
      ...parseClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Olá mundo' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/src/a.ts' } }] } }), s),
      ...parseClaudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } }), s),
      ...parseClaudeLine(j({ type: 'result', subtype: 'success', is_error: false, result: 'Olá mundo', duration_ms: 1234, total_cost_usd: 0.01 }), s)
    ]
    expect(evs).toEqual([
      { type: 'session', sessionId: 'S1', model: 'claude-opus-5-5' },
      { type: 'text', delta: 'Olá ' },
      { type: 'text', delta: 'mundo' },
      { type: 'tool', id: 't1', name: 'Edit', title: 'Editou', detail: 'src/a.ts' },
      { type: 'toolResult', id: 't1', ok: true, output: 'ok' },
      { type: 'done', ok: true, error: undefined, durationMs: 1234, costUsd: 0.01 }
    ])
    expect(s.done).toBe(true)
  })

  it('sem pedaços parciais, entrega o texto da mensagem completa uma vez só', () => {
    const s = st()
    const evs = parseClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tudo certo.' }] } }), s)
    expect(evs).toEqual([{ type: 'text', delta: 'Tudo certo.' }])
  })

  it('ignora mensagens internas de subagentes e reporta erro no fim', () => {
    const s = st()
    expect(parseClaudeLine(j({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'interno' }] } }), s)).toEqual([])
    expect(parseClaudeLine(j({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Falhou' }), s)[0]).toMatchObject({ type: 'done', ok: false, error: 'Falhou' })
    expect(parseClaudeLine('não é json', s)).toEqual([])
  })
})

describe('saída do Codex (exec --json)', () => {
  const st = (): CodexParseState => ({ emitted: new Map(), error: null, done: false })

  it('thread, mensagem incremental, comando e fim da vez', () => {
    const s = st()
    const evs: AgentChatEvent[] = [
      ...parseCodexLine(j({ type: 'thread.started', thread_id: 'T1' }), s),
      ...parseCodexLine(j({ type: 'turn.started' }), s),
      ...parseCodexLine(j({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } }), s),
      ...parseCodexLine(j({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '81 passed', exit_code: 0, status: 'completed' } }), s),
      ...parseCodexLine(j({ type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Rodei os ' } }), s),
      ...parseCodexLine(j({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Rodei os testes.' } }), s),
      ...parseCodexLine(j({ type: 'item.completed', item: { id: 'f1', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update' }] } }), s),
      ...parseCodexLine(j({ type: 'turn.completed', usage: { input_tokens: 10 } }), s)
    ]
    expect(evs).toEqual([
      { type: 'session', sessionId: 'T1' },
      { type: 'tool', id: 'c1', name: 'Bash', title: 'Rodou comando', detail: 'npm test' },
      { type: 'toolResult', id: 'c1', ok: true, output: '81 passed' },
      { type: 'text', delta: 'Rodei os ' },
      { type: 'text', delta: 'testes.' },
      { type: 'text', delta: '\n\n' },
      { type: 'files', paths: ['src/a.ts'] },
      { type: 'done', ok: true, error: undefined }
    ])
  })

  it('falha da vez vira fim com erro', () => {
    const s = st()
    expect(parseCodexLine(j({ type: 'turn.failed', error: { message: 'sem crédito' } }), s)).toEqual([{ type: 'done', ok: false, error: 'sem crédito' }])
    const s2 = st()
    parseCodexLine(j({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'deu ruim' } }), s2)
    expect(parseCodexLine(j({ type: 'turn.completed' }), s2)).toEqual([{ type: 'done', ok: false, error: 'deu ruim' }])
  })
})

describe('nome legível do modelo', () => {
  it('claude e codex', () => {
    expect(modelLabel('claude', 'opus')).toBe('Opus')
    expect(modelLabel('claude', 'claude-opus-4-6')).toBe('Opus 4.6')
    expect(modelLabel('claude', 'claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('codex', 'gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(modelLabel('codex', '')).toBe('Padrão da conta')
  })
})

describe('anexos', () => {
  it('imagens pequenas vão em linha; áudio e arquivos só pelo caminho, com aviso', async () => {
    const { attachmentNote, splitAttachments, claudeInputMessage } = await import('../src/main/agentChat')
    const img = { name: 'a.png', path: '/x/a.png', mime: 'image/png', size: 1000, kind: 'image' as const }
    const big = { ...img, name: 'b.png', path: '/x/b.png', size: 10 * 1024 * 1024 }
    const audio = { name: 'v.m4a', path: '/x/v.m4a', mime: 'audio/mp4', size: 2048, kind: 'audio' as const }
    const { inline, byPath } = splitAttachments([img, big, audio])
    expect(inline).toEqual([img])
    expect(byPath).toEqual([big, audio])
    const note = attachmentNote(byPath)
    expect(note).toContain('/x/b.png (imagem')
    expect(note).toContain('/x/v.m4a (áudio; não há transcrição')
    expect(attachmentNote([])).toBe('')
    const msg = JSON.parse(claudeInputMessage('oi', [{ ...img, path: '/nao/existe.png' }]))
    expect(msg.type).toBe('user')
    expect(msg.message.content[0]).toEqual({ type: 'text', text: 'oi' })
    expect(msg.message.content[1].text).toMatch(/não foi possível ler/)
  })

  it('argumentos com imagens', async () => {
    const { claudeArgs, codexArgs } = await import('../src/main/agentChat')
    expect(claudeArgs({ model: '', effort: 'high', mode: 'safe', resume: null, images: 2 })).toContain('--input-format')
    expect(codexArgs({ model: '', effort: 'high', mode: 'safe', resume: null, images: ['/x/a.png'] })).toEqual(expect.arrayContaining(['-i', '/x/a.png']))
  })
})

describe('modo plano', () => {
  it('claude usa o modo plan nativo; codex fica só leitura', async () => {
    const { claudeArgs, codexArgs, normalizeMode } = await import('../src/main/agentChat')
    expect(claudeArgs({ model: '', effort: 'high', mode: 'plan', resume: null })).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(codexArgs({ model: '', effort: 'high', mode: 'plan', resume: null })).toContain('sandbox_mode="read-only"')
    expect(normalizeMode('plan')).toBe('plan')
    expect(normalizeMode('x')).toBe('safe')
  })

  it('o plano do Claude aparece como texto ao sair do modo plano', async () => {
    const { parseClaudeLine } = await import('../src/main/agentChat')
    const evs = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '1. Fazer X\n2. Fazer Y' } }] } }),
      { cwd: '/p', streamed: 0, done: false }
    )
    expect(evs[0]).toEqual({ type: 'text', delta: '\n\n1. Fazer X\n2. Fazer Y\n\n' })
    expect(evs[1]).toMatchObject({ type: 'tool', name: 'ExitPlanMode', title: 'Plano pronto' })
  })
})

describe('erros do Claude em linguagem simples', () => {
  it('versão antiga do CLI para o modelo', async () => {
    const { friendlyClaudeError } = await import('../src/main/agentChat')
    expect(friendlyClaudeError('API Error: 400 Claude Code 2.1.211 does not support this model; version 2.1.280 or newer is required. Run …')).toMatch(/2\.1\.211.*2\.1\.280.*claude update/)
    expect(friendlyClaudeError('API Error: 500 boom')).toBe('boom')
  })
})

describe('comando do Codex sem o invólucro do shell', () => {
  it('tira /bin/zsh -lc e as aspas', async () => {
    const { cleanCommand } = await import('../src/main/agentChat')
    expect(cleanCommand(`/bin/zsh -lc 'sed -n '\\''1,260p'\\'' backend/src/a.ts'`)).toBe(`sed -n '1,260p' backend/src/a.ts`)
    expect(cleanCommand(`/bin/zsh -lc "rg -n \\"build\\" src"`)).toBe(`rg -n "build" src`)
    expect(cleanCommand('npm test')).toBe('npm test')
  })
})

describe('Antigravity (agy)', () => {
  it('argumentos: prompt colado ao -p, modo, esforço e retomada', async () => {
    const { agyArgs } = await import('../src/main/agentChat')
    const a = agyArgs({ model: 'gemini-3.8-flash-high', effort: 'xhigh', mode: 'plan', resume: 'c1', prompt: 'oi' })
    expect(a).toEqual(['--output-format', 'stream-json', '--print=oi', '--model', 'gemini-3.8-flash-high', '--effort', 'max', '--mode', 'plan', '--conversation', 'c1'])
    expect(agyArgs({ model: '', effort: 'high', mode: 'full', resume: null, prompt: 'x' })).toContain('--dangerously-skip-permissions')
  })

  it('saída stream-json: sessão, ferramenta, texto e fim', async () => {
    const { parseAgyLine } = await import('../src/main/agentChat')
    const st = { cwd: '/p', done: false, tools: new Set<number>() }
    const j = (o: object) => JSON.stringify(o)
    const evs = [
      ...parseAgyLine(j({ event: 'init', conversation_id: 'C1', init: {} }), st),
      ...parseAgyLine(j({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls -la' } } } }), st),
      ...parseAgyLine(j({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls -la' }, output: 'x.txt\r\n' } } }), st),
      ...parseAgyLine(j({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Há 1' } }), st),
      ...parseAgyLine(j({ event: 'result', result: { status: 'SUCCESS', response: 'Há 1', duration_seconds: 6.7 } }), st)
    ]
    expect(evs).toEqual([
      { type: 'session', sessionId: 'C1' },
      { type: 'tool', id: 'agy-2', name: 'run_command', title: 'Rodou comando', detail: 'ls -la' },
      { type: 'toolResult', id: 'agy-2', ok: true, output: 'x.txt\n' },
      { type: 'text', delta: 'Há 1' },
      { type: 'done', ok: true, error: undefined, durationMs: 6700 }
    ])
    expect(st.done).toBe(true)
  })

  it('nome legível dos modelos Gemini', async () => {
    const { modelLabel } = await import('../src/shared/models')
    expect(modelLabel('agy', 'gemini-3.8-flash-high')).toBe('Gemini 3.8 Flash (High)')
    expect(modelLabel('agy', 'gemini-3.1-pro-low')).toBe('Gemini 3.1 Pro (Low)')
  })
})

describe('perguntas ao usuário', () => {
  it('tira os blocos ```question do texto e lê pergunta e opções', () => {
    const text = 'Feito.\n\n```question\nVocê autoriza o deploy?\n- Sim, autorizo\n- Não, deixe no código\n```\n\n```question\nPublicar no relato?\n1. Sim\n2) Não\n```\n'
    const r = splitQuestions(text)
    expect(r.text).toBe('Feito.')
    expect(r.questions).toEqual([
      { text: 'Você autoriza o deploy?', options: ['Sim, autorizo', 'Não, deixe no código'] },
      { text: 'Publicar no relato?', options: ['Sim', 'Não'] }
    ])
  })
  it('esconde um bloco ainda aberto enquanto a resposta chega', () => {
    expect(splitQuestions('Olá\n\n```question\nVocê aut').text).toBe('Olá')
    expect(splitQuestions('```js\nconst a = 1\n```').text).toContain('const a = 1')
  })
  it('formata as respostas', () => {
    const qs = [{ text: 'A?', options: ['x'] }, { text: 'B?', options: ['y'] }]
    expect(formatAnswers(qs.slice(0, 1), ['x'])).toBe('x')
    expect(formatAnswers(qs, ['x', 'outra coisa'])).toBe('Respostas:\n1. A?\n   → x\n2. B?\n   → outra coisa')
  })
})
