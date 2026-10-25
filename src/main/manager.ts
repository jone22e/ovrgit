import path from 'node:path'
import type { AgentSnapshot, QueueTask, RepoGroup } from '../shared/types'

type Agent = Pick<AgentSnapshot, 'cwd' | 'project' | 'title' | 'status'> & Partial<Pick<AgentSnapshot, 'activity' | 'lastUser' | 'summary'>>

const plain = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const words = (text: string) => plain(text).split(/[^a-z0-9]+/).filter(Boolean)
const nameOf = (root: string) => path.basename(root)
const statusLabel: Record<AgentSnapshot['status'], string> = { idle: 'disponível', live: 'trabalhando', waiting: 'aguardando sua resposta', done: 'concluído', error: 'com erro' }

/** Só nomes observados no app: nunca escolhe uma pasta com base no projeto aberto por acaso. */
export function knownProjects(recent: string[], groups: RepoGroup[], agents: Agent[]): string[] {
  return [...new Set([...recent, ...groups.flatMap((g) => g.dirs), ...agents.map((a) => a.cwd)].filter(Boolean))]
}

export function mentionedProjects(text: string, roots: string[], groups: RepoGroup[]): string[] {
  const query = new Set(words(text).filter((w) => w.length >= 4))
  const phrase = ` ${words(text).join(' ')} `
  const exact = roots.filter((root) => {
    const name = words(nameOf(root)).join(' ')
    return phrase.includes(` ${name} `) || (name === 'flexi2' && /\bflexi? (dois|2)\b/.test(phrase))
  })
  const matches = exact.length ? exact : roots.filter((root) => words(nameOf(root)).some((part) => [...query].some((w) => part === w || part.startsWith(w))))
  for (const group of groups) {
    const groupName = words(group.name).join(' ')
    if (groupName && phrase.includes(` ${groupName} `)) for (const root of group.dirs) if (roots.includes(root) && !matches.includes(root)) matches.push(root)
  }
  return matches
}

export function projectOptions(roots: string[]): NonNullable<QueueTask['projectChoices']> {
  const names = roots.map(nameOf)
  return roots.map((cwd, index) => ({ cwd, label: names.filter((name) => name === names[index]).length > 1 ? `${names[index]} (${path.dirname(cwd)})` : names[index] }))
}

/** Uma correção falada não é, por si só, um pedido novo de trabalho. */
export function correctedWords(text: string): string | null {
  const match = plain(text).trim().match(/^(?:eu disse|eu quis dizer|quis dizer|na verdade|corrigindo|nao,? eu disse)\s+(.+?)\s*[.!?]?$/)
  return match?.[1]?.trim() || null
}

/** "Dois" pode ser tanto a opção 2 quanto o projeto flexi2. */
export function ambiguousProjectNumber(text: string, choices: NonNullable<QueueTask['projectChoices']>): { number: number; option: string; projects: string[] } | null {
  const raw = words(text)
  if (raw.length !== 1) return null
  const numberWords: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 }
  const number = numberWords[raw[0]] ?? Number(raw[0])
  if (!Number.isInteger(number) || number < 1 || !choices[number - 1]) return null
  const named = choices.filter(({ cwd }) => Number(nameOf(cwd).match(/\d+$/)?.[0]) === number && cwd !== choices[number - 1].cwd)
  return named.length ? { number, option: choices[number - 1].label, projects: named.map((choice) => choice.label) } : null
}

/** Comando de interface sem alvo claro: não deve virar trabalho de código. */
const newAgentRequest = (query: string) => /^(?:(?:crie|criar|cria|inicie|iniciar) (?:um |o )?(?:novo agente|agente novo|agente)|(?:abre|abra|abrir) (?:um |o )?(?:novo agente|agente novo)) (?:no|na|em|para|pro) (?:projeto )?/.test(query)

