/** Agrupa pelo dia local, do mais recente ao mais antigo, preservando a ordem dentro de cada dia. */
export function groupAgentsByDate<T extends { since: number }>(agents: readonly T[], now: number) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const groups = new Map<number, T[]>()
  for (const agent of agents) {
    const day = new Date(agent.since)
    day.setHours(0, 0, 0, 0)
    const date = day.getTime()
    const group = groups.get(date)
    if (group) group.push(agent)
    else groups.set(date, [agent])
  }
  return [...groups].sort(([a], [b]) => b - a).map(([date, agents]) => ({
    date,
    label: date === today.getTime() ? 'Hoje' : date === yesterday.getTime() ? 'Ontem' : new Date(date).toLocaleDateString('pt-BR'),
    agents
  }))
}
