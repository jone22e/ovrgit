import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_EFFORT, EFFORTS } from '../shared/models'
import { nextScheduleTime, type ScheduleInput, type ScheduledTask, type ScheduleRun, type ScheduleTiming, type ScheduleSummary } from '../shared/schedules'
import type { CliProvider } from '../shared/types'

export class ScheduleError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const required = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ScheduleError(`${label} inválido (máximo ${max} caracteres).`)
  return value.trim()
}

export function validateSchedule(raw: unknown, checkDirectory = true): ScheduleInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScheduleError('Envie um objeto JSON.')
  const x = raw as Record<string, unknown>
  const sessionId = x.sessionId === undefined && !checkDirectory ? undefined : required(x.sessionId, 'Sessão de origem', 80)
  if (sessionId && !/^[\w-]{8,80}$/.test(sessionId)) throw new ScheduleError('Sessão de origem inválida.')
  const cwd = required(x.cwd, 'Pasta', 4096)
  try { if (!path.isAbsolute(cwd) || (checkDirectory && !statSync(cwd).isDirectory())) throw new Error() }
  catch { throw new ScheduleError('A pasta deve ser absoluta e existir neste computador.') }
  if (!['claude', 'codex', 'agy', 'ollama'].includes(String(x.provider))) throw new ScheduleError('Provedor inválido.')
  const provider = x.provider as CliProvider
  const effort = x.effort ?? DEFAULT_EFFORT[provider]
  if (!EFFORTS[provider].some((e) => e.id === effort)) throw new ScheduleError('Esforço inválido para este provedor.')
  if (x.mode !== 'full' && x.mode !== 'plan') throw new ScheduleError('Use mode full ou plan.')
  if (typeof x.enabled !== 'boolean') throw new ScheduleError('Informe enabled como booleano.')
  if (typeof x.model !== 'string' || x.model.length > 120) throw new ScheduleError('Modelo inválido.')
  if (provider === 'ollama' && !x.model.trim()) throw new ScheduleError('Informe o modelo do Ollama.')
  const t = x.timing as Record<string, unknown> | undefined
  let timing: ScheduleTiming
  if (t?.kind === 'interval') {
    if (!Number.isSafeInteger(t.minutes) || Number(t.minutes) < 1 || Number(t.minutes) > 525600) throw new ScheduleError('Intervalo deve ser de 1 a 525600 minutos.')
    timing = { kind: 'interval', minutes: Number(t.minutes) }
  } else if (t?.kind === 'daily' || t?.kind === 'weekly') {
    if (typeof t.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)) throw new ScheduleError('Horário inválido. Use HH:mm.')
    const timezone = required(t.timezone, 'Fuso horário', 100)
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() }
    catch { throw new ScheduleError('Fuso horário inválido.') }
    if (t.kind === 'weekly') {
      if (!Array.isArray(t.days) || !t.days.length || t.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ScheduleError('Escolha dias de 0 (domingo) a 6 (sábado).')
      timing = { kind: 'weekly', time: t.time, timezone, days: [...new Set(t.days as number[])].sort() }
    } else timing = { kind: 'daily', time: t.time, timezone }
  } else throw new ScheduleError('Recorrência inválida. Use interval, daily ou weekly.')
  return {
    sessionId, name: required(x.name, 'Nome', 100), prompt: required(x.prompt, 'Instrução', 50000), cwd, provider,
    model: x.model.trim(), effort: effort as ScheduleInput['effort'], mode: x.mode, enabled: x.enabled, timing
  }
}

export type RunResult = Pick<ScheduleRun, 'result' | 'error' | 'sessionId' | 'uid'>
export type ScheduleExecutor = (task: ScheduledTask, progress: (patch: RunResult) => void, runId: string) => Promise<RunResult>

