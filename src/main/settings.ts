import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/types'
import { GRID_DEFAULT } from '../shared/grid'
import { promoteConversationIcons } from '../shared/repoGroups'

const DEFAULTS: Settings = {
  theme: 'ovseer',
  ovseerUrl: 'https://ovseer.openflexi.com',
  ovseerWorkspaceId: null,
  branchPrefix: 'feature',
  terminalFont: 'Source Code Pro',
  terminalFontSize: 14,
  terminalFontWeight: 500,
  sshConnections: [],
  watchAgents: true,
  agentLinks: {},
  snippets: [],
  provider: 'claude',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  claudeModel: 'sonnet',
  codexModel: '',
  agyModel: '',
  agentInstructions: '',
  agentFont: '',
  agentFontSize: 14,
  agentGrid: GRID_DEFAULT,
  autoUpdate: true,
  services: [],
  awsProfile: '',
  awsWatch: true,
  recentProjects: [],
  lastProject: null,
  buddy: false,
  queueReuse: true,
  queueSmart: true,
  repoGroups: [],
  repoIcons: {},
  restoreAgents: true,
  cardIndicator: 'ring',
  managerConversationVoice: false
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
  const loaded = cache!
  if (!loaded.agentIconsPromoted) {
    try {
      const history = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'agent-history', 'index.json'), 'utf8')) as { items?: { cwd?: string; extraDirs?: string[]; icon?: string }[] }
      const conversations = (Array.isArray(history.items) ? history.items : [])
        .filter((item): item is { cwd: string; extraDirs?: string[]; icon: string } => typeof item?.cwd === 'string' && typeof item.icon === 'string')
        .map((item) => ({ cwd: item.cwd, icon: item.icon, extraDirs: Array.isArray(item.extraDirs) ? item.extraDirs.filter((dir) => typeof dir === 'string') : [] }))
      const promoted = promoteConversationIcons(loaded.repoGroups, loaded.repoIcons, conversations)
      cache = saveSettings({ ...promoted, agentIconsPromoted: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Não consegui promover os ícones antigos:', (e as Error).message)
    }
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
  // os mais antigos saem da lista quando passa de 30 (a visão geral do seletor lê até esse tanto)
  const recent = [root, ...getSettings().recentProjects.filter((p) => p !== root)].slice(0, 30)
  return saveSettings({ recentProjects: recent, lastProject: root })
}
