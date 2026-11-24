import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PersistentMcp } from '../src/main/persistentMcp'

const sessions: PersistentMcp[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()))
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()))
})

function session() {
  const s = new PersistentMcp({ command: process.execPath, args: [path.resolve('test/fixtures/mcpState.mjs')], cwd: process.cwd() })
  sessions.push(s)
  return s
}

async function connect(s: PersistentMcp) {
  const { url } = await s.ready
  const client = new Client({ name: 'CLI de teste', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

async function state(client: Client, tab?: string) {
  const result = await client.callTool({ name: 'state', arguments: tab ? { tab } : {} })
  return JSON.parse((result.content as { text: string }[])[0].text) as { pid: number; tab: string; cwd: string }
}

describe('MCP persistente por conversa', () => {
  it('mantém o processo e a aba selecionada quando outro CLI retoma a conversa', async () => {
    const s = session()
    const first = await connect(s)
    expect((await first.listTools()).tools.map((t) => t.name)).toEqual(['state'])
    const before = await state(first, 'pedido-123')
    expect(before.cwd).toBe(process.cwd())
    await first.close()

    const second = await connect(s)
    const after = await state(second)
    expect(after).toEqual(before)
    await s.close()
    expect(() => process.kill(before.pid, 0)).toThrow()
  })

  it('isola processos e abas de conversas diferentes', async () => {
    const first = await connect(session())
    const second = await connect(session())
    const a = await state(first, 'conversa-A')
    const b = await state(second)
    expect(a.pid).not.toBe(b.pid)
    expect(b.tab).toBe('inicial')
    expect((await state(first)).tab).toBe('conversa-A')
  })

  it('recupera a conexão se o processo MCP terminar', async () => {
    const client = await connect(session())
    const before = await state(client)
    process.kill(before.pid, 'SIGKILL')
    await expect.poll(() => {
      try { process.kill(before.pid, 0); return false } catch { return true }
    }).toBe(true)
    const after = await state(client)
    expect(after.pid).not.toBe(before.pid)
  })

  it('inicializar o HTTP não executa o MCP nem acessa o navegador', async () => {
    const s = new PersistentMcp({ command: '/comando-que-nao-existe' })
    sessions.push(s)
    const client = await connect(s)
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} })
  })

  it('lista as ferramentas do Playwright instalado sem conectar ao navegador', async () => {
    const require = createRequire(import.meta.url)
    const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
    const s = new PersistentMcp({ command: process.execPath, args: [cli, '--extension', '--ignore-roots'] })
    sessions.push(s)
    const first = await connect(s)
    const tools = (await first.listTools()).tools.map((t) => t.name)
    expect(tools).toContain('browser_tabs')
    expect(tools).toContain('browser_navigate')
    await first.close()
    const second = await connect(s)
    expect((await second.listTools()).tools.map((t) => t.name)).toEqual(tools)
  })

  it('exige a URL exclusiva e rejeita pedidos com Origin de páginas', async () => {
    const s = session()
    const { url } = await s.ready
    expect((await fetch(new URL('/mcp/outra-conversa', url), { method: 'POST' })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { Origin: 'https://exemplo.com' } })).status).toBe(403)
    expect((await fetch(url)).status).toBe(405)
  })

  it('encerra também quando a conversa fecha antes de a porta abrir', async () => {
    const s = session()
    const ready = expect(s.ready).rejects.toThrow('Conexão MCP encerrada.')
    await s.close()
    await ready
  })
})
