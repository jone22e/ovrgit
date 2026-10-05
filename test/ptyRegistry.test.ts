import { describe, expect, it } from 'vitest'
import type { IPty } from '@lydell/node-pty'
import { livePtys, shutdownPtys, trackPty } from '../src/main/ptyRegistry'

/** pty de mentira: guarda os sinais recebidos e sai quando o teste mandar (ou sozinho, ao receber um dos sinais de `diesOn`) */
function fakePty(diesOn: string[] = []) {
  const signals: (string | undefined)[] = []
  let exit: (() => void) | undefined
  const pty = {
    onExit: (cb: () => void) => ((exit = cb), { dispose() {} }),
    kill: (sig?: string) => {
      signals.push(sig)
      if (sig && diesOn.includes(sig)) setTimeout(() => exit?.(), 5)
    }
  } as unknown as IPty
  return { pty, signals, exit: () => exit?.() }
}

describe('shutdownPtys', () => {
  it('sem pty vivo, resolve na hora', async () => {
    await shutdownPtys(50)
    expect(livePtys()).toBe(0)
  })
  it('espera todos avisarem a saída', async () => {
    const a = fakePty(['SIGHUP'])
    const b = fakePty(['SIGHUP'])
    trackPty(a.pty)
    trackPty(b.pty)
    expect(livePtys()).toBe(2)
    await shutdownPtys(1000)
    expect(livePtys()).toBe(0)
    expect(a.signals).toEqual(['SIGHUP'])
  })
  it('mata à força quem ignora o primeiro pedido', async () => {
    const stubborn = fakePty(['SIGKILL'])
    trackPty(stubborn.pty)
    await shutdownPtys(200)
    expect(stubborn.signals).toEqual(['SIGHUP', 'SIGKILL'])
    expect(livePtys()).toBe(0)
  })
  it('não fica preso se um pty nunca sair', async () => {
    const zombie = fakePty()
    trackPty(zombie.pty)
    const t = Date.now()
    await shutdownPtys(120)
    expect(Date.now() - t).toBeLessThan(1000)
    zombie.exit()
    expect(livePtys()).toBe(0)
  })
})
