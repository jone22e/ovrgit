import path from 'node:path'
import type { AgentSnapshot, RepoGroup } from '../shared/types'

type Agent = Pick<AgentSnapshot, 'cwd' | 'project' | 'title' | 'status'>

const plain = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const words = (text: string) => plain(text).split(/[^a-z0-9]+/).filter(Boolean)
const nameOf = (root: string) => path.basename(root)

/** Só nomes observados no app: nunca escolhe uma pasta com base no projeto aberto por acaso. */
export function knownProjects(recent: string[], groups: RepoGroup[], agents: Agent[]): string[] {
  return [...new Set([...recent, ...groups.flatMap((g) => g.dirs), ...agents.map((a) => a.cwd)].filter(Boolean))]
}

export function mentionedProjects(text: string, roots: string[], groups: RepoGroup[]): string[] {
  const query = new Set(words(text).filter((w) => w.length >= 4))
  const phrase = ` ${words(text).join(' ')} `
  const matches = roots.filter((root) => words(nameOf(root)).some((part) => [...query].some((w) => part === w || part.startsWith(w))))
  for (const group of groups) {
    const groupName = words(group.name).join(' ')
    if (groupName && phrase.includes(` ${groupName} `)) for (const root of group.dirs) if (roots.includes(root) && !matches.includes(root)) matches.push(root)
  }
  return matches
}

const STATUS: { pattern: RegExp; label: string; statuses: AgentSnapshot['status'][] }[] = [
  { pattern: /\b(trabalhando|rodando|executando|ocupados?|ativos?)\b/, label: 'trabalhando', statuses: ['live'] },
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
  if (!status && !/\b(status|situacao|andamento)\b/.test(query) && !/^\s*(tem|ha|existem|quais|quantos)\b/.test(query)) return null
  if (!/[?]/.test(text) && !/^\s*(tem|ha|existe|quais|quantos|quem|liste|mostre|verifique|veja|me diga|qual)\b/.test(query)) return null

  const mentioned = mentionedProjects(text, roots, groups)
  if (scope?.length && mentioned.length && !mentioned.some((root) => scope.includes(root))) {
    return {
      reply: `O pedido menciona ${mentioned.map(nameOf).join(', ')}, mas o seletor está em ${scope.map(nameOf).join(', ')}. Escolha o projeto certo ou selecione “Todos os projetos”.`,
      speech: 'O projeto selecionado é diferente do que você mencionou. Mostrei os nomes no chat.'
    }
  }
  const selected = scope?.length ? (mentioned.length ? scope.filter((root) => mentioned.includes(root)) : scope) : mentioned
  if (!scope?.length && mentioned.length > 1) {
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
  const names = shown.map((a) => `• ${a.title || 'Agente sem título'} (${a.project || nameOf(a.cwd)}${status ? '' : `; ${a.status}`})`)
  return { reply: [intro, ...names].join('\n'), speech: `${intro.slice(0, -1)}. Mostrei os nomes no chat.` }
}
