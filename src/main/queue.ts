import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentStatus, QueueTask } from '../shared/types'
import { assign, move as moveTask } from '../shared/queue'
import * as agentChat from './agentChat'
import { getSettings } from './settings'

/**
 * Fila de tarefas para os agentes em espera. Uma tarefa entra na fila; o próximo agente em espera livre (do mesmo
 * repositório, se a tarefa tiver um) a recebe como mensagem. Quando ele termina, a tarefa fica concluída com a
 * conversa guardada e, se a configuração manda reaproveitar, o agente abre uma conversa nova e volta à espera.
 * A fila sobrevive ao fechar do app (as que estavam rodando voltam para a fila).
 */

let tasks: QueueTask[] = []
/** Agentes que já receberam uma tarefa e ainda não avisaram que estão rodando */
const busy = new Set<string>()
/** Entregue e sem sinal de vida: passado o prazo, a tarefa volta para a fila */
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const START_TIMEOUT = 30_000
let notify: (tasks: QueueTask[]) => void = () => undefined

const file = () => path.join(app.getPath('userData'), 'queue.json')

function save() {
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(tasks, null, 2))
  } catch (e) {
    console.error('Fila: não consegui gravar:', (e as Error).message)
  }
  notify(tasks)
}

export function setupQueue(onChange: (tasks: QueueTask[]) => void) {
  notify = onChange
  try {
    if (existsSync(file())) tasks = (JSON.parse(readFileSync(file(), 'utf8')) as QueueTask[]).filter((t) => t && typeof t.id === 'string')
  } catch {
    tasks = []
  }
  // o app fechou com tarefas rodando: voltam para a fila
  for (const t of tasks) if (t.status === 'running') (t.status = 'queued'), (t.uid = undefined), (t.startedAt = undefined)
  agentChat.onAgentStatus(onStatus)
  agentChat.onAgentGone(onGone)
}

export const list = (): QueueTask[] => tasks

export function add(task: { text: string; cwd?: string }): QueueTask[] {
  const text = String(task.text ?? '').trim().slice(0, 20000)
  if (!text) return tasks
  tasks.push({ id: crypto.randomUUID(), text, cwd: task.cwd || undefined, status: 'queued', createdAt: Date.now() })
  dispatch()
  save()
  return tasks
}

export function remove(id: string): QueueTask[] {
  // uma tarefa rodando não sai: a conversa já está com o agente
  tasks = tasks.filter((t) => t.id !== id || t.status === 'running')
  save()
  return tasks
}

export function move(id: string, dir: -1 | 1): QueueTask[] {
  tasks = moveTask(tasks, id, dir)
  save()
  return tasks
}

export function retry(id: string): QueueTask[] {
  const t = tasks.find((x) => x.id === id)
  if (t && t.status === 'failed') {
    t.status = 'queued'
    t.uid = undefined
    t.startedAt = undefined
    t.finishedAt = undefined
    dispatch()
  }
  save()
  return tasks
}

export function clearFinished(): QueueTask[] {
  tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'running')
  save()
  return tasks
}

/** Entrega as tarefas da fila aos agentes em espera livres */
function dispatch() {
  const pairs = assign(tasks, agentChat.standbyAgents(), busy)
  for (const { task, agent } of pairs) {
    try {
      agentChat.actOnAgent(agent.uid, { type: 'reply', text: task.text })
    } catch (e) {
      console.error('Fila: não consegui entregar a tarefa:', (e as Error).message)
      continue
    }
    busy.add(agent.uid)
    task.status = 'running'
    task.uid = agent.uid
    task.agentTitle = agent.title
    task.startedAt = Date.now()
    // o agente não começou (a tela perdeu a mensagem): a tarefa volta para a fila e outro a pega
    clearTimeout(pending.get(agent.uid))
    pending.set(
      agent.uid,
      setTimeout(() => {
        pending.delete(agent.uid)
        if (task.status !== 'running' || task.uid !== agent.uid || !busy.has(agent.uid)) return
        console.warn(`Fila: agente ${agent.uid.slice(0, 8)} não começou a tarefa; ela volta para a fila`)
        busy.delete(agent.uid)
        task.status = 'queued'
        task.uid = undefined
        task.startedAt = undefined
        dispatch()
        save()
      }, START_TIMEOUT)
    )
  }
  if (pairs.length) save()
}

function onStatus(uid: string, status: AgentStatus) {
  const task = tasks.find((t) => t.status === 'running' && t.uid === uid)
  console.log(`Fila: agente ${uid.slice(0, 8)} → ${status}${task ? ` (tarefa ${task.id.slice(0, 8)})` : ''}`)
  if (task) {
    if (status === 'live') {
      busy.delete(uid)
      clearTimeout(pending.get(uid))
      pending.delete(uid)
    } else if (status === 'done' || status === 'error') {
      busy.delete(uid)
      clearTimeout(pending.get(uid))
      pending.delete(uid)
      task.status = status === 'done' ? 'done' : 'failed'
      task.finishedAt = Date.now()
      const info = agentChat.agentInfo(uid)
      task.sessionId = info?.sessionId ?? undefined
      task.agentTitle = info?.title || task.agentTitle
      save()
      // terminou bem: o agente volta à espera numa conversa nova (a desta tarefa fica em Conversas) e pega a próxima
      if (status === 'done' && getSettings().queueReuse) {
        try {
          agentChat.actOnAgent(uid, { type: 'newChat' })
        } catch (e) {
          console.error('Fila: conversa nova falhou:', (e as Error).message)
        }
      }
      return
    }
  }
  if (status === 'idle') dispatch()
}

/** O agente fechou no meio: a tarefa volta para a fila */
function onGone(uid: string) {
  busy.delete(uid)
  let changed = false
  for (const t of tasks) {
    if (t.status === 'running' && t.uid === uid) {
      t.status = 'queued'
      t.uid = undefined
      t.startedAt = undefined
      changed = true
    }
  }
  if (changed) {
    dispatch()
    save()
  }
}
