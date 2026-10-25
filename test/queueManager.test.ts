import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(os.tmpdir(), 'ovseer-manager-'))
const project = mkdtempSync(path.join(os.tmpdir(), 'ovseer-project-'))
const other = mkdtempSync(path.join(os.tmpdir(), 'ovseer-other-'))
const fake = vi.hoisted(() => ({
  snapshots: [] as any[],
  opened: [] as any[],
  actions: [] as { uid: string; action: any }[],
  rootAnswers: new Map<string, string>()
}))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ provider: 'codex', queueReuse: true, queueSmart: true, codexModel: '' }) }))
vi.mock('../src/main/quickAi', () => ({ quickAsk: vi.fn(async (_provider: string, prompt: string) => {
  if (!prompt.startsWith('Você é o agente raiz')) return '0'
  return [...fake.rootAnswers].find(([request]) => prompt.includes(`Pedido atual: ${JSON.stringify(request)}`))?.[1] ?? '{"action":"delegate"}'
}) }))
vi.mock('../src/main/reasoner', () => ({ reasonAbout: vi.fn() }))
vi.mock('../src/main/agentChat', () => ({
  agentSnapshots: () => fake.snapshots,
  agentWindowInfos: () => [...fake.snapshots, ...fake.opened],
  describeFile: (file: string) => ({ name: path.basename(file), path: file, mime: 'image/png', size: 3, kind: 'image' }),
  agentInfo: (uid: string) => [...fake.snapshots, ...fake.opened].find((a) => a.uid === uid) ?? null,
  agentBase: () => ({ provider: 'codex', model: '', effort: 'high', mode: 'full', cwd: project }),
  actOnAgent: (uid: string, action: any) => fake.actions.push({ uid, action }),
  setExtraDirs: vi.fn(),
  openAgentWindow: vi.fn(async (opts: any) => {
    const agent = { ...opts, uid: 'new-1', title: 'Novo agente', sessionId: null }
    fake.opened.push(agent)
    return agent
  }),
  availableStandby: () => [],
  onAgentStatus: vi.fn(),
  onAgentGone: vi.fn(),
  onAgentSnapshot: vi.fn()
}))

it('aceita o nome falado e exige clareza quando número e projeto se confundem', async () => {
  const { agentOpeningQuestion, agentToShow, ambiguousProjectNumber, chosenProject, correctedWords, mentionedProjects, newAgentProject, parseManagerDecision, projectOptions } = await import('../src/main/manager')
  const flexi = path.join(userData, 'flexi2')
  const lite = path.join(userData, 'flexi-lite')
  const choices = projectOptions([flexi, lite])
  expect(chosenProject('Flex dois.', choices)).toBe(flexi)
  expect(chosenProject('Eu disse Flex dois.', choices)).toBe(flexi)
  expect(chosenProject('Dois.', choices)).toBeNull()
  expect(ambiguousProjectNumber('Dois.', choices)).toMatchObject({ number: 2, option: 'flexi-lite', projects: ['flexi2'] })
  expect(chosenProject('a segunda opção', choices)).toBe(lite)
  expect(correctedWords('Eu disse Flex dois.')).toBe('flex dois')
  expect(agentOpeningQuestion('Abre o novo agente.')?.reply).toContain('Não encaminhei nenhuma tarefa')
  expect(newAgentProject('Criar novo agente no Flex dois.', [flexi, lite], [])).toBe(flexi)
  expect(newAgentProject('Cria agente no Flex dois.', [flexi, lite], [])).toBe(flexi)
  expect(newAgentProject('Abre agente no Flex dois.', [flexi, lite], [])).toBeNull()
  expect(newAgentProject('Criar novo agente no flexi.', [flexi, lite], [])).toBeNull()
  expect(agentOpeningQuestion('Criar novo agente no flexi.')?.reply).toContain('nome exato do projeto')
  // frases naturais, como saem do ditado
  expect(newAgentProject('Cria um novo agente pra mim com o Flex dois.', [flexi, lite], [])).toBe(flexi)
  expect(newAgentProject('Novo agente no flexi2', [flexi, lite], [])).toBe(flexi)
  expect(newAgentProject('Quero abrir um chat novo para o Flex dois, por favor', [flexi, lite], [])).toBe(flexi)
  expect(newAgentProject('Cria um agente do projeto flexi-lite', [flexi, lite], [])).toBe(lite)
  // pedido com trabalho junto não é conversa nova
  expect(newAgentProject('Cria um agente de scraping no Flex dois', [flexi, lite], [])).toBeNull()
  expect(newAgentProject('Criar um novo agente no Flex dois para revisar o login', [flexi, lite], [])).toBeNull()
  // sem projeto no pedido: o selecionado serve; sem seleção, pergunta
  expect(newAgentProject('Cria um novo agente.', [flexi, lite], [], flexi)).toBe(flexi)
  expect(newAgentProject('Cria um novo agente.', [flexi, lite], [])).toBeNull()
  expect(agentOpeningQuestion('Cria um novo agente.')?.reply).toContain('Em qual projeto')
  expect(parseManagerDecision('{"action":"newAgent","cwd":"/projeto"}')).toEqual({ action: 'newAgent', cwd: '/projeto' })
  expect(agentToShow('Abra o agente Estoque do Flexi', [{ uid: 'agent-1', title: 'Estoque do Flexi' } as any])).toEqual({ uid: 'agent-1' })
  expect(chosenProject('Quais projetos tem aberto?', choices)).toBeNull()
  expect(mentionedProjects('Ajustar a tela do Flex dois', [flexi, lite], [])).toEqual([flexi])
  expect(parseManagerDecision('```json\n{"action":"reply","reply":"Posso explicar.","speech":"Posso explicar."}\n```')).toEqual({ action: 'reply', reply: 'Posso explicar.', speech: 'Posso explicar.' })
  expect(parseManagerDecision('{"action":"delegate","cwd":"/projeto","agentUid":"agent-1"}')).toEqual({ action: 'delegate', cwd: '/projeto', agentUid: 'agent-1' })
  expect(parseManagerDecision('resposta sem decisão')).toBeNull()
})