export function agentOpeningQuestion(text: string): { reply: string; speech: string } | null {
  const query = words(text).join(' ')
  if (newAgentRequest(query)) {
    return {
      reply: 'Não identifiquei um projeto único para o novo agente. Diga o nome exato do projeto; não criei nenhum agente.',
      speech: 'Preciso do nome exato do projeto para abrir um novo agente.'
    }
  }
  if (!/^(?:abre|abra|abrir|mostra|mostrar|crie|cria|criar) (?:o |um )?(?:novo |nova )?agente$/.test(query) && !/^(?:novo|nova) agente$/.test(query)) return null
  return {
    reply: 'Você quer abrir um agente existente ou iniciar uma conversa nova? Para criar, diga “criar novo agente no projeto” e o nome do projeto. Para abrir um existente, diga o nome do agente. Não encaminhei nenhuma tarefa.',
    speech: 'Você quer abrir um agente existente ou criar um novo? Diga o nome do agente ou o projeto.'
  }
}

/** Só abre a tela Novo agente quando o projeto foi identificado de forma única no pedido. */
export function newAgentProject(text: string, roots: string[], groups: RepoGroup[]): string | null {
  const query = words(text).join(' ')
  if (!newAgentRequest(query)) return null
  const mentioned = mentionedProjects(text, roots, groups)
  return mentioned.length === 1 ? mentioned[0] : null
}

/** Só mostra uma conversa existente quando o nome corresponde a um único agente aberto. */
export function agentToShow(text: string, agents: AgentSnapshot[]): { uid?: string } | null {
  const query = words(text).join(' ')
  const match = query.match(/^(?:abre|abra|abrir|mostra|mostrar) (?:a conversa (?:do|da) )?(?:o |a )?agente (.+)$/)
  if (!match) return null
  const found = agents.filter((agent) => words(agent.title).join(' ') === match[1])
  return { uid: found.length === 1 ? found[0].uid : undefined }
}

/** Uma resposta curta de escolha só vale quando identifica uma única opção real. */
export function chosenProject(text: string, choices: NonNullable<QueueTask['projectChoices']>): string | null {
  if (ambiguousProjectNumber(text, choices)) return null
  const raw = words(correctedWords(text) ?? text)
  if (!raw.length || raw.length > 8) return null
  const numberWords: Record<string, number> = { um: 1, uma: 1, primeiro: 1, primeira: 1, dois: 2, segundo: 2, segunda: 2, tres: 3, terceiro: 3, terceira: 3, quatro: 4, quarto: 4, quarta: 4, cinco: 5, quinto: 5, quinta: 5, seis: 6, sexto: 6, sexta: 6, sete: 7, setimo: 7, setima: 7, oito: 8, oitavo: 8, oitava: 8, nove: 9, nono: 9, nona: 9, dez: 10, decimo: 10, decima: 10 }
  if ((raw[0] === 'opcao' || raw[0] === 'numero') && raw.length === 2) {
    const index = numberWords[raw[1]] ?? Number(raw[1])
    return choices[index - 1]?.cwd ?? null
  }
  if (raw.length === 1) {
    const index = numberWords[raw[0]] ?? Number(raw[0])
    if (Number.isInteger(index) && index > 0) return choices[index - 1]?.cwd ?? null
  }
  const filler = new Set(['eu', 'escolho', 'escolha', 'quero', 'prefiro', 'pode', 'ser', 'e', 'o', 'a', 'no', 'na', 'projeto', 'opcao', 'numero', 'de', 'do', 'da', 'por', 'favor', 'vai', 'para', 'esse', 'essa'])
  const selection = raw.filter((word) => !filler.has(word))
  if (selection.length === 1 && numberWords[selection[0]]) return choices[numberWords[selection[0]] - 1]?.cwd ?? null
  const key = selection.join('')
  const found = choices.filter(({ cwd }) => {
    const name = words(nameOf(cwd)).join('')
    if (key === name) return true
    // O ditado costuma escrever “Flex dois” para o nome flexi2.
    return name === 'flexi2' && (key === 'flexdois' || key === 'flexidois' || key === 'flex2')
  })
  return found.length === 1 ? found[0].cwd : null
}

