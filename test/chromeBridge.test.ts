import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { request } from 'node:http'
import { ChromeBridge } from '../src/main/chromeBridge'

const bridges: ChromeBridge[] = [], clients: Client[] = []
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()))
  await Promise.allSettled(bridges.splice(0).map((b) => b.close()))
})
async function setup() {
  const bridge = new ChromeBridge(); bridges.push(bridge)
  const { connection, port } = await bridge.ready
  const extension = async (route: string, body: object = {}) => {
    const response = await fetch(connection + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return response.json() as Promise<{ sessions: { id: string; label: string; state: string }[]; commands: { id: string; session: string; name: string; args: object }[] }>
  }
  return { bridge, connection, extension, port }
}

describe('extensão própria do Ovseer — ponte local', () => {
  it('lista ferramentas sem acessar o Chrome e mantém a URL ao reconectar o CLI', async () => {
    const { bridge, extension } = await setup()
    const session = bridge.session('Claude · Compras')
    const { url } = await session.ready
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: 'agente', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(url)))
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('browser_snapshot')
      expect((await extension('/poll', { immediate: true })).sessions).toEqual([])
      await client.close()
    }
  })

  it('exige autorização e entrega comandos à extensão com isolamento por conversa', async () => {
    const { bridge, extension } = await setup()
    const a = bridge.session('Codex · Loja'), b = bridge.session('Claude · Financeiro')
    await expect(a.call('browser_tabs', { action: 'list' })).rejects.toThrow('autorize uma aba')
    const info = (await extension('/poll', { immediate: true })).sessions[0]
    expect(info.label).toBe('Codex · Loja')
    await extension('/permission', { session: info.id, approved: true })
    const answer = a.call('browser_tabs', { action: 'list' })
    const { commands } = await extension('/poll', { immediate: true })
    expect(commands[0]).toMatchObject({ session: info.id, name: 'browser_tabs', args: { action: 'list' } })
    await extension('/result', { id: commands[0].id, result: [{ tabId: 42 }] })
    expect(await answer).toEqual([{ tabId: 42 }])
    await expect(b.call('browser_snapshot', {})).rejects.toThrow('autorize uma aba')
    expect((await a.ready).url).not.toBe((await b.ready).url)
  })

  it('interromper revoga comandos pendentes e impede novas ações até nova autorização', async () => {
    const { bridge, extension } = await setup()
    const session = bridge.session('Codex')
    await expect(session.call('browser_snapshot', {})).rejects.toThrow()
    const { id } = (await extension('/poll', { immediate: true })).sessions[0]
    await extension('/permission', { session: id, approved: true })
    const pending = expect(session.call('browser_click', { ref: 'e1-3' })).rejects.toThrow('interrompido')
    await extension('/permission', { session: id, approved: false })
    await pending
    await expect(session.call('browser_snapshot', {})).rejects.toThrow('nova autorização')
    expect((await extension('/poll', { immediate: true })).commands).toEqual([])
    await session.close()
    expect((await extension('/poll', { immediate: true })).sessions).toEqual([])
  })

  it('rejeita páginas web, Host falso, credencial errada e argumentos inválidos', async () => {
    const { bridge, connection, port } = await setup()
    const session = bridge.session('Codex'), { url } = await session.ready
    expect((await fetch(url, { method: 'POST', headers: { Origin: 'https://malicioso.test' } })).status).toBe(403)
    expect((await fetch(connection + '/poll', { method: 'POST', headers: { Origin: 'https://malicioso.test' }, body: '{}' })).status).toBe(403)
    const fakeHost = await new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { Host: 'outro.test' } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    expect(fakeHost).toBe(403)
    expect((await fetch(`http://127.0.0.1:${port}/extension/errado/poll`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(url)).status).toBe(405)
    await expect(session.call('browser_click', {})).rejects.toThrow('Argumentos inválidos')
    await expect(session.call('browser_type', { ref: 'e1-1', text: 12 })).rejects.toThrow('Argumentos inválidos')
  })

  it('transporta capturas como imagem MCP e suporta a API usada pelo Antigravity', async () => {
    const { bridge, extension } = await setup()
    const session = bridge.session('Claude'), { url } = await session.ready
    const client = new Client({ name: 'agente', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    expect((await client.callTool({ name: 'browser_snapshot', arguments: {} })).isError).toBe(true)
    const { id } = (await extension('/poll', { immediate: true })).sessions[0]
    await extension('/permission', { session: id, approved: true })
    const screenshot = client.callTool({ name: 'browser_take_screenshot', arguments: {} })
    let commands: { id: string }[] = []
    // A requisição MCP chega por outro socket; a consulta longa espera o comando.
    while (!commands.length) commands = (await extension('/poll')).commands
    await extension('/result', { id: commands[0].id, result: 'aW1hZ2Vt' })
    expect((await screenshot).content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2Vt' }])
    expect((await (await fetch(url + '/tools')).json()).tools.length).toBeGreaterThan(10)
    const api = fetch(url + '/call', { method: 'POST', body: JSON.stringify({ name: 'browser_snapshot', arguments: {} }) }).then((r) => r.json())
    commands = []
    while (!commands.length) commands = (await extension('/poll')).commands
    await extension('/result', { id: commands[0].id, result: 'Árvore verificada' })
    expect(await api).toEqual({ result: 'Árvore verificada' })
  })

  it('cancelar a chamada remove comandos ainda não entregues', async () => {
    const { bridge, extension } = await setup()
    const session = bridge.session('Codex')
    await expect(session.call('browser_snapshot', {})).rejects.toThrow()
    const { id } = (await extension('/poll', { immediate: true })).sessions[0]
    await extension('/permission', { session: id, approved: true })
    const abort = new AbortController()
    const pending = expect(session.call('browser_snapshot', {}, abort.signal)).rejects.toThrow('Interrompido')
    abort.abort()
    await pending
    expect((await extension('/poll', { immediate: true })).commands).toEqual([])
  })
})