it('encaminha para uma conversa relacionada e ocupada do mesmo projeto; cria agente quando não há relação', async () => {
  fake.snapshots.push(
    { uid: 'related', cwd: project, provider: 'codex', status: 'live', title: 'Login: acesso negado', activity: 'Revisando autenticação', lastUser: 'Corrigir mensagem de acesso negado no login', summary: '', paths: [] },
    { uid: 'wrong-project', cwd: other, provider: 'codex', status: 'done', title: 'Exportação em PDF', lastUser: 'Criar exportação em PDF', summary: '', paths: [] }
  )
  const queue = await import('../src/main/queue')
  queue.setupQueue(() => undefined)
  const image = queue.saveBlob({ name: 'captura.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) })
  expect(existsSync(image.path)).toBe(true)
  expect(image.name).toBe('captura.png')
  const config = { provider: 'codex' as const, model: 'gpt-6-sol', effort: 'high' as const, mode: 'full' as const }
  fake.rootAnswers.set('Explique o papel do gerenciador.', '{"action":"reply","reply":"Eu acompanho os agentes e encaminho tarefas aos projetos.","speech":"Eu acompanho os agentes e encaminho tarefas."}')
  const answered = queue.add({ text: 'Explique o papel do gerenciador.', managed: true, config }).at(-1)!
  expect(answered.managerThinking).toBe(true)
  await vi.waitFor(() => expect(answered.status).toBe('done'))
  expect(answered.reply).toContain('Eu acompanho os agentes')
  expect(answered.spokenReply).toBe('Eu acompanho os agentes e encaminho tarefas.')
  expect(answered.uid).toBeUndefined()
  const { quickAsk } = await import('../src/main/quickAi')
  expect(vi.mocked(quickAsk).mock.calls.find((call) => call[1].includes('Pedido atual: "Explique o papel do gerenciador."'))?.[3]).toMatchObject(config)
  fake.rootAnswers.set('Responda esta pergunta por conta própria.', 'resposta fora do formato')
  const failedBrain = queue.add({ text: 'Responda esta pergunta por conta própria.', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(failedBrain.status).toBe('failed'))
  expect(failedBrain.managerBrainFailed).toBe(true)
  expect(failedBrain.uid).toBeUndefined()
  fake.rootAnswers.set('Responda esta pergunta por conta própria.', '{"action":"reply","reply":"Resposta recuperada."}')
  queue.retry(failedBrain.id)
  await vi.waitFor(() => expect(failedBrain.status).toBe('done'))
  expect(failedBrain.reply).toBe('Resposta recuperada.')

  const first = queue.add({ text: 'Ajustar mensagem de acesso negado no login', cwd: project, managed: true, attachments: [image], config }).at(-1)!
  await vi.waitFor(() => expect(fake.actions).toHaveLength(1))
  expect(fake.actions[0]).toMatchObject({ uid: 'related', action: { type: 'enqueue', taskId: first.id, attachments: [{ path: image.path }], model: 'gpt-6-sol', effort: 'high', mode: 'full' } })
  expect(first.status).toBe('queued')
  queue.started(first.id, 'related')
  expect(first.status).toBe('running')
  queue.finished(first.id, 'related', true)
  expect(first.status).toBe('done')

  fake.rootAnswers.set('Peça ao agente do login revisar os testes', JSON.stringify({ action: 'delegate', agentUid: 'related' }))
  const directed = queue.add({ text: 'Peça ao agente do login revisar os testes', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(fake.actions.some((item) => item.action.taskId === directed.id)).toBe(true))
  expect(directed.preferredUid).toBe('related')
  expect(fake.actions.find((item) => item.action.taskId === directed.id)?.uid).toBe('related')
  fake.rootAnswers.set('Peça ao agente que foi fechado revisar os testes', '{"action":"delegate","agentUid":"closed-agent"}')
  const missingAgent = queue.add({ text: 'Peça ao agente que foi fechado revisar os testes', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(missingAgent.status).toBe('done'))
  expect(missingAgent.reply).toContain('não está mais disponível')
  expect(missingAgent.uid).toBeUndefined()

  const second = queue.add({ text: 'Criar exportação em PDF', cwd: project, managed: true, attachments: [image], config }).at(-1)!
  await vi.waitFor(() => expect(fake.opened).toHaveLength(1))
  expect(fake.opened[0]).toMatchObject({ cwd: project, firstMessage: second.text, firstFiles: [image.path], firstAttachments: [{ name: image.name, path: image.path }], managerTaskId: second.id, model: 'gpt-6-sol', quiet: true })
  expect(second.via).toBe('new')
  expect(fake.actions).toHaveLength(2)

  queue.add({ text: 'Ajustar login de novo', cwd: project, managed: true, config: { ...config, provider: 'claude', model: 'sonnet' } })
  await vi.waitFor(() => expect(fake.opened).toHaveLength(2))
  expect(fake.opened[1]).toMatchObject({ provider: 'claude', model: 'sonnet' })

  const flexi = path.join(userData, 'flexi2')
  const flexiLite = path.join(userData, 'flexi-lite')
  mkdirSync(flexi)
  mkdirSync(flexiLite)
  fake.snapshots.push(
    { uid: 'flexi-agent', cwd: flexi, project: 'flexi2', provider: 'codex', status: 'live', title: 'Estoque do Flexi', lastUser: 'Conferir estoque', summary: '', paths: [] },
    { uid: 'flexi-lite-agent', cwd: flexiLite, project: 'flexi-lite', provider: 'codex', status: 'done', title: 'Tela do Flexi Lite', lastUser: '', summary: '', paths: [] }
  )
  const openedBeforeControl = fake.opened.length
  const bareNumber = queue.add({ text: 'Dois.', managed: true, managerSessionId: 'voice-call', config }).at(-1)!
  expect(bareNumber.reply).toContain('Não há uma escolha clara')
  const correctionWithoutChoice = queue.add({ text: 'Eu disse Flex dois.', managed: true, managerSessionId: 'voice-call', config }).at(-1)!
  expect(correctionWithoutChoice.reply).toContain('Não criei outra tarefa')
  // conversa nova sem projeto: pergunta com as opções, e a escolha por voz cria a conversa, não uma tarefa
  const vagueOpen = queue.add({ text: 'Abre o novo agente.', managed: true, managerSessionId: 'voice-call', config }).at(-1)!
  expect(vagueOpen.reply).toContain('Não encaminhei nenhuma tarefa')
  expect(vagueOpen.projectChoices?.map((c) => c.cwd)).toContain(flexi)
  const vagueChoice = queue.add({ text: 'Flex dois.', managed: true, managerSessionId: 'voice-call', config }).at(-1)!
  expect(vagueChoice.resumedTaskId).toBe(vagueOpen.id)
  expect(queue.list().find((item) => item.id === vagueOpen.id)).toMatchObject({ status: 'done', managerUiAction: { type: 'newAgent', cwd: flexi } })
  const explicitOpen = queue.add({ text: 'Criar novo agente no Flex dois.', managed: true, config }).at(-1)!
  expect(explicitOpen.managerUiAction).toEqual({ type: 'newAgent', cwd: flexi })
  const naturalOpen = queue.add({ text: 'Cria um novo agente pra mim com o Flex dois.', managed: true, managerSessionId: 'voice-call', config }).at(-1)!
  expect(naturalOpen.status).toBe('done')
  expect(naturalOpen.managerUiAction).toEqual({ type: 'newAgent', cwd: flexi })
  expect(naturalOpen.spokenReply).toBe('Abri um novo agente em flexi2.')
  const ambiguousOpen = queue.add({ text: 'Criar novo agente no flexi.', managed: true, config }).at(-1)!
  expect(ambiguousOpen.managerUiAction).toBeUndefined()
  expect(ambiguousOpen.projectChoices?.map((c) => c.cwd)).toEqual([flexi, flexiLite])
  const chosenOpen = queue.chooseProject(ambiguousOpen.id, flexiLite).find((item) => item.id === ambiguousOpen.id)!
  expect(chosenOpen.status).toBe('done')
  expect(chosenOpen.managerUiAction).toEqual({ type: 'newAgent', cwd: flexiLite })
  const showExisting = queue.add({ text: 'Abra o agente Estoque do Flexi.', managed: true, config }).at(-1)!
  expect(showExisting.managerUiAction).toEqual({ type: 'showAgent', uid: 'flexi-agent' })
  expect(fake.opened).toHaveLength(openedBeforeControl)
  const openedBefore = fake.opened.length
  const actionsBefore = fake.actions.length
  const status = queue.add({ text: 'Tem algum agente trabalhando no flexi?', cwd: flexi, managed: true }).at(-1)!
  expect(status.status).toBe('done')
  expect(status.reply).toContain('Estoque do Flexi (flexi2; trabalhando)')
  expect(status.reply).not.toContain('Tela do Flexi Lite')
  expect(status.spokenReply).toContain('Mostrei os nomes no chat')
  expect(status.spokenReply).not.toContain('Estoque do Flexi')
  expect(fake.opened).toHaveLength(openedBefore)
  expect(fake.actions).toHaveLength(actionsBefore)

  const unclearStatus = queue.add({ text: 'Tem algum agente trabalhando no flexi?', managed: true }).at(-1)!
  expect(unclearStatus.reply).toContain('Encontrei vários projetos')
  expect(unclearStatus.reply).toContain('flexi2: 1 agente')
  expect(unclearStatus.reply).toContain('flexi-lite: 0 agentes')
  expect(unclearStatus.spokenReply).toContain('Encontrei 1 agente trabalhando')
  expect(unclearStatus.spokenReply).not.toContain('Estoque do Flexi')
  const exactStatus = queue.add({ text: 'Tem algum agente trabalhando no flexi2?', managed: true }).at(-1)!
  expect(exactStatus.reply).toContain('Estoque do Flexi (flexi2; trabalhando)')
  const globalStatus = queue.add({ text: 'Quais agentes estão trabalhando?', managed: true }).at(-1)!
  expect(globalStatus.reply).toContain('Estoque do Flexi (flexi2; trabalhando)')
  expect(globalStatus.reply).toContain('Login: acesso negado')
  expect(globalStatus.reply).toContain('Atividade: Revisando autenticação')
  const spokenQuestion = queue.add({ text: 'O que os agentes estão fazendo', managed: true }).at(-1)!
  expect(spokenQuestion.reply).toContain('Atividade: Revisando autenticação')
  expect(spokenQuestion.reply).not.toContain('Tela do Flexi Lite')
  const globalWithTarget = queue.add({ text: 'Agentes em execução', cwd: flexi, managed: true }).at(-1)!
  expect(globalWithTarget.reply).toContain('Login: acesso negado')
  expect(globalWithTarget.reply).toContain('Estoque do Flexi')
  expect(globalWithTarget.reply).not.toContain('Tela do Flexi Lite')
  const projectsStatus = queue.add({ text: 'Quais projetos tem aberto.', managed: true }).at(-1)!
  expect(projectsStatus.reply).toContain('projetos com agentes abertos')
  expect(projectsStatus.reply).toContain('flexi2: 1 agente')
  expect(projectsStatus.reply).toContain('flexi-lite: 1 agente')
  expect(projectsStatus.projectChoices).toBeUndefined()
  const activeProjects = queue.add({ text: 'Projetos ativos', managed: true }).at(-1)!
  expect(activeProjects.reply).toContain('em execução agora')
  expect(activeProjects.reply).toContain('flexi2: 1 agente')
  expect(activeProjects.reply).not.toContain('flexi-lite')
  const projectsAndAgents = queue.add({ text: 'Mostra os projetos e agentes em execução', managed: true }).at(-1)!
  expect(projectsAndAgents.reply).toContain('flexi2: 1 agente')
  expect(projectsAndAgents.reply).toContain('Estoque do Flexi')
  expect(projectsAndAgents.reply).not.toContain('Tela do Flexi Lite')
  const allProjects = queue.add({ text: 'Quais projetos você conhece?', cwd: flexi, managed: true }).at(-1)!
  expect(allProjects.reply).toContain('projetos conhecidos')
  expect(allProjects.reply).toContain('flexi2: 1 agente aberto')
  expect(allProjects.reply).toContain('flexi-lite: 1 agente aberto')
  fake.rootAnswers.set('Rode os testes', JSON.stringify({ action: 'delegate', cwd: flexi }))
  const unspecified = queue.add({ text: 'Rode os testes', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(unspecified.status).toBe('done'))
  expect(unspecified.projectChoices?.map((choice) => choice.cwd)).toContain(flexi)
  expect(unspecified.uid).toBeUndefined()

  const ambiguous = queue.add({ text: 'Ajustar a tela do flexi', managed: true }).at(-1)!
  expect(ambiguous.reply).toContain('mais de um projeto')
  expect(ambiguous.status).toBe('done')
  expect(ambiguous.projectChoices?.map((choice) => choice.label)).toEqual(expect.arrayContaining(['flexi2', 'flexi-lite']))
  const routed = queue.add({ text: 'Ajustar a tela do flexi2', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(routed.managerThinking).toBe(false))
  expect(routed.cwd).toBe(flexi)
  expect(routed.reply).toBeUndefined()
  expect(vi.mocked(quickAsk).mock.calls.find((call) => call[1].includes('Pedido atual: "Ajustar a tela do flexi2"'))?.[3]).toMatchObject({ cwd: flexi })
  const spokenName = queue.add({ text: 'Ajustar a tela do Flex dois', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(spokenName.managerThinking).toBe(false))
  expect(spokenName.cwd).toBe(flexi)
  expect(spokenName.reply).toBeUndefined()
  const conflicting = queue.add({ text: 'Ajustar a tela do flexi2', cwd: other, managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(conflicting.managerThinking).toBe(false))
  expect(conflicting.projectChoices?.map((choice) => choice.cwd)).toContain(flexi)
  expect(conflicting.status).toBe('done')

  const pending = queue.add({ text: 'Ajustar novamente a tela do flexi', managed: true, managerSessionId: 'voice-selection', config }).at(-1)!
  await vi.waitFor(() => expect(pending.managerThinking).toBe(false))
  expect(pending.projectChoices?.length).toBeGreaterThan(1)
  const ambiguousChoice = queue.add({ text: 'Dois.', managed: true, managerSessionId: 'voice-selection', config }).at(-1)!
  expect(ambiguousChoice.reply).toContain('opção 2')
  expect(ambiguousChoice.resumedTaskId).toBeUndefined()
  expect(pending.projectChoices?.length).toBeGreaterThan(1)
  const freshCall = queue.add({ text: 'Flex dois.', managed: true, managerSessionId: 'new-call', config }).at(-1)!
  expect(freshCall.reply).toContain('Entendi o projeto flexi2')
  expect(freshCall.resumedTaskId).toBeUndefined()
  expect(pending.projectChoices?.length).toBeGreaterThan(1)
  const spokenChoice = queue.add({ text: 'Eu disse Flex dois.', managed: true, managerSessionId: 'voice-selection' }).at(-1)!
  expect(spokenChoice.resumedTaskId).toBe(pending.id)
  expect(spokenChoice.reply).toContain('flexi2')
  expect(pending.cwd).toBe(flexi)
  expect(pending.reply).toBeUndefined()
  expect(pending.projectChoices).toBeUndefined()
  expect(['queued', 'running', 'done']).toContain(pending.status)

  const anotherPending = queue.add({ text: 'Ajustar outra tela do flexi', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(anotherPending.managerThinking).toBe(false))
  expect(() => queue.chooseProject(anotherPending.id, other)).toThrow('não está mais disponível')
  queue.chooseProject(anotherPending.id, flexiLite)
  expect(anotherPending.cwd).toBe(flexiLite)
  expect(anotherPending.projectChoices).toBeUndefined()

  const legacy = queue.add({ text: 'Ajustar a integração do flexi', managed: true, config }).at(-1)!
  await vi.waitFor(() => expect(legacy.managerThinking).toBe(false))
  legacy.projectChoices = undefined
  legacy.reply = 'Encontrei mais de um projeto no pedido: flexi2, flexi-lite. Escolha o projeto principal no seletor.'
  queue.resume()
  expect(legacy.projectChoices?.map((choice) => choice.cwd)).toContain(flexi)
  projectsStatus.reply = 'Escolha um projeto no seletor ou cite o nome dele.'
  queue.resume()
  expect(projectsStatus.projectChoices).toBeUndefined()
})
