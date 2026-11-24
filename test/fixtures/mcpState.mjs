// MCP de teste: representa a aba selecionada sem abrir ou controlar um navegador.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

let tab = 'inicial'
const server = new Server({ name: 'MCP de teste', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'state', description: 'Lê ou troca a aba', inputSchema: { type: 'object', properties: { tab: { type: 'string' } } } }
] }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (typeof request.params.arguments?.tab === 'string') tab = request.params.arguments.tab
  return { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, tab, cwd: process.cwd() }) }] }
})
await server.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