/** Consulta global: projetos com conversas de agentes abertas neste momento. */
export function openProjectsReply(text: string, agents: Agent[]): { reply: string; speech: string } | null {
  const query = plain(text)
  if (!/\b(projetos?|repositorios?)\b/.test(query) || !/\b(abertos?|abertas?|ativos?|ativas?|execucao)\b/.test(query)) return null
  if (!/\b(quais|quantos|qual|liste|mostre|mostra|diga|tem|tenho|ha|existem)\b/.test(query) && !/^\s*(projetos?|repositorios?)\b/.test(query)) return null
  const running = /\b(ativos?|ativas?|execucao)\b/.test(query)
  const withAgents = /\b(agentes?|conversas?)\b/.test(query)
  const counts = new Map<string, number>()
  for (const agent of agents) if (!running || agent.status === 'live') counts.set(agent.cwd, (counts.get(agent.cwd) ?? 0) + 1)
  const label = running ? 'em execução' : 'com agentes abertos'
  if (!counts.size) return { reply: `Não há projetos ${label} agora.`, speech: `Não há projetos ${label} agora.` }
  const projects = [...counts].sort(([a], [b]) => nameOf(a).localeCompare(nameOf(b), 'pt'))
  return {
    reply: [`${projects.length} ${projects.length === 1 ? 'projeto' : 'projetos'} ${label} agora:`, ...projects.flatMap(([root, count]) => [
      `• ${nameOf(root)}: ${count} ${count === 1 ? 'agente' : 'agentes'}`,
      ...(withAgents ? agents.filter((agent) => agent.cwd === root && (!running || agent.status === 'live')).map((agent) => `  - ${agent.title || 'Agente sem título'}`) : [])
    ])].join('\n'),
    speech: `Há ${projects.length} ${projects.length === 1 ? 'projeto' : 'projetos'} ${label}. Mostrei a lista no chat.`
  }
}

/** Projetos conhecidos pelo aplicativo, inclusive os que não têm agentes abertos. */
export function knownProjectsReply(text: string, roots: string[], agents: Agent[]): { reply: string; speech: string } | null {
  const query = plain(text)
  if (!/\b(projetos?|repositorios?)\b/.test(query) || /\b(abertos?|abertas?|ativos?|ativas?|execucao)\b/.test(query)) return null
  if (!/\b(quais|quantos|liste|mostre|mostra|conhecidos?|cadastrados?|informacoes|situacao|status)\b/.test(query)) return null
  if (!/[?]/.test(text) && !/^\s*(quais|quantos|liste|mostre|mostra|me diga|qual|projetos?|repositorios?|status|situacao|informacoes)\b/.test(query)) return null
  const ordered = [...roots].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'pt'))
  if (!ordered.length) return { reply: 'Não há projetos conhecidos no aplicativo.', speech: 'Não encontrei projetos conhecidos no aplicativo.' }
  const withAgents = /\b(agentes?|conversas?)\b/.test(query)
  return {
    reply: [`${ordered.length} ${ordered.length === 1 ? 'projeto conhecido' : 'projetos conhecidos'}:`, ...ordered.flatMap((root) => {
      const group = agents.filter((agent) => agent.cwd === root)
      const live = group.filter((agent) => agent.status === 'live').length
      return [`• ${nameOf(root)}: ${group.length} ${group.length === 1 ? 'agente aberto' : 'agentes abertos'}, ${live} em execução`,
        ...(withAgents ? group.map((agent) => `  - ${agent.title || 'Agente sem título'} (${statusLabel[agent.status]})`) : [])]
    })].join('\n'),
    speech: `Encontrei ${ordered.length} ${ordered.length === 1 ? 'projeto conhecido' : 'projetos conhecidos'}. Mostrei a situação no chat.`
  }
}

const STATUS: { pattern: RegExp; label: string; statuses: AgentSnapshot['status'][] }[] = [
  { pattern: /\b(trabalhando|rodando|executando|execucao|fazendo|ocupados?|ativos?)\b/, label: 'trabalhando', statuses: ['live'] },
  { pattern: /\b(aguardando|esperando|pendentes?)\b/, label: 'aguardando sua resposta', statuses: ['waiting'] },
  { pattern: /\b(falharam|falhou|erros?)\b/, label: 'com erro', statuses: ['error'] },
  { pattern: /\b(concluidos?|terminaram|finalizados?)\b/, label: 'concluídos', statuses: ['done'] }
]

