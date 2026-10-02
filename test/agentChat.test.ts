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
  it('claude usa o modo plan nativo; codex planeja sem sandbox (só a instrução impede alterações)', async () => {
    const { claudeArgs, codexArgs, normalizeMode } = await import('../src/main/agentChat')
    expect(claudeArgs({ model: '', effort: 'high', mode: 'plan', resume: null })).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(claudeArgs({ model: '', effort: 'high', mode: 'checklist', resume: null })).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    const codexPlan = codexArgs({ model: '', effort: 'high', mode: 'plan', resume: null })
    expect(codexPlan).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(codexPlan.join(' ')).not.toContain('sandbox_mode')
    expect(codexArgs({ model: '', effort: 'high', mode: 'safe', resume: null })).toContain('sandbox_mode="workspace-write"')
    expect(normalizeMode('plan')).toBe('plan')
    expect(normalizeMode('checklist')).toBe('checklist')
    expect(normalizeMode('x')).toBe('safe')
  })

  it('codex: a orientação do modo plano deixa a pergunta "implementar?" para o app', async () => {
    const { CODEX_PLAN_INSTRUCTIONS } = await import('../src/main/agentChat')
    expect(CODEX_PLAN_INSTRUCTIONS).toMatch(/Não pergunte se deve implementar/)
    expect(CODEX_PLAN_INSTRUCTIONS).toMatch(/o próprio app\npergunta ao usuário/)
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
      { text: 'Você autoriza o deploy?', options: [{ label: 'Sim, autorizo' }, { label: 'Não, deixe no código' }] },
      { text: 'Publicar no relato?', options: [{ label: 'Sim' }, { label: 'Não' }] }
    ])
  })
  it('lê explicação e marca de recomendado nas opções', () => {
    const r = splitQuestions('```question\nQual cálculo?\n- 1 ponto da venda (recomendado) — ceder 1% reduz de 5% para 4%\n- Somente em R$ - mantém o campo atual\n- Outro\n```')
    expect(r.questions[0].options).toEqual([
      { label: '1 ponto da venda', detail: 'ceder 1% reduz de 5% para 4%', recommended: true },
      { label: 'Somente em R$', detail: 'mantém o campo atual' },
      { label: 'Outro' }
    ])
  })
  it('esconde um bloco ainda aberto enquanto a resposta chega', () => {
    expect(splitQuestions('Olá\n\n```question\nVocê aut').text).toBe('Olá')
    expect(splitQuestions('```js\nconst a = 1\n```').text).toContain('const a = 1')
  })
  it('formata as respostas', () => {
    const qs = [{ text: 'A?', options: [{ label: 'x' }] }, { text: 'B?', options: [{ label: 'y' }] }]
    expect(formatAnswers(qs.slice(0, 1), ['x'])).toBe('x')
    expect(formatAnswers(qs, ['x', 'outra coisa'])).toBe('Respostas:\n1. A?\n   → x\n2. B?\n   → outra coisa')
    expect(formatAnswers(qs, ['x', undefined])).toBe('Respostas:\n1. A?\n   → x\n2. B?\n   → (sem resposta)')
  })
})

describe('grid de posicionamento da janela', () => {
  const area = { x: 0, y: 25, width: 1200, height: 775 }

  it('divide a área útil da tela em colunas × linhas e cobre a extensão escolhida', async () => {
    const { gridBounds } = await import('../src/main/agentChat')
    expect(gridBounds(area, { cols: 6, rows: 2, col: 0, colSpan: 3, row: 0, rowSpan: 2 })).toEqual({ x: 0, y: 25, width: 600, height: 775 })
    expect(gridBounds(area, { cols: 6, rows: 2, col: 3, colSpan: 3, row: 1, rowSpan: 1 })).toEqual({ x: 600, y: 413, width: 600, height: 387 })
    expect(gridBounds(area, { cols: 1, rows: 1, col: 0, colSpan: 1, row: 0, rowSpan: 1 })).toEqual(area)
  })

  it('células vizinhas encostam sem fresta e a escolha fora do grid é encaixada', async () => {
    const { gridBounds } = await import('../src/main/agentChat')
    const a = gridBounds(area, { cols: 7, rows: 3, col: 2, colSpan: 1, row: 1, rowSpan: 1 })
    const b = gridBounds(area, { cols: 7, rows: 3, col: 3, colSpan: 1, row: 2, rowSpan: 1 })
    expect(a.x + a.width).toBe(b.x)
    expect(a.y + a.height).toBe(b.y)
    expect(gridBounds(area, { cols: 4, rows: 2, col: 9, colSpan: 5, row: -1, rowSpan: 0 })).toEqual({ x: 900, y: 25, width: 300, height: 388 })
  })
})

