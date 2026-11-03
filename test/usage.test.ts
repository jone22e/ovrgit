import { describe, expect, it } from 'vitest'
import { parseAgyUsage } from '../src/main/usage'

describe('parseAgyUsage', () => {
  it('pega, por janela, o grupo mais gasto e quando zera', () => {
    const body = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-10-23T13:14:19Z' }, { window: '5h', remaining_fraction: 1, reset_time: '2026-10-16T18:14:19Z' }] },
            { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 0.6, reset_time: '2026-10-22T10:00:00Z' }, { window: '5h', remaining_fraction: 0.75, reset_time: '2026-10-16T17:00:00Z' }] },
            { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-23T13:14:19Z' }] }
          ]
        }
      }
    })
    const u = parseAgyUsage(body)!
    expect(Math.round(u.week!.pct)).toBe(40)
    expect(u.week!.resetsAt).toBe(Date.parse('2026-10-22T10:00:00Z'))
    expect(Math.round(u.fiveHour!.pct)).toBe(25)
    expect(u.fiveHour!.resetsAt).toBe(Date.parse('2026-10-16T17:00:00Z'))
  })

  it('nulo quando a saída não é o JSON do /usage', () => {
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Remaining\t100%')).toBeNull()
    expect(parseAgyUsage('{"status":"SUCCESS","response":"x"}')).toBeNull()
  })
})
