import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentStatus, QueueTask } from '../shared/types'
import { assign, clearlyRelated, move as moveTask, parsePick, pickPrompt, rankRelated, reasoningPrompt, taskPrompt, type AgentContext } from '../shared/queue'
import * as agentChat from './agentChat'
import { getSettings } from './settings'
import { quickAsk } from './quickAi'
import { reasonAbout } from './reasoner'

/**
 * Fila de tarefas para os agentes em espera, com raciocínio opcional. Se passar pelo raciocínio, um agente
 * só de leitura analisa do que se trata e anexa a análise; cada observação do usuário faz a análise ser revista, em
 * segundo plano. Quando o raciocínio está formado, o usuário move a tarefa para a execução. Também pode enviá-la direto à execução. Lá ela vai para um agente
 * em espera livre, como mensagem, com a análise e as observações junto. A escolha olha o contexto: um agente que já terminou uma tarefa do mesmo assunto continua a mesma
 * conversa (aproveita o que já leu e decidiu); quando a relação não é óbvia, uma IA rápida decide; sem relação, a
 * tarefa vai para um agente zerado (ou um terminado abre uma conversa nova). A fila sobrevive ao fechar do app
 * (as que estavam rodando voltam para a fila).
 */

let tasks: QueueTask[] = []
/** Agentes que já receberam uma tarefa e ainda não avisaram que estão rodando */
const busy = new Set<string>()
/** Agentes mandados abrir uma conversa nova, esperando ficarem zerados */
const resetting = new Set<string>()
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
  // o app fechou com tarefas rodando: voltam para a fila; com análises no meio: recomeçam
  for (const t of tasks) if (t.status === 'running') (t.status = 'queued'), (t.uid = undefined), (t.startedAt = undefined)
  for (const t of tasks) if (t.analyzing) t.analyzing = false
  agentChat.onAgentStatus(onStatus)
  agentChat.onAgentGone(onGone)
  for (const t of tasks) if (t.stage === 'reasoning' && !t.analysis) analyze(t.id)
}

export const list = (): QueueTask[] => tasks

/** Tarefa nova: inicia no raciocínio ou vai direto para a fila de execução */
export function add(task: { text: string; cwd?: string; extraDirs?: string[]; stage?: 'reasoning' | 'ready' }): QueueTask[] {
  const text = String(task.text ?? '').trim().slice(0, 20000)
  if (!text) return tasks
  const extraDirs = task.cwd && task.extraDirs?.length ? task.extraDirs.filter((d) => d !== task.cwd) : undefined
  const stage = task.stage === 'ready' ? undefined : 'reasoning'
  const t: QueueTask = { id: crypto.randomUUID(), text, cwd: task.cwd || undefined, extraDirs: extraDirs?.length ? extraDirs : undefined, status: 'queued', ...(stage ? { stage } : {}), createdAt: Date.now() }
  tasks.push(t)
  save()
  if (stage) analyze(t.id)
  else void dispatch()
  return tasks
}

/** Observação do usuário numa tarefa em raciocínio: fica anexada e a análise é revista com ela */
export function comment(id: string, text: string): QueueTask[] {
  const t = tasks.find((x) => x.id === id)
  const clean = String(text ?? '').trim().slice(0, 4000)
  if (!t || t.stage !== 'reasoning' || !clean) return tasks
  ;(t.notes ??= []).push({ at: Date.now(), text: clean })
  save()
  analyze(id)
  return tasks
}

/** Entre a fila de raciocínio e a de execução (só enquanto espera); para a execução, o próximo agente livre a pega */
export function setStage(id: string, stage: 'reasoning' | 'ready'): QueueTask[] {
  const t = tasks.find((x) => x.id === id)
  if (!t || t.status !== 'queued') return tasks
  if (stage === 'reasoning') t.stage = 'reasoning'
  else delete t.stage
  save()
  if (stage === 'ready') void dispatch()
  return tasks
}

