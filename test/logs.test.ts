import { describe, expect, it } from 'vitest'
import { formatTime, isReadyLine, parseLogLine, restartOf } from '../src/shared/logs'

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

describe('restartOf / isReadyLine', () => {
  it('reconhece reinícios de tsx, nodemon, ts-node-dev, vite e node --watch', () => {
    expect(restartOf('[tsx] change in ./src/marketplaces/marketplaceVendasUfRoutes.ts Restarting...')).toEqual({ tool: 'tsx', file: './src/marketplaces/marketplaceVendasUfRoutes.ts' })
    expect(restartOf('[tsx] rerunning')).toEqual({ tool: 'tsx', file: undefined })
    expect(restartOf('[nodemon] restarting due to changes...')).toEqual({ tool: 'nodemon' })
    expect(restartOf('[INFO] Restarting: /app/src/index.ts has been modified')).toEqual({ tool: 'ts-node-dev', file: '/app/src/index.ts' })
    expect(restartOf('vite.config.ts changed, restarting server...')).toEqual({ tool: 'vite', file: 'vite.config.ts' })
    expect(restartOf("Restarting 'src/index.js'")).toEqual({ tool: 'node', file: 'src/index.js' })
    expect(restartOf('Restarting...')).toEqual({})
  })
  it('não confunde texto comum que cita reinício', () => {
    expect(restartOf('worker 3 died, restarting it would lose the queue')).toBeNull()
    expect(restartOf('GET /api/restarting-jobs 200')).toBeNull()
    expect(restartOf('[redis] target host=127.0.0.1 port=2013')).toBeNull()
  })
  it('reconhece a linha de "voltou a atender"', () => {
    expect(isReadyLine('Server listening on http://localhost:2012')).toBe(true)
    expect(isReadyLine('  VITE v6.4.2  ready in 206 ms')).toBe(true)
    expect(isReadyLine('[nodemon] watching for file changes before starting')).toBe(true)
    expect(isReadyLine('[redis] target host=127.0.0.1')).toBe(false)
  })
})

