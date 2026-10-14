import type { QueueTask } from './types'

/**
 * Fila de tarefas: a parte pura (quem pega o quê), para o processo principal e para os testes.
 * Cada tarefa na fila vai para o primeiro agente em espera livre; se a tarefa tem repositório, só serve um agente
 * desse repositório. Um agente pega uma tarefa por vez.
 */
export interface StandbyAgent {
  uid: string
  cwd: string
  title: string
}

/** Pares tarefa → agente que começam agora, na ordem da fila */
export function assign(tasks: QueueTask[], agents: StandbyAgent[], busy: Set<string>): { task: QueueTask; agent: StandbyAgent }[] {
  const free = agents.filter((a) => !busy.has(a.uid))
  const out: { task: QueueTask; agent: StandbyAgent }[] = []
  for (const task of tasks) {
    if (task.status !== 'queued' || task.stage === 'reasoning') continue
    const i = free.findIndex((a) => !task.cwd || a.cwd === task.cwd)
    if (i < 0) continue
    out.push({ task, agent: free[i] })
    free.splice(i, 1)
  }
  return out
}

/** Sobe ou desce uma tarefa entre as que esperam na mesma fila (raciocínio ou execução); as outras não saem do lugar */
export function move(tasks: QueueTask[], id: string, dir: -1 | 1): QueueTask[] {
  const self = tasks.find((t) => t.id === id)
  const queued = tasks.filter((t) => t.status === 'queued' && (t.stage === 'reasoning') === (self?.stage === 'reasoning'))
  const i = queued.findIndex((t) => t.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= queued.length) return tasks
  const a = tasks.indexOf(queued[i])
  const b = tasks.indexOf(queued[j])
  const next = [...tasks]
  ;[next[a], next[b]] = [next[b], next[a]]
  return next
}

// ---------- fila de raciocínio: a análise antes da execução ----------

/** O pedido ao agente de raciocínio: entender a tarefa no repositório, sem executar; com observações, rever a análise */
export function reasoningPrompt(task: QueueTask): string {
  const notes = (task.notes ?? []).map((n, i) => `${i + 1}. ${n.text.trim()}`).join('\n')
  const lines = [
    'Você é o agente de raciocínio de uma fila de tarefas. A tarefa abaixo foi anotada e ainda NÃO vai ser executada: seu papel é ajudar a formar o raciocínio antes da execução. Leia o repositório (só leitura) o quanto for preciso para entender do que se trata. Não implemente nada e não altere arquivos.',
    '',
    'Escreva uma análise curta, em português do Brasil, em markdown, com estas seções (título em negrito, itens curtos):',
    '- **Do que se trata**: uma frase.',
    '- **Onde mexe**: arquivos ou módulos prováveis, com os caminhos.',
    '- **Dúvidas em aberto**: perguntas objetivas para o usuário decidir (pule a seção se não houver).',
    '- **Riscos e cuidados**.',
    '- **Esboço de plano**: poucos passos.',
    task.analysis
      ? 'Há uma análise anterior e observações do usuário: incorpore as observações, responda às dúvidas que elas resolvem, ajuste o que mudou e marque com ✓ o que ficou decidido. Entregue a análise inteira atualizada, não só o que mudou.'
      : '',
    '',
    `Tarefa:\n${task.text.trim()}`,
    task.analysis ? `\nAnálise anterior:\n${task.analysis.trim()}` : '',
    notes ? `\nObservações do usuário, em ordem:\n${notes}` : ''
  ]
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** O texto que vai ao agente de execução: o pedido e, se houve raciocínio, a análise e as observações */
export function taskPrompt(task: QueueTask): string {
  const notes = (task.notes ?? []).map((n) => `- ${n.text.trim()}`).join('\n')
  if (!task.analysis && !notes) return task.text
  return [
    task.text.trim(),
    '',
    '---',
    'Raciocínio formado antes de executar (análise de um agente de leitura e observações do usuário). O pedido acima é o que manda; use isto como ponto de partida e confira no código antes de seguir.',
    task.analysis ? `\nAnálise:\n${task.analysis.trim()}` : '',
    notes ? `\nObservações do usuário:\n${notes}` : ''
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- afinidade entre a tarefa e as conversas dos agentes ----------

/** Contexto de um agente disponível: o que a conversa dele já tratou */
export interface AgentContext extends StandbyAgent {
  /** Sem conversa ainda (zerado) */
  fresh: boolean
  /** Título, resumo, último pedido e tarefas anteriores da conversa atual */
  context: string
}

const STOP = new Set(
  'a o e de da do das dos em no na nos nas um uma uns umas que com para por sem sobre como mais menos muito pouco ser ter fazer faz feito fazer esta este esse essa isso isto aquele aquela ao aos à às se não nao sim já ja ou mas então entao também tambem só so até ate depois antes quando onde qual quais todo toda todos todas cada ele ela eles elas eu nós nos você voce me te lhe seu sua seus suas meu minha nosso nossa the and or of to in on for with is are be it this that'.split(
    ' '
  )
)
/** Palavras que carregam sentido (sem acentos, minúsculas, 3+ letras, fora as comuns) */
export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w.length > 6 ? w.slice(0, 6) : w)
  }
  return out
}

/** Quantas palavras com sentido a tarefa e o contexto têm em comum, e a fração disso na tarefa */
export function affinity(task: string, context: string): { shared: number; ratio: number } {
  const a = tokens(task)
  const b = tokens(context)
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return { shared, ratio: a.size ? shared / a.size : 0 }
}

/** Agentes com conversa, do mais ao menos parecido com a tarefa; só os com relação plausível (2+ palavras em comum) */
export function rankRelated(task: string, agents: AgentContext[]): { agent: AgentContext; shared: number; ratio: number }[] {
  return agents
    .filter((a) => !a.fresh && a.context.trim())
    .map((a) => ({ agent: a, ...affinity(task, a.context) }))
    .filter((r) => r.shared >= 2)
    .sort((a, b) => b.shared - a.shared || b.ratio - a.ratio)
}

/** A relação é clara sem precisar de IA: muitas palavras em comum */
export const clearlyRelated = (r: { shared: number; ratio: number }) => r.shared >= 3 && r.ratio >= 0.35

/** Pedido rápido à IA: qual conversa deve continuar com a tarefa (ou nenhuma) */
export function pickPrompt(task: string, candidates: AgentContext[]): string {
  const list = candidates.map((c, i) => `${i + 1}. ${c.context.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
  return `Uma tarefa vai para um agente de IA que trabalha num projeto. Alguns agentes já têm uma conversa em andamento; continuar a conversa certa aproveita o contexto (arquivos já lidos, decisões tomadas). Escolha o agente cuja conversa trata do MESMO assunto da tarefa. Se nenhuma conversa tiver relação clara, responda 0 (agente novo).

Tarefa:
${task.replace(/\s+/g, ' ').slice(0, 600)}

Conversas:
${list}

Regra: só continue uma conversa quando a tarefa for claramente a continuação ou o mesmo assunto dela (mesma tela, módulo ou funcionalidade). Palavras genéricas em comum (como "arquivo", "tela", "responda", "ferramentas") não contam. Na dúvida, responda 0.

Responda SÓ com o número (0 para agente novo).`
}

/** Lê a escolha da IA: índice do candidato (0 = novo); null se a resposta não for um número válido */
export function parsePick(text: string, count: number): number | null {
  const m = text.trim().match(/\d+/)
  if (!m) return null
  const n = Number(m[0])
  return n >= 0 && n <= count ? n : null
}
