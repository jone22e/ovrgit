import type { AgentEffort, AgentMode, CliProvider } from './types'

export type ScheduleTiming =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'weekly'; time: string; timezone: string; days: number[] }

export interface ScheduleInput {
  /** Sessão de origem. Ausente apenas em cadastros anteriores ao vínculo com a conversa. */
  sessionId?: string
  name: string
  prompt: string
  cwd: string
  provider: CliProvider
  model: string
  effort: AgentEffort
  mode: Extract<AgentMode, 'full' | 'plan'>
  timing: ScheduleTiming
  enabled: boolean
}

export interface ScheduleRun {
  id: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'done' | 'error' | 'interrupted'
  uid?: string
  sessionId?: string
  result?: string
  error?: string
}

export interface ScheduledTask extends ScheduleInput {
  id: string
  createdAt: number
  nextRunAt: number
  runs: ScheduleRun[]
}

/** Procura instantes reais no fuso: horários inexistentes no verão são pulados. */
export function nextScheduleTime(timing: ScheduleTiming, after: number): number {
  if (timing.kind === 'interval') return after + timing.minutes * 60_000
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timing.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  })
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const partsAfter = format.formatToParts(after)
  const valueAfter = (type: Intl.DateTimeFormatPartTypes) => partsAfter.find((p) => p.type === type)?.value
  const dayAfter = `${valueAfter('year')}-${valueAfter('month')}-${valueAfter('day')}`
  const timeAfter = `${valueAfter('hour')}:${valueAfter('minute')}`
  // Oito dias cobrem uma semana que tenha perdido o horário na troca de fuso.
  const end = after + 8 * 24 * 60 * 60_000
  for (let at = Math.floor(after / 60_000) * 60_000 + 60_000; at <= end; at += 60_000) {
    const parts = format.formatToParts(at)
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value
    if (`${value('hour')}:${value('minute')}` !== timing.time) continue
    // Na volta do horário de verão, não executar de novo o horário que se repetiu no mesmo dia.
    if (timeAfter >= timing.time && `${value('year')}-${value('month')}-${value('day')}` === dayAfter) continue
    if (timing.kind === 'daily' || timing.days.includes(weekdays.indexOf(value('weekday') ?? ''))) return at
  }
  throw new Error('Não foi possível calcular o próximo horário.')
}
