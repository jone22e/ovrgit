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

/** Uma resposta curta de escolha só vale quando identifica uma única opção real. */
export function chosenProject(text: string, choices: NonNullable<QueueTask['projectChoices']>): string | null {
  const raw = words(text)
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
