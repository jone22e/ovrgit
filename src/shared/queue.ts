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
    if (task.status !== 'queued') continue
    const i = free.findIndex((a) => !task.cwd || a.cwd === task.cwd)
    if (i < 0) continue
    out.push({ task, agent: free[i] })
    free.splice(i, 1)
  }
  return out
}

/** Sobe ou desce uma tarefa entre as que ainda estão na fila (as outras não saem do lugar) */
export function move(tasks: QueueTask[], id: string, dir: -1 | 1): QueueTask[] {
  const queued = tasks.filter((t) => t.status === 'queued')
  const i = queued.findIndex((t) => t.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= queued.length) return tasks
  const a = tasks.indexOf(queued[i])
  const b = tasks.indexOf(queued[j])
  const next = [...tasks]
  ;[next[a], next[b]] = [next[b], next[a]]
  return next
}
