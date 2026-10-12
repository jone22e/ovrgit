/** "há 3 min": tempo decorrido desde `ms`, curto, para listas e cartões (`now` vem de um relógio reativo) */
export function ago(now: number, ms: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}