/** Responde consultas com os retratos reais; a fala é curta, e os nomes ficam no chat. */
export function agentStatusReply(text: string, agents: Agent[], roots: string[], groups: RepoGroup[], scope?: string[]): { reply: string; speech: string } | null {
  const query = plain(text)
  if (!/\b(agentes?|conversas?)\b/.test(query)) return null
  if (/\b(corrigir|ajustar|criar|implementar|alterar|consertar|desenvolver)\b/.test(query)) return null
  const status = STATUS.find((s) => s.pattern.test(query))
  if (!status && !/\b(status|situacao|andamento|informacoes|detalhes|atividade|fazendo)\b/.test(query) && !/^\s*(tem|ha|existem|quais|quantos|liste|mostre|mostra|todos os agentes)\b/.test(query)) return null
  if (!/[?]/.test(text) && !/^\s*(tem|ha|existe|quais|quantos|quem|o que|liste|mostre|mostra|verifique|veja|me diga|me fale|qual|informe|agentes?|conversas?|status|situacao|informacoes|todos os agentes)\b/.test(query)) return null

  const mentioned = mentionedProjects(text, roots, groups)
  const selected = mentioned.length > 1 && scope?.length ? mentioned.filter((root) => scope.includes(root)) : mentioned
  if (mentioned.length > 1 && selected.length !== 1) {
    const lines = mentioned.map((root) => {
      const matching = agents.filter((a) => a.cwd === root && (!status || status.statuses.includes(a.status)))
      return `• ${nameOf(root)}: ${matching.length} ${matching.length === 1 ? 'agente' : 'agentes'}${matching.length ? ` — ${matching.map((a) => a.title || 'Sem título').join(', ')}` : ''}`
    })
    const count = mentioned.reduce((total, root) => total + agents.filter((a) => a.cwd === root && (!status || status.statuses.includes(a.status))).length, 0)
    const spokenLabel = status?.label === 'concluídos' && count === 1 ? 'concluído' : status?.label ?? (count === 1 ? 'aberto' : 'abertos')
    return {
      reply: [`Encontrei vários projetos com esse nome; situação dos agentes ${status?.label ?? 'abertos'} em cada um:`, ...lines].join('\n'),
      speech: count
        ? `Encontrei ${count} ${count === 1 ? 'agente' : 'agentes'} ${spokenLabel} nos projetos com esse nome. Mostrei quem são no chat.`
        : `Não encontrei agentes ${status?.label ?? 'abertos'} nos projetos com esse nome. Mostrei cada projeto no chat.`
    }
  }
  const relevant = selected.length ? agents.filter((a) => selected.includes(a.cwd)) : agents
  const place = selected.length ? ` em ${selected.map(nameOf).join(', ')}` : ' em todos os projetos'
  const shown = status ? relevant.filter((a) => status.statuses.includes(a.status)) : relevant
  if (!shown.length) {
    const reply = status ? `Não há agentes ${status.label}${place} agora.` : `Não há agentes abertos${place} agora.`
    return { reply, speech: reply }
  }
  const label = status?.label === 'concluídos' && shown.length === 1 ? 'concluído' : status?.label
  const intro = status
    ? `${shown.length} ${shown.length === 1 ? 'agente' : 'agentes'} ${label}${place} agora:`
    : `${shown.length} ${shown.length === 1 ? 'agente aberto' : 'agentes abertos'}${place}:`
  const names = shown.map((a) => {
    const activity = a.status === 'live' && a.activity?.trim() ? `Atividade: ${a.activity.trim()}`
      : a.status === 'live' && a.lastUser?.trim() ? `Pedido: ${a.lastUser.trim()}`
      : a.status === 'done' && a.summary?.trim() ? `Última resposta: ${a.summary.trim()}` : ''
    return `• ${a.title || 'Agente sem título'} (${a.project || nameOf(a.cwd)}; ${statusLabel[a.status]})${activity ? ` — ${activity.slice(0, 220)}${activity.length > 220 ? '…' : ''}` : ''}`
  })
  return { reply: [intro, ...names].join('\n'), speech: `${intro.slice(0, -1)}. Mostrei os nomes no chat.` }
}