/** Refaz a análise de uma tarefa em raciocínio */
export function reanalyze(id: string): QueueTask[] {
  const t = tasks.find((x) => x.id === id)
  if (!t || t.stage !== 'reasoning') return tasks
  analyze(id)
  return tasks
}

/* as análises rodam uma por vez (cada uma é um processo do CLI); uma observação no meio faz a tarefa ser analisada de novo */
let chain: Promise<void> = Promise.resolve()
function analyze(id: string) {
  const t = tasks.find((x) => x.id === id)
  if (!t || t.stage !== 'reasoning') return
  if (!t.analyzing) {
    t.analyzing = true
    save()
  }
  chain = chain.then(() => runAnalysis(id)).catch(() => undefined)
}
async function runAnalysis(id: string): Promise<void> {
  const t = tasks.find((x) => x.id === id)
  if (!t || t.stage !== 'reasoning') return
  const notesBefore = t.notes?.length ?? 0
  t.analyzing = true
  try {
    const text = (await reasonAbout({ cwd: t.cwd, extraDirs: t.extraDirs, prompt: reasoningPrompt(t) })).trim()
    const cur = tasks.find((x) => x.id === id)
    if (!cur) return
    if (text) {
      cur.analysis = text.slice(0, 20000)
      cur.analyzedAt = Date.now()
      cur.analysisError = undefined
    } else cur.analysisError = 'A análise voltou vazia.'
  } catch (e) {
    const cur = tasks.find((x) => x.id === id)
    if (cur) cur.analysisError = String((e as Error)?.message ?? e).slice(0, 300)
  }
  const cur = tasks.find((x) => x.id === id)
  if (!cur) return
  // chegaram observações enquanto analisava: a análise é revista com elas
  if (cur.stage === 'reasoning' && (cur.notes?.length ?? 0) > notesBefore) {
    save()
    return runAnalysis(id)
  }
  cur.analyzing = false
  save()
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
    t.via = undefined
    t.reason = undefined
    save()
    void dispatch()
  }
  return tasks
}

export function clearFinished(): QueueTask[] {
  tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'running')
  save()
  return tasks
}

/** O que a conversa de um agente já tratou (para medir a afinidade com a tarefa nova) */
function contextOf(a: agentChat.AvailableAgent): AgentContext {
  const done = tasks.filter((t) => t.status === 'done' && t.uid === a.uid).map((t) => t.text)
  const parts = [a.title, a.summary, a.lastUser ? `Último pedido: ${a.lastUser}` : '', done.length ? `Tarefas feitas: ${done.join(' | ')}` : '', a.paths.length ? `Arquivos: ${a.paths.slice(0, 12).join(' ')}` : '']
  return { uid: a.uid, cwd: a.cwd, title: a.title, fresh: a.fresh, context: parts.filter(Boolean).join('. ') }
}

let dispatching = false
let again = false

