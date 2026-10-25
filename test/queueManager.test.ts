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
  actions: [] as { uid: string; action: any }[]
}))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ provider: 'codex', queueReuse: true, queueSmart: true, codexModel: '' }) }))
vi.mock('../src/main/quickAi', () => ({ quickAsk: vi.fn(async () => '0') }))
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

it('aceita o nome falado ou a posição da opção sem confundir uma pergunta com escolha', async () => {
  const { chosenProject, mentionedProjects, projectOptions } = await import('../src/main/manager')
  const flexi = path.join(userData, 'flexi2')
  const lite = path.join(userData, 'flexi-lite')
  const choices = projectOptions([flexi, lite])
  expect(chosenProject('Flex dois.', choices)).toBe(flexi)
  expect(chosenProject('a segunda opção', choices)).toBe(lite)
  expect(chosenProject('Quais projetos tem aberto?', choices)).toBeNull()
  expect(mentionedProjects('Ajustar a tela do Flex dois', [flexi, lite], [])).toEqual([flexi])
})

it('encaminha para uma conversa relacionada e ocupada do mesmo projeto; cria agente quando não há relação', async () => {
  fake.snapshots.push(
    { uid: 'related', cwd: project, provider: 'codex', status: 'live', title: 'Login: acesso negado', lastUser: 'Corrigir mensagem de acesso negado no login', summary: '', paths: [] },
    { uid: 'wrong-project', cwd: other, provider: 'codex', status: 'done', title: 'Exportação em PDF', lastUser: 'Criar exportação em PDF', summary: '', paths: [] }
  )
  const queue = await import('../src/main/queue')
  queue.setupQueue(() => undefined)
  const image = queue.saveBlob({ name: 'captura.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) })
  expect(existsSync(image.path)).toBe(true)
  expect(image.name).toBe('captura.png')
  const config = { provider: 'codex' as const, model: 'gpt-6-sol', effort: 'high' as const, mode: 'full' as const }

  const first = queue.add({ text: 'Ajustar mensagem de acesso negado no login', cwd: project, managed: true, attachments: [image], config }).at(-1)!
  await vi.waitFor(() => expect(fake.actions).toHaveLength(1))
  expect(fake.actions[0]).toMatchObject({ uid: 'related', action: { type: 'enqueue', taskId: first.id, attachments: [{ path: image.path }], model: 'gpt-6-sol', effort: 'high', mode: 'full' } })
  expect(first.status).toBe('queued')
  queue.started(first.id, 'related')
  expect(first.status).toBe('running')
  queue.finished(first.id, 'related', true)
  expect(first.status).toBe('done')

  const second = queue.add({ text: 'Criar exportação em PDF', cwd: project, managed: true, attachments: [image], config }).at(-1)!
  await vi.waitFor(() => expect(fake.opened).toHaveLength(1))
  expect(fake.opened[0]).toMatchObject({ cwd: project, firstMessage: second.text, firstFiles: [image.path], firstAttachments: [{ name: image.name, path: image.path }], managerTaskId: second.id, model: 'gpt-6-sol', quiet: true })
  expect(second.via).toBe('new')
  expect(fake.actions).toHaveLength(1)

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
  const openedBefore = fake.opened.length
  const actionsBefore = fake.actions.length
  const status = queue.add({ text: 'Tem algum agente trabalhando no flexi?', cwd: flexi, managed: true }).at(-1)!
  expect(status.status).toBe('done')
  expect(status.reply).toContain('Estoque do Flexi (flexi2)')
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
  expect(exactStatus.reply).toContain('Estoque do Flexi (flexi2)')
  const globalStatus = queue.add({ text: 'Quais agentes estão trabalhando?', managed: true }).at(-1)!
  expect(globalStatus.reply).toContain('Estoque do Flexi (flexi2)')
  expect(globalStatus.reply).toContain('Login: acesso negado')
  const projectsStatus = queue.add({ text: 'Quais projetos tem aberto.', managed: true }).at(-1)!
  expect(projectsStatus.reply).toContain('projetos com agentes abertos')
  expect(projectsStatus.reply).toContain('flexi2: 1 agente')
  expect(projectsStatus.reply).toContain('flexi-lite: 1 agente')
  expect(projectsStatus.projectChoices).toBeUndefined()

  const ambiguous = queue.add({ text: 'Ajustar a tela do flexi', managed: true }).at(-1)!
  expect(ambiguous.reply).toContain('mais de um projeto')
  expect(ambiguous.status).toBe('done')
  expect(ambiguous.projectChoices?.map((choice) => choice.label)).toEqual(expect.arrayContaining(['flexi2', 'flexi-lite']))
  const routed = queue.add({ text: 'Ajustar a tela do flexi2', managed: true, config }).at(-1)!
  expect(routed.cwd).toBe(flexi)
  expect(routed.reply).toBeUndefined()
  const spokenName = queue.add({ text: 'Ajustar a tela do Flex dois', managed: true, config }).at(-1)!
  expect(spokenName.cwd).toBe(flexi)
  expect(spokenName.reply).toBeUndefined()
  const conflicting = queue.add({ text: 'Ajustar a tela do flexi2', cwd: other, managed: true, config }).at(-1)!
  expect(conflicting.reply).toContain('O seletor está em')
  expect(conflicting.status).toBe('done')

  const pending = queue.add({ text: 'Ajustar novamente a tela do flexi', managed: true, config }).at(-1)!
  expect(pending.projectChoices?.length).toBeGreaterThan(1)
  const spokenChoice = queue.add({ text: 'Flex dois.', managed: true }).at(-1)!
  expect(spokenChoice.resumedTaskId).toBe(pending.id)
  expect(spokenChoice.reply).toContain('flexi2')
  expect(pending.cwd).toBe(flexi)
  expect(pending.reply).toBeUndefined()
  expect(pending.projectChoices).toBeUndefined()
  expect(['queued', 'running', 'done']).toContain(pending.status)

  const anotherPending = queue.add({ text: 'Ajustar outra tela do flexi', managed: true, config }).at(-1)!
  expect(() => queue.chooseProject(anotherPending.id, other)).toThrow('não está mais disponível')
  queue.chooseProject(anotherPending.id, flexiLite)
  expect(anotherPending.cwd).toBe(flexiLite)
  expect(anotherPending.projectChoices).toBeUndefined()

  const legacy = queue.add({ text: 'Ajustar a integração do flexi', managed: true, config }).at(-1)!
  legacy.projectChoices = undefined
  legacy.reply = 'Encontrei mais de um projeto no pedido: flexi2, flexi-lite. Escolha o projeto principal no seletor.'
  queue.resume()
  expect(legacy.projectChoices?.map((choice) => choice.cwd)).toContain(flexi)
  projectsStatus.reply = 'Escolha um projeto no seletor ou cite o nome dele.'
  queue.resume()
  expect(projectsStatus.projectChoices).toBeUndefined()
})
