import { describe, expect, it } from 'vitest'
import { externalTunnelProcesses, parseProcessTable, ssmTunnelKey } from '../src/main/ssmTunnelWatch'

const database = 'aws ssm start-session --region sa-east-1 --target i-123 --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters \'{"host":["db.example.com"],"portNumber":["5432"],"localPortNumber":["55432"]}\''
const grafana = 'aws ssm start-session --target i-123 --document-name AWS-StartPortForwardingSession --parameters \'{"portNumber":["3000"],"localPortNumber":["3001"]}\''

describe('monitor de túneis SSM', () => {
  it('reconhece o mesmo destino mesmo com outra porta local', () => {
    expect(ssmTunnelKey(database.replace('55432', '55433'))).toBe(ssmTunnelKey(database))
    expect(ssmTunnelKey(grafana)).not.toBe(ssmTunnelKey(database))
    expect(ssmTunnelKey('aws ssm start-session --target i-123')).toBeNull()
  })

  it('avisa sobre processo externo e ignora filhos do serviço Ovseer', () => {
    const external = database.replace('55432', '55433')
    const processes = parseProcessTable([
      ' 10 1 /bin/zsh -l -i -c ...',
      ' 20 10 ' + database,
      ' 30 1 /bin/zsh -lc ...',
      ' 40 30 /opt/homebrew/bin/' + external,
      ' 50 1 ' + grafana,
      ' 60 1 aws ssm start-session --target i-999 --document-name AWS-StartPortForwardingSession --parameters \'{"portNumber":["3000"]}\''
    ].join('\n'))
    expect(externalTunnelProcesses(processes, [
      { id: 'db', name: 'Banco de Dados', command: database, pid: 10 },
      { id: 'grafana', name: 'Grafana', command: grafana }
    ])).toEqual([
      { id: 'db', name: 'Banco de Dados', pid: 40 },
      { id: 'grafana', name: 'Grafana', pid: 50 }
    ])
  })
})