export type ManagerDecision =
  | { action: 'reply'; reply: string; speech?: string }
  | { action: 'delegate'; cwd?: string; agentUid?: string }

/** Contexto factual do agente raiz. Ele decide; o processo principal valida o destino antes de executar. */
export function managerPrompt(request: string, roots: string[], agents: AgentSnapshot[], history: QueueTask[], selectedCwd?: string, readableCwd?: string, selectedProvider?: string): string {
  const agentCounts = new Map<string, number>()
  for (const agent of agents) agentCounts.set(agent.cwd, (agentCounts.get(agent.cwd) ?? 0) + 1)
  const projects = projectOptions(roots).map((project) => ({ ...project, agents: agentCounts.get(project.cwd) ?? 0 }))
  const snapshots = agents.map((agent) => ({
    uid: agent.uid, cwd: agent.cwd, title: agent.title, status: statusLabel[agent.status], provider: agent.provider,
    context: (agent.status === 'live' ? agent.activity || agent.lastUser || agent.summary
      : agent.status === 'waiting' ? agent.lastUser || agent.activity || agent.summary
        : agent.summary || agent.lastUser || agent.activity)?.slice(0, 180)
  }))
  const previous = history.filter((task) => task.managed).slice(-6).map((task) => ({
    request: task.text.slice(0, 400), cwd: task.cwd, agentUid: task.uid, agentTitle: task.agentTitle,
    status: task.status, reply: task.reply?.slice(0, 500)
  }))
  return [
    'Você é o agente raiz do Ovseer e conversa em português do Brasil. Você coordena os agentes dos projetos e também responde diretamente quando pode.',
    'Escolha uma ação para o pedido atual:',
    '- reply: responda por conta própria a conversa, explicação, planejamento ou pergunta que possa ser resolvida com o contexto fornecido, raciocínio e, quando houver um projeto acessível, leitura de arquivos. Cite os arquivos usados. Use somente fatos observados para afirmações sobre projetos e agentes. Se faltarem dados, diga precisamente o que falta.',
    '- delegate: somente para um pedido explícito de trabalho que exija executar comandos, modificar código ou acompanhar um agente existente. Escolha cwd somente entre os caminhos conhecidos. Use agentUid somente quando houver prova de que aquela conversa é o destino certo e ela usa o provedor selecionado; caso contrário, deixe vazio.',
    'Perguntas sobre o que foi feito, comandos de interface, frases curtas e correções como "eu disse flexi2" não autorizam criar tarefas. Use reply com os fatos disponíveis ou peça esclarecimento, sem inventar resultados e sem delegar.',
    'Você pode consultar arquivos somente em modo leitura no projeto acessível indicado. Não altere arquivos. Não afirme que uma alteração ou tarefa foi feita quando precisa delegar. O projeto selecionado é o destino padrão das tarefas, não limita as perguntas globais.',
    'Responda APENAS um objeto JSON, sem markdown: {"action":"reply","reply":"texto para o chat","speech":"uma frase curta para falar em voz alta"} OU {"action":"delegate","cwd":"caminho conhecido se identificado","agentUid":"uid existente se identificado"}.',
    'Na fala, não leia listas ou detalhes: diga que os mostrou no chat. Se não houver caminho seguro para delegar, deixe cwd vazio; o app apresentará as opções.',
    '',
    `Contexto factual: ${JSON.stringify({ selectedCwd: selectedCwd || null, readableCwd: readableCwd || null, selectedProvider: selectedProvider || null, projects, agents: snapshots, previous })}`,
    `Pedido atual: ${JSON.stringify(request)}`
  ].join('\n')
}

export function parseManagerDecision(text: string): ManagerDecision | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (value.action === 'reply' && typeof value.reply === 'string' && value.reply.trim()) {
      return { action: 'reply', reply: value.reply.trim().slice(0, 8000), speech: typeof value.speech === 'string' ? value.speech.trim().slice(0, 300) || undefined : undefined }
    }
    if (value.action === 'delegate') return {
      action: 'delegate',
      cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
      agentUid: typeof value.agentUid === 'string' ? value.agentUid : undefined
    }
  } catch { /* resposta fora do formato: o gerenciador mantém o pedido sem executar */ }
  return null
}
