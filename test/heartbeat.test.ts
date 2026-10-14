import { describe, expect, it } from 'vitest'
import { BEAT_WIDTH, HB_WIDTH, RHYTHMS, heartbeatPath, heartbeatSpan, type HeartbeatTone } from '../src/shared/heartbeat'

/** Percorre o caminho (M, h, l) e devolve onde termina */
function walk(d: string) {
  let x = 0
  let y = 0
  for (const m of d.matchAll(/([Mhl])([-\d.,]+)/g)) {
    const nums = m[2].split(',').map(Number)
    if (m[1] === 'M') [x, y] = nums
    else if (m[1] === 'h') x += nums[0]
    else {
      x += nums[0]
      y += nums[1]
    }
  }
  return { x, y }
}

describe('heartbeatPath', () => {
  it('em cada estado os compassos cobrem a janela mais um, e o traçado volta à linha de base', () => {
    for (const tone of Object.keys(RHYTHMS) as HeartbeatTone[]) {
      const r = RHYTHMS[tone]
      const end = walk(heartbeatPath(tone))
      expect(end.x, tone).toBeCloseTo((Math.ceil(HB_WIDTH / r.cell) + 1) * r.cell, 5)
      expect(heartbeatSpan(tone), tone).toBe(end.x)
      expect(heartbeatSpan(tone), tone).toBeGreaterThanOrEqual(HB_WIDTH + r.cell)
      expect(end.y, tone).toBeCloseTo(8, 5)
      for (const b of r.beats) expect(b.x + BEAT_WIDTH, tone).toBeLessThanOrEqual(r.cell)
    }
  })
  it('rodando é regular e mais rápido que aguardando; parado é fora de compasso; falhou é linha reta', () => {
    expect(RHYTHMS.live.beats).toHaveLength(1)
    expect(RHYTHMS.live.cell / RHYTHMS.live.seconds).toBeGreaterThan(RHYTHMS.waiting.cell / RHYTHMS.waiting.seconds)
    const gaps = RHYTHMS.stalled.beats.slice(1).map((b, i) => b.x - RHYTHMS.stalled.beats[i].x)
    expect(new Set(gaps).size).toBeGreaterThan(1)
    expect(heartbeatPath('error')).toMatch(/^M0,8(h120)+$/)
  })
})
