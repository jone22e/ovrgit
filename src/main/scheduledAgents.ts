import * as agents from './agentChat'
import { validateSchedule, type ScheduleExecutor, type RunResult } from './schedules'

/** Uma conversa por execução, em segundo plano, com o mesmo fluxo de transcrição dos agentes manuais. */
export function scheduledAgentExecutor(): ScheduleExecutor {
  const active = new Map<string, {
    result: RunResult; finish: (error?: string) => void; progress: (patch: RunResult) => void; timer: ReturnType<typeof setTimeout>
  }>()
  agents.onAgentEvent((uid, event) => {
    const run = active.get(uid)
    if (!run) return
    clearTimeout(run.timer)
    if (event.type === 'text') run.result.result = ((run.result.result ?? '') + event.delta).slice(-20000)
    if (event.type === 'session') {
      run.result.sessionId = event.sessionId
      run.progress({ uid, sessionId: event.sessionId })
    }
    if (event.type === 'done') run.result.error = event.ok ? undefined : event.error ?? 'A execução falhou.'
  })
  // A tela só anuncia done quando também terminaram as tarefas em segundo plano.
  agents.onAgentStatus((uid, status) => {
    const run = active.get(uid)
    if (!run) return
    if (status !== 'idle') clearTimeout(run.timer)
    if (status === 'done' || status === 'error') run.finish(status === 'error' ? run.result.error ?? 'A execução falhou. Abra a conversa para ver o erro.' : undefined)
  })
  agents.onAgentGone((uid) => active.get(uid)?.finish('A conversa foi fechada durante a execução.'))
  return async (task, progress) => {
    validateSchedule(task) // a pasta pode ter sido removida desde o cadastro
    const info = await agents.openAgentWindow({
      provider: task.provider, model: task.model, effort: task.effort, mode: task.mode, cwd: task.cwd,
      hidden: true, scheduled: true, firstMessage: `Tarefa periódica: ${task.name}\n\n${task.prompt}`
    })
    return new Promise<RunResult>((resolve, reject) => {
      const result: RunResult = { uid: info.uid }
      const finish = (error?: string) => {
        const run = active.get(info.uid)
        if (!run) return
        clearTimeout(run.timer)
        active.delete(info.uid)
        resolve({ ...result, sessionId: agents.agentInfo(info.uid)?.sessionId ?? result.sessionId, error })
      }
      const timer = setTimeout(() => {
        finish('A conversa não iniciou em até 60 segundos.')
        agents.closeAgentWindows([info.uid])
      }, 60_000)
      active.set(info.uid, { result, finish, progress, timer })
      try { progress(result) }
      catch (e) { clearTimeout(timer); active.delete(info.uid); agents.closeAgentWindows([info.uid]); reject(e) }
    })
  }
}
