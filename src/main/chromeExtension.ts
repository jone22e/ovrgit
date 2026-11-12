import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** MCP que controla abas do Chrome existente por meio da extensão Playwright. */
export function chromeExtensionMcp(): { command: string; args: string[]; env: Record<string, string> } | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null
  const cli = path.join(app.getAppPath(), 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (!existsSync(cli)) return null
  let token = ''
  try {
    token = readFileSync(path.join(app.getPath('userData'), 'playwright-mcp-token'), 'utf8').trim()
  } catch { /* Sem token, a extensão pede confirmação no Chrome. */ }
  return {
    command: process.execPath,
    args: [cli, '--extension', '--ignore-roots'],
    env: { ELECTRON_RUN_AS_NODE: '1', ...(token ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } : {}) }
  }
}