describe('anexo em pasta temporária', () => {
  it('reconhece as pastas temporárias do sistema, inclusive a da captura de tela do macOS', async () => {
    const { isTemporaryPath } = await import('../src/main/agentChat')
    expect(isTemporaryPath('/var/folders/y1/abc/T/TemporaryItems/NSIRD_screencaptureui_x/Captura de Tela.png')).toBe(true)
    expect(isTemporaryPath('/private/var/folders/y1/abc/T/foto.png')).toBe(true)
    expect(isTemporaryPath('/tmp/foto.png')).toBe(true)
    expect(isTemporaryPath('C:\\Users\\jone\\AppData\\Local\\Temp\\foto.png', 'C:\\Users\\jone\\AppData\\Local\\Temp')).toBe(true)
    expect(isTemporaryPath('/Users/jone/Desktop/Captura de Tela.png')).toBe(false)
    expect(isTemporaryPath('/Users/jone/Flexi/ovrgit/tmp/foto.png')).toBe(false)
  })
})

describe('janela nova na próxima área livre do grid', () => {
  const area = { x: 0, y: 25, width: 1200, height: 775 }

  it('células menores que a janela mínima juntam vizinhas; a primeira área livre vence', async () => {
    const { freeGridSlot } = await import('../src/main/agentChat')
    // 6 × 2 em 1200 × 775: a tela só comporta 3 colunas de 360, então o grid vira 3 × 2 (células de 400 × 387)
    const left = { x: 0, y: 25, width: 400, height: 388 }
    expect(freeGridSlot(area, { cols: 6, rows: 2 }, [])).toEqual(left)
    expect(freeGridSlot(area, { cols: 6, rows: 2 }, [left])).toEqual({ x: 400, y: 25, width: 400, height: 388 })
    const top = [left, { x: 400, y: 25, width: 400, height: 388 }, { x: 800, y: 25, width: 400, height: 388 }]
    expect(freeGridSlot(area, { cols: 6, rows: 2 }, top)).toEqual({ x: 0, y: 413, width: 400, height: 387 })
    // 7 × 3 numa tela de 3440 × 1415: cada janela fica numa célula só
    expect(freeGridSlot({ x: 0, y: 25, width: 3440, height: 1415 }, { cols: 7, rows: 3 }, [])).toEqual({ x: 0, y: 25, width: 491, height: 472 })
  })

  it('grid muda de tamanho: as janelas mantêm a célula, e quem não cabe vai para a área livre', async () => {
    const { regridBounds } = await import('../src/main/agentChat')
    const big = { x: 0, y: 25, width: 2400, height: 1000 }
    const cell = (cols: number, rows: number, col: number, row: number) => ({ x: (2400 / cols) * col, y: 25 + (1000 / rows) * row, width: 2400 / cols, height: 1000 / rows })
    const tiny = { width: 100, height: 100 }
    // três janelas de uma célula na linha de baixo de um 6 × 2 (colunas 1, 2 e 3)
    const three = [cell(6, 2, 1, 1), cell(6, 2, 2, 1), cell(6, 2, 3, 1)]
    // mais colunas: mesma célula, mais estreitas
    expect(regridBounds(big, { cols: 6, rows: 2 }, { cols: 8, rows: 2 }, three, tiny)).toEqual([cell(8, 2, 1, 1), cell(8, 2, 2, 1), cell(8, 2, 3, 1)])
    // menos colunas: mais largas; a da coluna 3 saiu do grid e vai para a primeira área livre
    expect(regridBounds(big, { cols: 6, rows: 2 }, { cols: 3, rows: 2 }, three, tiny)).toEqual([cell(3, 2, 1, 1), cell(3, 2, 2, 1), cell(3, 2, 0, 0)])
    // janela na altura toda continua na altura toda; célula menor que a janela mínima junta vizinhas
    const tall = [{ x: 0, y: 25, width: 400, height: 1000 }]
    expect(regridBounds(big, { cols: 6, rows: 2 }, { cols: 6, rows: 4 }, tall, tiny)).toEqual(tall)
    // grid além do limite da tela (2400 / 420 = 5 colunas): fica em 5 × 2
    expect(regridBounds(big, { cols: 6, rows: 2 }, { cols: 12, rows: 2 }, tall, { width: 420, height: 480 })).toEqual([{ x: 0, y: 25, width: 480, height: 1000 }])
  })

  it('células cobertas: a de outro agente tranca, a da própria janela só marca', async () => {
    const { coveredCells } = await import('../src/main/agentChat')
    // 6 × 2 em 1200 × 775: outro agente na metade esquerda, esta janela na coluna 3 de cima e sobre a coluna 2
    const other = { bounds: { x: 0, y: 25, width: 600, height: 775 }, own: false, title: 'Outro' }
    const mine = { bounds: { x: 400, y: 25, width: 400, height: 387 }, own: true, title: 'Esta' }
    const cells = coveredCells(area, { cols: 6, rows: 2 }, [mine, other])
    expect(cells.filter((c) => !c.own).map((c) => [c.col, c.row])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]])
    expect(cells.filter((c) => c.own).map((c) => [c.col, c.row])).toEqual([[3, 0]])
    expect(coveredCells(area, { cols: 6, rows: 2 }, [])).toEqual([])
  })

  it('só uma janela cobrindo boa parte da célula a ocupa; grid inválido volta ao padrão', async () => {
    const { freeGridSlot } = await import('../src/main/agentChat')
    const { normalizeGrid } = await import('../src/shared/grid')
    const wide = { x: 0, y: 0, width: 1920, height: 1055 }
    // 2 × 1: um pedaço pequeno de janela na célula esquerda não a ocupa
    expect(freeGridSlot(wide, { cols: 2, rows: 1 }, [{ x: 900, y: 0, width: 200, height: 300 }])).toEqual({ x: 0, y: 0, width: 960, height: 1055 })
    // janela colocada à mão cobrindo metade da célula esquerda: passa para a direita
    expect(freeGridSlot(wide, { cols: 2, rows: 1 }, [{ x: 100, y: 0, width: 700, height: 900 }])).toEqual({ x: 960, y: 0, width: 960, height: 1055 })
    expect(normalizeGrid(undefined)).toEqual({ cols: 6, rows: 2 })
    expect(normalizeGrid({ cols: 40, rows: 0 })).toEqual({ cols: 12, rows: 1 })
  })

  it('cada tela tem seu limite de colunas × linhas', async () => {
    const { fitGrid, gridLimitsFor } = await import('../src/shared/grid')
    expect(gridLimitsFor({ width: 3440, height: 1415 })).toEqual({ cols: 9, rows: 4 })
    expect(gridLimitsFor({ width: 1512, height: 950 })).toEqual({ cols: 4, rows: 2 })
    expect(gridLimitsFor({ width: 200, height: 200 })).toEqual({ cols: 1, rows: 1 })
    expect(fitGrid({ cols: 7, rows: 3 }, { width: 3440, height: 1415 })).toEqual({ cols: 7, rows: 3 })
    expect(fitGrid({ cols: 7, rows: 3 }, { width: 1512, height: 950 })).toEqual({ cols: 4, rows: 2 })
  })
})

