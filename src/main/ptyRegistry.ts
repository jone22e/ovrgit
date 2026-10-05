import type { IPty } from '@lydell/node-pty'

/**
 * Os pty vivos do app (terminais e serviços). Existe por causa do encerramento: o node-pty avisa a saída de cada
 * processo chamando JavaScript, e se esse aviso chega com o app já desmontando o Node, o processo inteiro aborta
 * ("Ovseer encerrou inesperadamente"). Por isso o app, antes de sair, encerra os pty e espera os avisos chegarem.
 */
const live = new Set<IPty>()
let onEmpty: (() => void) | null = null

/** Passa a acompanhar um pty até ele encerrar */
export function trackPty(pty: IPty) {
  live.add(pty)
  pty.onExit(() => {
    live.delete(pty)
    if (!live.size) onEmpty?.()
  })
}

export const livePtys = () => live.size

function killAll(signal?: string) {
  for (const pty of live) {
    try {
      pty.kill(signal)
    } catch {
      /* já encerrado */
    }
  }
}

/**
 * Encerra todos os pty e resolve quando o último avisar que saiu. Quem não sair no primeiro pedido é morto à
 * força; `timeoutMs` é o teto da espera (o app não pode ficar preso sem fechar).
 */
export function shutdownPtys(timeoutMs = 4000): Promise<void> {
  if (!live.size) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => killAll('SIGKILL'), Math.min(1500, timeoutMs / 2))
    const giveUp = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(force)
      clearTimeout(giveUp)
      onEmpty = null
      resolve()
    }
    onEmpty = done
    // no Windows o node-pty não aceita sinal
    killAll(process.platform === 'win32' ? undefined : 'SIGHUP')
  })
}