/** Persistência própria; o agendador não depende da existência da janela principal. */
export class Scheduler {
  private tasks: ScheduledTask[] = []
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  constructor(private file: string, private execute: ScheduleExecutor, private changed: () => void = () => {}, private now = Date.now) {
    try {
      const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Arquivo de agendamentos inválido.')
      // Pasta removida não impede o app de listar e editar o agendamento, mas falha antes de executar.
      for (const task of data) {
        validateSchedule(task, false)
        if (typeof task.id !== 'string' || !task.id || !Number.isFinite(task.createdAt) || !Number.isFinite(task.nextRunAt) || !Array.isArray(task.runs) || task.runs.some((r: ScheduleRun) => !r || typeof r.id !== 'string' || !['running', 'done', 'error', 'interrupted'].includes(r.status) || !Number.isFinite(r.startedAt))) throw new Error('Arquivo de agendamentos inválido.')
      }
      this.tasks = data as ScheduledTask[]
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (this.tasks.some((t) => t.runs.some((r) => r.status === 'running'))) {
      this.commit((tasks) => {
        for (const t of tasks) for (const r of t.runs) if (r.status === 'running') {
          r.status = 'interrupted'; r.finishedAt = this.now(); r.error = 'Ovseer foi encerrado durante a execução.'
        }
      })
    }
  }
  list(): ScheduledTask[] { return structuredClone(this.tasks) }
  summary(sessionId: string | null): ScheduleSummary {
    const active = sessionId ? this.tasks.filter((task) => task.sessionId === sessionId && task.enabled) : []
    return { sessionId, count: active.length, nextRunAt: active.length ? Math.min(...active.map((task) => task.nextRunAt)) : null }
  }
  private commit(change: (tasks: ScheduledTask[]) => void) {
    const next = this.list()
    change(next)
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
    this.tasks = next
    this.changed()
  }
  private get(id: string): ScheduledTask {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) throw new ScheduleError('Agendamento não encontrado.', 404)
    return task
  }
  create(raw: unknown): ScheduledTask {
    const input = validateSchedule(raw)
    if (this.tasks.some((t) => t.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new ScheduleError('Já existe um agendamento com este nome.', 409)
    const now = this.now()
    const task: ScheduledTask = { ...input, id: randomUUID(), createdAt: now, nextRunAt: nextScheduleTime(input.timing, now), runs: [] }
    this.commit((tasks) => { tasks.push(task) })
    return structuredClone(task)
  }
  update(id: string, raw: unknown): ScheduledTask {
    const task = this.get(id)
    const input = validateSchedule(raw)
    if (this.tasks.some((t) => t.id !== id && t.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new ScheduleError('Já existe um agendamento com este nome.', 409)
    const nextRunAt = nextScheduleTime(input.timing, this.now())
    this.commit((tasks) => { Object.assign(tasks.find((t) => t.id === task.id)!, input, { nextRunAt }) })
    return structuredClone(this.get(id))
  }
  enable(id: string, enabled: boolean): ScheduledTask {
    const task = this.get(id)
    const nextRunAt = enabled ? nextScheduleTime(task.timing, this.now()) : task.nextRunAt
    this.commit((tasks) => { Object.assign(tasks.find((t) => t.id === id)!, { enabled, nextRunAt }) })
    return structuredClone(this.get(id))
  }
  remove(id: string) {
    const task = this.get(id)
    if (task.runs.some((r) => r.status === 'running')) throw new ScheduleError('Aguarde ou interrompa a conversa antes de excluir.', 409)
    this.commit((tasks) => { tasks.splice(tasks.findIndex((t) => t.id === id), 1) })
  }
  run(id: string, scheduled = false): ScheduleRun {
    if (this.stopped) throw new ScheduleError('Agendador está encerrando.', 503)
    const task = this.get(id)
    if (task.runs.some((r) => r.status === 'running')) throw new ScheduleError('Esta tarefa já está em execução.', 409)
    const run: ScheduleRun = { id: randomUUID(), startedAt: this.now(), status: 'running' }
    const nextRunAt = scheduled ? nextScheduleTime(task.timing, this.now()) : task.nextRunAt
    this.commit((tasks) => {
      const t = tasks.find((t) => t.id === id)!
      t.nextRunAt = nextRunAt
      t.runs = [run, ...t.runs].slice(0, 50)
    })
    const patch = (data: Partial<ScheduleRun>) => {
      if (this.stopped) return
      this.commit((tasks) => {
        const r = tasks.find((t) => t.id === id)?.runs.find((r) => r.id === run.id)
        if (r) Object.assign(r, data)
      })
    }
    // Primeiro grava a execução e o próximo horário; só depois entrega ao agente.
    void Promise.resolve().then(() => {
      if (this.stopped) return undefined
      return this.execute(structuredClone(task), patch, run.id)
    }).then((result) => {
      if (result) patch({ ...result, status: result.error ? 'error' : 'done', finishedAt: this.now() })
    }).catch((e) => {
      try { patch({ status: 'error', error: String((e as Error).message ?? e), finishedAt: this.now() }) }
      catch (error) { console.error('Não consegui gravar a execução agendada:', error) }
    })
    return structuredClone(run)
  }
  tick() {
    if (this.stopped) return
    for (const task of this.list()) {
      if (!task.enabled || task.nextRunAt > this.now()) continue
      if (task.runs.some((r) => r.status === 'running')) {
        const nextRunAt = nextScheduleTime(task.timing, this.now())
        this.commit((tasks) => { tasks.find((t) => t.id === task.id)!.nextRunAt = nextRunAt })
      } else this.run(task.id, true)
    }
  }
  start() {
    if (this.timer || this.stopped) return
    const tick = () => { try { this.tick() } catch (e) { console.error('Falha no agendador:', e) } }
    this.timer = setInterval(tick, 15_000)
    tick()
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = undefined }
}
