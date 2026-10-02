import { describe, expect, it } from 'vitest'
import { formatTime, parseLogLine } from '../src/shared/logs'

describe('parseLogLine', () => {
  it('desmonta JSON do pino (nível numérico, hora em epoch ms)', () => {
    const e = parseLogLine('{"level":40,"time":1790940586927,"event":"tracing_export_failed","component":"tracing_exporter","queue_size":918}')
    expect(e.json).toBe(true)
    expect(e.level).toBe('warn')
    expect(e.time).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(e.message).toBe('tracing_export_failed')
    expect(e.fields).toEqual({ component: 'tracing_exporter', queue_size: 918 })
  })
  it('aceita nível em texto e mensagem em msg/message', () => {
    expect(parseLogLine('{"level":"error","msg":"deu ruim","id":7}')).toMatchObject({ level: 'error', message: 'deu ruim', fields: { id: 7 } })
    expect(parseLogLine('{"severity":"INFO","message":"ok","timestamp":"2026-10-02T11:05:34.923Z"}').level).toBe('info')
  })
  it('texto comum: reconhece nível e hora', () => {
    const e = parseLogLine('[2026-10-02 08:05:34.923 -0300] INFO (marketplace-sync): started')
    expect(e.json).toBe(false)
    expect(e.level).toBe('info')
    expect(e.time).toBe('08:05:34')
    expect(e.message).toBe('(marketplace-sync): started')
    expect(parseLogLine('8:35:24 AM [vite] (client) page reload src/x.vue').time).toBe('08:35:24')
    expect(parseLogLine('\x1b[32m➜\x1b[0m  press h + enter to show help')).toMatchObject({ level: 'none', message: '➜  press h + enter to show help' })
  })
  it('JSON inválido vira texto', () => {
    expect(parseLogLine('{not json}')).toMatchObject({ json: false, message: '{not json}' })
  })
})

describe('formatTime', () => {
  it('lê epoch em segundos e milissegundos e horas simples', () => {
    expect(formatTime(1790940586)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(formatTime('12:34:56.789')).toBe('12:34:56')
    expect(formatTime('abc')).toBeUndefined()
  })
})
