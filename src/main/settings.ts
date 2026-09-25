import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = {
  theme: 'ovrgit',
  ovseerUrl: 'https://ovseer.openflexi.com',
  ovseerWorkspaceId: null,
  branchPrefix: 'feature',
  terminalFont: 'Source Code Pro',
  terminalFontSize: 14,
  terminalFontWeight: 500,
  sshConnections: [],
  watchAgents: true,
  snippets: [],
  provider: 'claude',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  claudeModel: 'sonnet',
  codexModel: '',
  recentProjects: [],
  lastProject: null
}

const file = () => path.join(app.getPath('userData'), 'settings.json')

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache!
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch }
  mkdirSync(path.dirname(file()), { recursive: true })
  // Grava em arquivo temporário e renomeia, para não corromper o JSON se o app fechar no meio
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, file())
  cache = next
  return next
}

export function rememberProject(root: string): Settings {
  const recent = [root, ...getSettings().recentProjects.filter((p) => p !== root)].slice(0, 10)
  return saveSettings({ recentProjects: recent, lastProject: root })
}