describe('contagem de linhas por repositório', () => {
  it('arquivos de outro repositório são contados lá e identificados pelo nome da pasta', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { fileStats } = await import('../src/main/agentChat')
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ovseer-stats-'))
    const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    const mk = (name: string) => {
      const dir = path.join(tmp, name)
      mkdirSync(path.join(dir, 'src'), { recursive: true })
      sh(tmp, 'init', '-q', '-b', 'main', dir)
      sh(dir, 'config', 'user.name', 'Teste')
      sh(dir, 'config', 'user.email', 'teste@example.com')
      writeFileSync(path.join(dir, 'src', 'a.ts'), 'a\nb\n')
      sh(dir, 'add', '.')
      sh(dir, 'commit', '-q', '-m', 'inicial')
      return dir
    }
    try {
      const home = mk('flexi2')
      const other = mk('separador')
      writeFileSync(path.join(home, 'src', 'a.ts'), 'a\nb\nc\n')
      writeFileSync(path.join(other, 'src', 'a.ts'), 'x\n')
      writeFileSync(path.join(other, 'src', 'novo.ts'), '1\n2\n3\n')
      const outside = path.join(tmp, 'solto.txt')
      writeFileSync(outside, 'nada')
      const { stats, repos } = await fileStats(home, ['src/a.ts', '../separador/src/a.ts', path.join(other, 'src', 'novo.ts'), outside])
      expect(stats['src/a.ts']).toEqual({ add: 1, del: 0 })
      expect(stats['../separador/src/a.ts']).toEqual({ add: 1, del: 2 })
      expect(stats[path.join(other, 'src', 'novo.ts')]).toEqual({ add: 3, del: 0 })
      expect(stats[outside]).toBeNull()
      expect(repos['src/a.ts']).toBeUndefined()
      expect(repos[outside]).toBeUndefined()
      const real = (p: string) => sh(p, 'rev-parse', '--show-toplevel').trim()
      expect(repos['../separador/src/a.ts']).toEqual({ root: real(other), name: 'separador' })
      expect(repos[path.join(other, 'src', 'novo.ts')]).toEqual({ root: real(other), name: 'separador' })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
