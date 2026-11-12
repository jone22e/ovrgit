import { app } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const tokenFile = () => path.join(app.getPath('userData'), 'playwright-mcp-token')

function savedToken(): string {
  try { return readFileSync(tokenFile(), 'utf8').trim() } catch { return '' }
}

export function chromeExtensionTokenConfigured(): boolean {
  return !!savedToken()
}

export function setChromeExtensionToken(input: string): boolean {
  const token = input.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, '')
  if (!token) {
    rmSync(tokenFile(), { force: true })
    return false
  }
  if (token.length > 512 || /\s/.test(token)) throw new Error('Token da extensão inválido.')
  mkdirSync(path.dirname(tokenFile()), { recursive: true })
  writeFileSync(tokenFile(), `${token}\n`, { mode: 0o600 })
  chmodSync(tokenFile(), 0o600)
  return true
}

/** MCP que controla abas do Chrome existente por meio da extensão Playwright. */
export function chromeExtensionMcp(): { command: string; args: string[]; env: Record<string, string> } | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null
  const cli = path.join(app.getAppPath(), 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (!existsSync(cli)) return null
  const token = savedToken()
  return {
    command: process.execPath,
    args: [cli, '--extension', '--ignore-roots'],
    env: { ELECTRON_RUN_AS_NODE: '1', ...(token ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } : {}) }
  }
}
