import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentAttachment, AgentSnapshot, AgentStatus, QueueTask } from '../shared/types'
import { assign, clearlyRelated, move as moveTask, parsePick, pickPrompt, rankRelated, reasoningPrompt, taskPrompt, type AgentContext } from '../shared/queue'
import * as agentChat from './agentChat'
import { getSettings } from './settings'
import { quickAsk } from './quickAi'
import { reasonAbout } from './reasoner'
import { agentStatusReply, knownProjects, mentionedProjects } from './manager'

/**
 * Pedidos do gerenciador e tarefas anteriores da fila. Na fila anterior, se passar pelo raciocínio, um agente
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
const attachmentsDir = () => path.join(app.getPath('userData'), 'queue-attachments')

/** Guarda anexos temporários antes de o gerenciador escolher a conversa que vai recebê-los. */
export function keepFile(filePath: string): AgentAttachment {
  const size = statSync(filePath).size
  if (size > 50 * 1024 * 1024) throw new Error('Arquivo grande demais (máx. 50 MB).')
  if (!agentChat.isTemporaryPath(filePath)) return agentChat.describeFile(filePath)
  mkdirSync(attachmentsDir(), { recursive: true })
  const saved = path.join(attachmentsDir(), `${crypto.randomUUID()}-${path.basename(filePath).replace(/[^\w.\-() ]+/g, '_')}`)
  copyFileSync(filePath, saved)
  return { ...agentChat.describeFile(saved), name: path.basename(filePath) }
}

export function saveBlob(file: { name: string; type: string; data: Uint8Array }): AgentAttachment {
  if (file.data.byteLength > 50 * 1024 * 1024) throw new Error('Arquivo grande demais (máx. 50 MB).')
  mkdirSync(attachmentsDir(), { recursive: true })
  const base = (file.name || 'anexo').replace(/[^\w.\-() ]+/g, '_').replace(/^\.+/, '') || 'anexo'
  const ext = path.extname(base) ? '' : file.type === 'image/png' ? '.png' : file.type === 'image/jpeg' ? '.jpg' : ''
  const saved = path.join(attachmentsDir(), `${crypto.randomUUID()}-${base}${ext}`)
  writeFileSync(saved, file.data)
  return { ...agentChat.describeFile(saved), name: file.name || `${base}${ext}` }
}

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
  for (const t of tasks) if (t.status === 'running' || (t.managed && t.status === 'queued')) (t.status = 'queued'), (t.uid = undefined), (t.sessionId = undefined), (t.startedAt = undefined)
  for (const t of tasks) if (t.analyzing) t.analyzing = false
  agentChat.onAgentStatus(onStatus)
  agentChat.onAgentGone(onGone)
  agentChat.onAgentSnapshot(() => {
    if (tasks.some((t) => t.managed && t.status === 'queued' && !t.uid)) void dispatch()
  })
  for (const t of tasks) if (t.stage === 'reasoning' && !t.analysis) analyze(t.id)
}

/** Só encaminha depois que as janelas anteriores tiverem sido restauradas. */
export function resume() {
  void dispatch()
}

export const list = (): QueueTask[] => tasks

/** Tarefa nova: inicia no raciocínio ou vai direto para a fila de execução */
export function add(task: { text: string; cwd?: string; extraDirs?: string[]; stage?: 'reasoning' | 'ready'; managed?: boolean; attachments?: AgentAttachment[]; config?: QueueTask['config'] }): QueueTask[] {
  const text = String(task.text ?? '').trim().slice(0, 20000)
  if (!text) return tasks
  let cwd = task.cwd
  let reply: string | null = null
  if (task.managed) {
    const settings = getSettings()
    const agents = agentChat.agentSnapshots()
    const roots = knownProjects(settings.recentProjects ?? [], settings.repoGroups ?? [], agents).filter(existsSync)
    reply = agentStatusReply(text, agents, roots, settings.repoGroups ?? [], cwd ? [cwd, ...(task.extraDirs ?? [])] : undefined)
    if (!reply) {
      const mentioned = mentionedProjects(text, roots, settings.repoGroups ?? [])
      if (cwd && mentioned.length && !mentioned.some((p) => p === cwd || task.extraDirs?.includes(p))) {
        reply = `O seletor está em ${path.basename(cwd)}, mas o pedido menciona ${mentioned.map((p) => path.basename(p)).join(', ')}. Escolha o projeto certo antes de encaminhar.`
      } else if (!cwd) {
        if (mentioned.length === 1) cwd = mentioned[0]
        else reply = mentioned.length
          ? `Encontrei mais de um projeto no pedido: ${mentioned.map((p) => path.basename(p)).join(', ')}. Escolha o projeto principal no seletor.`
          : 'Escolha um projeto no seletor ou cite o nome de um projeto conhecido no pedido para eu encaminhá-lo.'
      }
    }
    if (!reply && (!cwd || !existsSync(cwd))) throw new Error('Escolha um repositório válido para o gerenciador.')
  }
  const attachments = (task.attachments ?? []).slice(0, 20).map((a) => {
    if (!existsSync(a.path)) throw new Error(`Anexo não encontrado: ${a.name}`)
    return { ...agentChat.describeFile(a.path), name: String(a.name || path.basename(a.path)).slice(0, 120) }
  })
  const extraDirs = cwd && task.extraDirs?.length ? task.extraDirs.filter((d) => d !== cwd) : undefined
  const stage = task.managed || task.stage === 'ready' ? undefined : 'reasoning'
  const t: QueueTask = { id: crypto.randomUUID(), text, cwd: cwd || undefined, extraDirs: extraDirs?.length ? extraDirs : undefined, attachments: attachments.length ? attachments : undefined, config: task.managed ? task.config : undefined, status: reply ? 'done' : 'queued', ...(task.managed ? { managed: true } : {}), ...(stage ? { stage } : {}), ...(reply ? { reply, finishedAt: Date.now() } : {}), createdAt: Date.now() }
  tasks.push(t)
  save()
  if (!reply) {
    if (stage) analyze(t.id)
    else void dispatch()
  }
  return tasks
}

