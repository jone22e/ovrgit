import { describe, expect, it } from 'vitest'
import { groupAgentsByDate } from '../src/renderer/src/agentDateGroups'

describe('concluídos agrupados por data', () => {
  it('ordena os dias sem trazer uma conversa antiga fixada para o grupo de hoje', () => {
    const now = new Date(2026, 10, 27, 12).getTime()
    const agents = [
      { uid: 'antiga-fixada', since: new Date(2026, 10, 25, 15).getTime() },
      { uid: 'hoje-fixada', since: new Date(2026, 10, 27, 8).getTime() },
      { uid: 'hoje', since: new Date(2026, 10, 27, 10).getTime() },
      { uid: 'ontem', since: new Date(2026, 10, 26, 23, 59).getTime() }
    ]
    expect(groupAgentsByDate(agents, now).map((g) => ({ label: g.label, ids: g.agents.map((a) => a.uid) }))).toEqual([
      { label: 'Hoje', ids: ['hoje-fixada', 'hoje'] },
      { label: 'Ontem', ids: ['ontem'] },
      { label: '25/11/2026', ids: ['antiga-fixada'] }
    ])
    expect(agents[0].uid).toBe('antiga-fixada')
  })

  it('usa a meia-noite local e atualiza os rótulos na virada do ano', () => {
    const agents = [
      { since: new Date(2026, 11, 31, 23, 59).getTime() },
      { since: new Date(2027, 0, 1, 0, 0).getTime() }
    ]
    expect(groupAgentsByDate(agents, new Date(2027, 0, 1, 0, 1).getTime()).map((g) => g.label)).toEqual(['Hoje', 'Ontem'])
    expect(groupAgentsByDate(agents, new Date(2027, 0, 2, 0, 1).getTime()).map((g) => g.label)).toEqual(['Ontem', '31/12/2026'])
  })

  it('não cria grupos vazios', () => {
    expect(groupAgentsByDate([], Date.now())).toEqual([])
  })
})
