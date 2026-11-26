import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Scheduler, validateSchedule, type RunResult } from '../src/main/schedules'
import { nextScheduleTime } from '../src/shared/schedules'

const dirs: string[] = []
const setup = () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'ovseer-schedules-')); dirs.push(cwd)
  const input = { name: 'Resumo', prompt: 'Confira os erros', cwd, provider: 'codex', model: '', effort: 'high', mode: 'plan', enabled: true, timing: { kind: 'interval', minutes: 60 } }
  return { cwd, file: path.join(cwd, 'schedules.json'), input }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('horários dos agendamentos', () => {
  it('respeita minutos, horário diário e fuso independentemente do fuso do computador', () => {
    const at = Date.parse('2026-11-26T10:59:32Z')
    expect(nextScheduleTime({ kind: 'interval', minutes: 15 }, at)).toBe(at + 900000)
    expect(new Date(nextScheduleTime({ kind: 'daily', time: '08:00', timezone: 'America/Sao_Paulo' }, at)).toISOString()).toBe('2026-11-26T11:00:00.000Z')
    expect(new Date(nextScheduleTime({ kind: 'daily', time: '08:00', timezone: 'America/Sao_Paulo' }, Date.parse('2026-11-26T11:00:00Z'))).toISOString()).toBe('2026-11-27T11:00:00.000Z')
  })
  it('seleciona os dias certos na virada da semana', () => {
    expect(new Date(nextScheduleTime({ kind: 'weekly', days: [1], time: '08:00', timezone: 'America/Sao_Paulo' }, Date.parse('2026-11-27T12:00:00Z'))).toISOString()).toBe('2026-11-30T11:00:00.000Z')
  })
  it('pula horário inexistente e não repete o mesmo dia na volta do horário de verão', () => {
    expect(new Date(nextScheduleTime({ kind: 'daily', time: '02:30', timezone: 'America/New_York' }, Date.parse('2026-03-08T06:59:00Z'))).toISOString()).toBe('2026-03-09T06:30:00.000Z')
    expect(new Date(nextScheduleTime({ kind: 'daily', time: '01:30', timezone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toISOString()).toBe('2026-11-02T06:30:00.000Z')
  })
})

describe('agendador persistente', () => {
  it('valida pasta, horário, fuso, intervalo, dias e permissões antes de cadastrar', () => {
    const { input } = setup()
    for (const patch of [
      { cwd: '/pasta-inexistente-ovseer' }, { enabled: 'sim' }, { mode: 'architect' }, { provider: 'outro' },
      { timing: { kind: 'interval', minutes: 0 } }, { timing: { kind: 'interval', minutes: 1.5 } },
      { timing: { kind: 'daily', time: '25:00', timezone: 'UTC' } },
      { timing: { kind: 'daily', time: '08:00', timezone: 'invalido' } },
      { timing: { kind: 'weekly', time: '08:00', timezone: 'UTC', days: [] } },
      { timing: { kind: 'weekly', time: '08:00', timezone: 'UTC', days: [7] } }
    ]) expect(() => validateSchedule({ ...input, ...patch })).toThrow()
  })
  it('retoma horários atrasados uma vez, persiste antes da entrega e bloqueia sobreposição', async () => {
    const { file, input } = setup()
    let now = 1_800_000_000_000
    let finish!: (result: RunResult) => void
    const execute = vi.fn(async (_task, progress) => {
      expect(JSON.parse(readFileSync(file, 'utf8'))[0].runs[0].status).toBe('running')
      progress({ uid: 'agente', sessionId: 'sessao' })
      return new Promise<RunResult>((resolve) => { finish = resolve })
    })
    const scheduler = new Scheduler(file, execute, undefined, () => now)
    const task = scheduler.create(input)
    now += 10 * 3600000
    scheduler.tick(); scheduler.tick()
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(() => scheduler.run(task.id)).toThrow('já está em execução')
    expect(() => scheduler.remove(task.id)).toThrow('Aguarde')
    now += 3600000
    scheduler.tick()
    expect(scheduler.list()[0].nextRunAt).toBe(now + 3600000)
    finish({ result: 'Nenhum erro', sessionId: 'sessao' })
    await flush()
    expect(scheduler.list()[0].runs[0]).toMatchObject({ status: 'done', result: 'Nenhum erro', uid: 'agente', sessionId: 'sessao' })
    expect(scheduler.list()[0].runs).toHaveLength(1)
  })
  it('pausa, permite execução manual, edita e retoma sem disparar os horários da pausa', async () => {
    const { file, input } = setup()
    let now = 1_800_000_000_000
    const execute = vi.fn(async () => ({}))
    const scheduler = new Scheduler(file, execute, undefined, () => now)
    const task = scheduler.create(input)
    scheduler.enable(task.id, false)
    now += 7200000; scheduler.tick(); await flush()
    expect(execute).not.toHaveBeenCalled()
    scheduler.run(task.id); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    scheduler.update(task.id, { ...input, name: 'Novo nome', enabled: false })
    scheduler.enable(task.id, true); scheduler.tick(); await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(scheduler.list()[0]).toMatchObject({ name: 'Novo nome', enabled: true, nextRunAt: now + 3600000 })
    scheduler.remove(task.id)
    expect(new Scheduler(file, execute).list()).toEqual([])
  })
  it('registra falhas e execuções interrompidas; reabrir não repete a execução interrompida', async () => {
    const { file, input } = setup()
    const now = 1_800_000_000_000
    const scheduler = new Scheduler(file, async () => { throw new Error('CLI ausente') }, undefined, () => now)
    const task = scheduler.create(input)
    scheduler.run(task.id); await flush()
    expect(scheduler.list()[0].runs[0]).toMatchObject({ status: 'error', error: 'CLI ausente' })
    const stopped = new Scheduler(file, () => new Promise(() => {}), undefined, () => now)
    stopped.run(task.id); await flush(); stopped.stop()
    const execute = vi.fn(async () => ({}))
    const reopened = new Scheduler(file, execute, undefined, () => now)
    reopened.tick(); await flush()
    expect(reopened.list()[0].runs[0].status).toBe('interrupted')
    expect(execute).not.toHaveBeenCalled()
    expect(() => stopped.run(task.id)).toThrow('encerrando')
  })
  it('evita cadastro duplicado, limita histórico e não expõe referências mutáveis', async () => {
    const { file, input } = setup()
    const scheduler = new Scheduler(file, async () => ({}))
    const task = scheduler.create(input)
    expect(() => scheduler.create(input)).toThrow('Já existe')
    scheduler.list()[0].enabled = false
    expect(scheduler.list()[0].enabled).toBe(true)
    for (let i = 0; i < 53; i++) { scheduler.run(task.id); await flush() }
    expect(scheduler.list()[0].runs).toHaveLength(50)
  })
  it('preserva um arquivo inválido e não dispara depois de stop', async () => {
    const { file, input } = setup()
    writeFileSync(file, 'corrompido')
    expect(() => new Scheduler(file, async () => ({}))).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('corrompido')
    rmSync(file)
    const execute = vi.fn(async () => ({}))
    const scheduler = new Scheduler(file, execute)
    const task = scheduler.create(input)
    scheduler.run(task.id); scheduler.stop(); await flush()
    expect(execute).not.toHaveBeenCalled()
  })
  it('mantém cadastro com pasta removida para edição, mas falha antes de abrir agente', () => {
    const { file, input, cwd } = setup()
    const project = path.join(cwd, 'projeto')
    mkdirSync(project)
    const scheduler = new Scheduler(file, async () => ({}))
    scheduler.create({ ...input, cwd: project })
    rmSync(project, { recursive: true })
    expect(new Scheduler(file, async () => ({})).list()).toHaveLength(1)
    expect(() => validateSchedule({ ...input, cwd: project })).toThrow('pasta')
  })
})
