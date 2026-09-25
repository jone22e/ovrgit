import { describe, expect, it } from 'vitest'
import { parseCsv, parseSshConfig } from '../src/main/sshImport'

describe('importar conexões', () => {
  it('lê ~/.ssh/config ignorando curingas', () => {
    const c = parseSshConfig(`
Host *
  ServerAliveInterval 30
Host prod web-prod
  HostName 10.20.4.200
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/prod.pem
Host *.interno
  User x
Host staging # comentário
  HostName staging.exemplo.com
`)
    expect(c.map((x) => `${x.name}|${x.host}|${x.user}|${x.port}`)).toEqual([
      'prod|10.20.4.200|ubuntu|2222',
      'web-prod|10.20.4.200|ubuntu|2222',
      'staging|staging.exemplo.com||22'
    ])
    expect(c[0].identityFile).toMatch(/\.ssh\/prod\.pem$/)
  })

  it('lê CSV no formato do Termius e TSV com nomes em português', () => {
    const csv = 'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username\n"Clientes/Flexi",flexi-prod,,"10.0.0.5",ssh,22,deploy\n,gatway-smart,,1.2.3.4,ssh,2200,root\n'
    expect(parseCsv(csv).map((x) => `${x.group}|${x.name}|${x.host}|${x.port}|${x.user}`)).toEqual([
      'Clientes|flexi-prod|10.0.0.5|22|deploy',
      '|gatway-smart|1.2.3.4|2200|root'.replace(/^\|/, 'null|')
    ])
    const tsv = 'nome\tendereco\tusuario\tporta\nServidor\t10.1.1.1\tubuntu\t22\n'
    expect(parseCsv(tsv)[0]).toMatchObject({ name: 'Servidor', host: '10.1.1.1', user: 'ubuntu', port: 22 })
    expect(parseCsv('x,y\n1,2')).toEqual([])
  })
})
