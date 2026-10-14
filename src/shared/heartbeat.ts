/**
 * Sinais vitais do agente: o traçado de eletrocardiograma no rodapé do cartão diz o estado antes de ler qualquer
 * texto. Cada estado tem um ritmo: rodando, firme e regular (pouco menos de 2 batidas por segundo); aguardando você, lento e
 * espaçado (uma a cada ~2,6 s); concluído, em repouso (batida pequena a cada ~5,5 s); parado (rodando sem saída),
 * fora de compasso; falhou, linha reta. O traçado é um caminho SVG que rola para a esquerda: `cell` é a largura de
 * um compasso e `seconds` quanto ele leva para passar.
 *
 * Custo: o <svg> inteiro é que se move (transformação composta na GPU, sem repintar), dentro de um invólucro de
 * largura fixa que o recorta; as bordas esmaecem com um degradê sobreposto, não com máscara (a máscara custava
 * cerca de cinco vezes mais GPU). Com 16 cartões animados: ~0,5% de CPU no renderer e ~0,7% no processo de GPU.
 */
export type HeartbeatTone = 'live' | 'waiting' | 'done' | 'stalled' | 'error' | 'idle' | 'standby'

/** Largura fixa do traçado no cartão (px, igual para todos os estados) e linha de base */
export const HB_WIDTH = 60
export const HB_HEIGHT = 16
const BASE = 8
/** Largura de uma batida */
export const BEAT_WIDTH = 24

const n = (v: number) => String(+v.toFixed(2))
/** Uma batida (ondas P, QRS e T) de amplitude `amp`, em movimentos relativos, começando e terminando na linha de base */
export const beat = (amp: number) =>
  [
    'l3,0', `l2,${n(-0.15 * amp)}`, `l2,${n(0.15 * amp)}`, 'l2,0',
    `l1.5,${n(0.25 * amp)}`, `l2,${n(-1.25 * amp)}`, `l2,${n(1.45 * amp)}`, `l1.5,${n(-0.45 * amp)}`,
    'l3,0', `l2,${n(-0.3 * amp)}`, `l3,${n(0.3 * amp)}`
  ].join('')

export interface Rhythm {
  /** Batidas dentro de um compasso: onde começa cada uma (x) e a amplitude */
  beats: { x: number; amp: number }[]
  /** Largura do compasso */
  cell: number
  /** Segundos que um compasso leva para passar (0: não se move) */
  seconds: number
  /** Dica ao passar o mouse */
  label: string
}
export const RHYTHMS: Record<HeartbeatTone, Rhythm> = {
  live: { beats: [{ x: 4, amp: 6 }], cell: 32, seconds: 0.6, label: 'Rodando: firme e regular' },
  waiting: { beats: [{ x: 48, amp: 6 }], cell: 120, seconds: 2.6, label: 'Aguardando você: lento e espaçado' },
  done: { beats: [{ x: 48, amp: 2.2 }], cell: 120, seconds: 5.5, label: 'Concluído: em repouso' },
  stalled: { beats: [{ x: 4, amp: 6 }, { x: 32, amp: 4 }, { x: 78, amp: 7 }], cell: 120, seconds: 1.6, label: 'Parado: fora de compasso, sem avançar' },
  error: { beats: [], cell: 120, seconds: 0, label: 'Falhou: sem batida' },
  idle: { beats: [], cell: 120, seconds: 0, label: '' },
  standby: { beats: [], cell: 120, seconds: 0, label: 'Em espera' }
}

/** Compassos necessários: cobrem a janela mais um (o que sai pela esquerda já entrou pela direita) */
const cellsOf = (tone: HeartbeatTone) => Math.ceil(HB_WIDTH / RHYTHMS[tone].cell) + 1
/** Largura total do caminho (o <svg> que rola) */
export const heartbeatSpan = (tone: HeartbeatTone) => cellsOf(tone) * RHYTHMS[tone].cell

/** Caminho do traçado: os compassos repetidos, de ponta a ponta */
export function heartbeatPath(tone: HeartbeatTone): string {
  const r = RHYTHMS[tone]
  const cells = cellsOf(tone)
  let d = `M0,${BASE}`
  for (let c = 0; c < cells; c++) {
    let x = 0
    for (const b of r.beats) {
      if (b.x > x) d += `h${n(b.x - x)}`
      d += beat(b.amp)
      x = b.x + BEAT_WIDTH
    }
    if (r.cell > x) d += `h${n(r.cell - x)}`
  }
  return d
}
