import * as agents from './agentChat'
import { validateSchedule, type ScheduleExecutor, type RunResult } from './schedules'
import type { ScheduledTask } from '../shared/schedules'

/** Retoma a sessão de origem e entrega a tarefa como uma mensagem normal, sem interromper a conversa. */
export function scheduledAgentExecutor(): ScheduleExecutor {
  const sessions = new Map<string, Promise<RunResult>>()
  const active = new Map<string, {
    runId: string; started: boolean; done: boolean; result: RunResult; finish: (error?: string) => void
  }>()
  agents.onAgentEvent((uid, event) => {
    const run = active.get(uid)
    if (!run) return
    if (event.type === 'scheduledStart') {
      if (event.runId === run.runId) run.started = true
      return
    }
    if (!run.started) return
    if (event.type === 'text') run.result.result = ((run.result.result ?? '') + event.delta).slice(-20000)
    if (event.type === 'done') {
      run.done = true
      run.result.error = event.ok ? undefined : event.error ?? 'A execução falhou.'
      if (!agents.agentInfo(uid)?.bgTasks?.length) run.finish(run.result.error)
    }
  })
  agents.onAgentStatus((uid, status) => {
    const run = active.get(uid)
    if (!run?.started) return
    if (status === 'error') run.finish(run.result.error ?? 'A execução falhou. Consulte a própria conversa.')
    else if (status === 'done' && run.done) run.finish(run.result.error)
  })
  agents.onAgentGone((uid) => active.get(uid)?.finish('A conversa foi fechada durante a execução.'))

  async function execute(task: ScheduledTask, progress: (patch: RunResult) => void, runId: string): Promise<RunResult> {
    validateSchedule(task)
    const sessionId = task.sessionId!
    let info = agents.agentWindowInfos().find((a) => a.sessionId === sessionId)
    if (!info) info = await agents.openAgentWindow({
      provider: task.provider, model: task.model, effort: task.effort, mode: task.mode, cwd: task.cwd,
      resumeId: sessionId, hidden: true
    })
    const uid = info.uid
    return new Promise<RunResult>((resolve, reject) => {
      const result: RunResult = { uid, sessionId }
      let sentAt: number | undefined
      const finish = (error?: string) => {
        clearInterval(timer)
        agents.releaseScheduledMessage(runId)
        active.delete(uid)
        resolve({ ...result, error })
      }
      const attempt = () => {
        const current = agents.agentInfo(uid)
        if (!current || current.sessionId !== sessionId) return finish('A conversa de origem mudou. A tarefa não foi enviada a outra sessão.')
        if (sentAt !== undefined) {
          if (!active.get(uid)?.started && Date.now() - sentAt >= 60_000) finish('A conversa não confirmou o início da tarefa em até 60 segundos.')
          return
        }
        const status = agents.agentStatus(uid)
        if (current.running || current.bgTasks?.length || !status || status === 'live' || status === 'waiting') return
        sentAt = Date.now()
        try {
          agents.deliverScheduledMessage(uid, { type: 'scheduled', runId, sessionId,
            text: `Tarefa periódica: ${task.name}\n\n${task.prompt}`, model: task.model, effort: task.effort, mode: task.mode })
        } catch (e) { finish(String((e as Error).message ?? e)) }
      }
      const timer = setInterval(attempt, 1000)
      active.set(uid, { runId, started: false, done: false, result, finish })
      try { progress({ ...result }); attempt() }
      catch (e) { clearInterval(timer); active.delete(uid); agents.releaseScheduledMessage(runId); reject(e) }
    })
  }
  return (task, progress, runId) => {
    const key = task.sessionId ?? ''
    // Agendamentos diferentes da mesma conversa também executam em sequência.
    const previous = sessions.get(key) ?? Promise.resolve({})
    const next = previous.catch(() => ({})).then(() => execute(task, progress, runId))
    sessions.set(key, next)
    void next.finally(() => { if (sessions.get(key) === next) sessions.delete(key) }).catch(() => undefined)
    return next
  }
}