/** Tarefa anterior revisada pelo usuário: passa a ser encaminhada pelo gerenciador. */
export function manage(id: string, cwd?: string, extraDirs?: string[]): QueueTask[] {
  const task = tasks.find((t) => t.id === id)
  if (!task || task.status !== 'queued') return tasks
  if (!task.cwd && cwd) {
    task.cwd = cwd
    task.extraDirs = extraDirs?.filter((d) => d !== cwd)
  }
  if (!task.cwd || !existsSync(task.cwd)) throw new Error('Escolha um repositório válido para esta tarefa.')
  task.managed = true
  delete task.stage
  task.analyzing = false
  save()
  void dispatch()
  return tasks
}

/** Confirma o início quando a própria janela envia o pedido ao CLI. */
export function started(id: string, uid: string): void {
  const task = tasks.find((t) => t.id === id && t.managed && t.status === 'queued')
  const agent = agentChat.agentInfo(uid)
  if (!task || !agent || agent.cwd !== task.cwd || (task.uid && task.uid !== uid)) throw new Error('Este pedido não pertence à conversa do agente.')
  task.uid = uid
  task.status = 'running'
  task.startedAt = Date.now()
  task.agentTitle = agent.title || task.agentTitle || 'Novo agente'
  save()
}

export function finished(id: string, uid: string, success: boolean): void {
  const task = tasks.find((t) => t.id === id && t.managed && t.uid === uid && t.status === 'running')
  if (!task) return
  task.status = success ? 'done' : 'failed'
  if (!success) task.reason = agentChat.agentSnapshots().find((a) => a.uid === uid)?.error?.slice(0, 300) || 'O agente encerrou o pedido com erro.'
  task.finishedAt = Date.now()
  const agent = agentChat.agentInfo(uid)
  task.sessionId = agent?.sessionId ?? undefined
  task.agentTitle = agent?.title || task.agentTitle
  save()
  void dispatch()
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
  // uma tarefa entregue não sai: ela já pode estar na fila local da conversa
  tasks = tasks.filter((t) => t.id !== id || t.status === 'running' || (t.managed && !!t.uid && t.status === 'queued'))
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
    t.sessionId = undefined
    t.agentTitle = undefined
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

function managedContextOf(a: AgentSnapshot): AgentContext {
  const done = tasks.filter((t) => t.status === 'done' && t.uid === a.uid).map((t) => t.text)
  return {
    uid: a.uid, cwd: a.cwd, title: a.title || 'Novo agente',
    fresh: a.status === 'idle' && !a.lastUser && !a.summary && !done.length,
    context: [a.title, a.activity, a.summary, a.lastUser ? `Último pedido: ${a.lastUser}` : '', done.length ? `Tarefas feitas: ${done.join(' | ')}` : '', a.paths?.length ? `Arquivos: ${a.paths.slice(0, 12).join(' ')}` : ''].filter(Boolean).join('. ')
  }
}

/** Procura continuidade no mesmo repositório, inclusive numa conversa ocupada. */
async function routeManaged(task: QueueTask): Promise<void> {
  if (!task.cwd || !existsSync(task.cwd)) {
    task.status = 'failed'
    task.reason = 'A pasta do projeto não existe mais.'
    save()
    return
  }
  const snapshots = agentChat.agentSnapshots()
  const available = snapshots.filter((a) => a.cwd === task.cwd && a.status !== 'error' && (!task.config || a.provider === task.config.provider))
  const visible = new Set(snapshots.map((a) => a.uid))
  if (agentChat.agentWindowInfos().some((a) => a.cwd === task.cwd && (!task.config || a.provider === task.config.provider) && !visible.has(a.uid))) return
  const contexts = available.map(managedContextOf)
  const related = rankRelated(task.text, contexts)
  let chosen: AgentContext | undefined
  if (related.length && clearlyRelated(related[0])) chosen = related[0].agent
  else {
    const ordered = [...related.map((r) => r.agent), ...contexts.filter((c) => !c.fresh).reverse()]
    const candidates = ordered.filter((c, i) => ordered.findIndex((x) => x.uid === c.uid) === i).slice(0, 8)
    if (candidates.length) {
      try {
        const base = available.find((a) => a.uid === candidates[0].uid)
        if (!base) throw new Error('A conversa candidata foi fechada.')
        const answer = await quickAsk(base.provider, pickPrompt(task.text, candidates))
        const pick = parsePick(answer, candidates.length)
        if (pick && pick > 0) chosen = candidates[pick - 1]
      } catch (e) {
        console.error('Gerenciador: não consegui comparar as conversas:', (e as Error).message)
      }
    }
  }
  if (!tasks.includes(task) || task.status !== 'queued' || task.uid) return
  if (chosen && !agentChat.agentSnapshots().some((a) => a.uid === chosen!.uid && a.cwd === task.cwd && a.status !== 'error')) chosen = undefined
  if (!chosen) chosen = contexts.find((c) => c.fresh && agentChat.agentInfo(c.uid))
  if (chosen) {
    try {
      if (task.extraDirs?.length) {
        const current = agentChat.agentInfo(chosen.uid)?.extraDirs ?? []
        agentChat.setExtraDirs(chosen.uid, [...new Set([...current, ...task.extraDirs])])
      }
      task.uid = chosen.uid
      task.agentTitle = chosen.title
      task.via = chosen.fresh ? 'fresh' : 'related'
      task.reason = chosen.fresh ? 'Conversa disponível no projeto' : `Continua a conversa "${chosen.title}"`
      save()
      agentChat.actOnAgent(chosen.uid, { type: 'enqueue', taskId: task.id, text: taskPrompt(task), attachments: task.attachments, model: task.config?.model, effort: task.config?.effort, mode: task.config?.mode })
      return
    } catch (e) {
      task.uid = undefined
      task.via = undefined
      task.reason = undefined
      console.error('Gerenciador: não consegui entregar à conversa:', (e as Error).message)
    }
  }
  try {
    const base = agentChat.agentBase()
    const settings = getSettings()
    const configured = settings.provider
    const provider = task.config?.provider ?? base?.provider ?? (configured === 'claude' || configured === 'codex' || configured === 'agy' ? configured : null)
    if (!provider) throw new Error('Defina um provedor de agentes nas configurações.')
    const model = task.config?.model ?? (base?.provider === provider ? base.model : undefined) ?? (provider === 'claude' ? settings.claudeModel : provider === 'codex' ? settings.codexModel : settings.agyModel)
    const agent = await agentChat.openAgentWindow({ provider, model, effort: task.config?.effort ?? (base?.provider === provider ? base.effort : 'high'), mode: task.config?.mode ?? 'full', cwd: task.cwd, extraDirs: task.extraDirs, firstMessage: taskPrompt(task), firstFiles: task.attachments?.map((a) => a.path), firstAttachments: task.attachments, managerTaskId: task.id, quiet: true })
    task.uid = agent.uid
    task.agentTitle = agent.title || 'Novo agente'
    task.via = 'new'
    task.reason = 'Criei um novo agente para este pedido'
    save()
  } catch (e) {
    task.status = 'failed'
    task.reason = `Não consegui criar o agente: ${String((e as Error).message).slice(0, 250)}`
    task.finishedAt = Date.now()
    save()
  }
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
      if (task.managed) {
        if (!task.uid) await routeManaged(task)
        continue
      }
      const reuse = getSettings().queueReuse
      const all = agentChat
        .availableStandby()
        .filter((a) => !busy.has(a.uid) && !resetting.has(a.uid) && !tasks.some((t) => t.managed && t.uid === a.uid && (t.status === 'queued' || t.status === 'running')) && (!task.cwd || a.cwd === task.cwd) && (reuse || a.fresh))
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
  if (task?.managed && status === 'idle') {
    task.status = 'failed'
    task.finishedAt = Date.now()
    task.reason = 'A conversa foi reiniciada antes de concluir o pedido.'
    save()
  } else if (task && !task.managed) {
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
    if ((t.status === 'running' || (t.managed && t.status === 'queued')) && t.uid === uid) {
      t.status = 'queued'
      t.uid = undefined
      t.sessionId = undefined
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