/** Entrega as tarefas da fila aos agentes em espera, escolhendo pelo contexto */
async function dispatch() {
  if (dispatching) {
    again = true
    return
  }
  dispatching = true
  try {
    for (const task of [...tasks]) {
      if (task.status !== 'queued' || task.stage === 'reasoning') continue
      const reuse = getSettings().queueReuse
      const all = agentChat
        .availableStandby()
        .filter((a) => !busy.has(a.uid) && !resetting.has(a.uid) && (!task.cwd || a.cwd === task.cwd) && (reuse || a.fresh))
      if (!all.length) continue
      const contexts = all.map(contextOf)
      // 1. uma conversa do mesmo assunto continua (clara pelas palavras; na dúvida, a IA decide)
      let chosen: AgentContext | null = null
      let reason = ''
      const related = reuse ? rankRelated(task.text, contexts) : []
      if (related.length && clearlyRelated(related[0])) {
        chosen = related[0].agent
        reason = `continua "${chosen.title}"`
      } else if (related.length && getSettings().queueSmart) {
        const candidates = related.slice(0, 5).map((r) => r.agent)
        try {
          const answer = await quickAsk(all[0].provider, pickPrompt(task.text, candidates))
          const n = parsePick(answer, candidates.length)
          // resposta inválida: fica com a relação mais forte só se for bem forte
          if (n === null) {
            if (related[0].shared >= 3) chosen = related[0].agent
          } else if (n > 0) chosen = candidates[n - 1]
          if (chosen) reason = `continua "${chosen.title}" (escolha da IA)`
        } catch (e) {
          console.error('Fila: a IA não escolheu o agente:', (e as Error).message)
          if (related[0].shared >= 3) {
            chosen = related[0].agent
            reason = `continua "${chosen.title}"`
          }
        }
        // a IA levou um tempo: a tarefa pode ter saído da fila, e o agente pode ter sido tomado
        if (task.status !== 'queued') continue
        if (chosen && (busy.has(chosen.uid) || !agentChat.availableStandby().some((a) => a.uid === chosen!.uid))) chosen = null
      }
      // 2. sem relação: um agente zerado; se só há terminados, um deles abre uma conversa nova e a tarefa espera
      if (!chosen) {
        const fresh = contexts.find((c) => c.fresh)
        if (fresh) {
          chosen = fresh
          reason = ''
        } else {
          const spare = contexts.find((c) => !c.fresh)
          if (spare) {
            resetting.add(spare.uid)
            try {
              agentChat.actOnAgent(spare.uid, { type: 'newChat' })
            } catch {
              resetting.delete(spare.uid)
            }
          }
          continue
        }
      }
      start(task, chosen, chosen.fresh ? 'fresh' : 'related', reason)
    }
  } finally {
    dispatching = false
    if (again) {
      again = false
      void dispatch()
    }
  }
}

/** Entrega a tarefa ao agente escolhido */
function start(task: QueueTask, agent: AgentContext, via: 'fresh' | 'related', reason: string) {
  try {
    // tarefa de um grupo: o agente recebe o mesmo espaço de trabalho (os outros repositórios) antes do pedido
    if (task.extraDirs?.length) {
      try {
        agentChat.setExtraDirs(agent.uid, task.extraDirs)
      } catch (e) {
        console.error('Fila: não consegui juntar os repositórios do grupo:', (e as Error).message)
      }
    }
    // o pedido vai com o raciocínio formado antes (análise e observações), quando houve
    agentChat.actOnAgent(agent.uid, { type: 'reply', text: taskPrompt(task) })
  } catch (e) {
    console.error('Fila: não consegui entregar a tarefa:', (e as Error).message)
    return
  }
  busy.add(agent.uid)
  task.status = 'running'
  task.uid = agent.uid
  task.agentTitle = agent.title
  task.startedAt = Date.now()
  task.via = via
  task.reason = reason || undefined
  console.log(`Fila: tarefa ${task.id.slice(0, 8)} → agente ${agent.uid.slice(0, 8)} (${via}${reason ? `: ${reason}` : ''})`)
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
      task.via = undefined
      task.reason = undefined
      save()
      void dispatch()
    }, START_TIMEOUT)
  )
  save()
}

function onStatus(uid: string, status: AgentStatus) {
  const task = tasks.find((t) => t.status === 'running' && t.uid === uid)
  console.log(`Fila: agente ${uid.slice(0, 8)} → ${status}${task ? ` (tarefa ${task.id.slice(0, 8)})` : ''}`)
  if (status === 'idle') resetting.delete(uid)
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
      // o agente fica disponível com o contexto: a próxima tarefa do mesmo assunto continua esta conversa
    }
  }
  if (status === 'idle' || status === 'done') void dispatch()
}

/** O agente fechou no meio: a tarefa volta para a fila */
function onGone(uid: string) {
  busy.delete(uid)
  resetting.delete(uid)
  let changed = false
  for (const t of tasks) {
    if (t.status === 'running' && t.uid === uid) {
      t.status = 'queued'
      t.uid = undefined
      t.startedAt = undefined
      t.via = undefined
      t.reason = undefined
      changed = true
    }
  }
  if (changed) {
    save()
    void dispatch()
  }
}
