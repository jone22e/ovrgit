import { ipcMain, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { SimulatorDebugProgress, SimulatorDebugProject, SimulatorPlatform } from '../shared/simulator'
import { getSettings, saveSettings } from './settings'
import { serviceOutput, serviceStates, startService } from './services'
import { simulatorDebugTarget } from './simulators'

const activeProjects = new Set<string>()
const activeDevices = new Set<string>()
let metroQueue: Promise<unknown> = Promise.resolve()
const pause = () => new Promise((resolve) => setTimeout(resolve, 500))
// O shell dos serviços é interativo: todos os argumentos variáveis precisam de aspas literais.
export function debugCommand(args: string[]) {
  return args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(' ')
}

export async function simulatorDebugProject(input: string): Promise<SimulatorDebugProject | null> {
  try {
    if (!path.isAbsolute(input)) return null
    const root = await fs.realpath(input)
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    if (!pkg.dependencies?.['react-native'] && !pkg.devDependencies?.['react-native']) return null
    const expo = !!(pkg.dependencies?.expo || pkg.devDependencies?.expo)
    const platforms: SimulatorPlatform[] = []
    if (expo) {
      const config = JSON.parse(await fs.readFile(path.join(root, 'app.json'), 'utf8').catch(() => '{}'))
      for (const platform of ['ios', 'android'] as const) {
        if (!Array.isArray(config.expo?.platforms) || config.expo.platforms.includes(platform)) platforms.push(platform)
      }
    } else {
      for (const platform of ['ios', 'android'] as const) {
        if ((await fs.stat(path.join(root, platform)).catch(() => null))?.isDirectory()) platforms.push(platform)
      }
    }
    return platforms.length ? { root, name: path.basename(root), kind: expo ? 'expo' : 'react-native', platforms } : null
  } catch { return null }
}

/** Busca limitada às pastas do repositório; não depende do nome apps/mobile nem atravessa dependências. */
export async function discoverSimulatorProjects(input: string): Promise<SimulatorDebugProject[]> {
  if (!path.isAbsolute(input)) return []
  const root = await fs.realpath(input).catch(() => '')
  if (!root) return []
  const direct = await simulatorDebugProject(root)
  if (direct) return [direct]
  const ignored = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'Pods', 'ios', 'android', 'tmp', 'target'])
  const queue = [{ dir: root, depth: 0 }]
  const found: SimulatorDebugProject[] = []
  for (let i = 0; i < queue.length && i < 300; i++) {
    const { dir, depth } = queue[i]
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    if (dir !== root && entries.some((e) => e.name === 'package.json' && e.isFile())) {
      const project = await simulatorDebugProject(dir)
      if (project) { found.push({ ...project, name: `${path.basename(root)} / ${path.relative(root, dir)}` }); continue }
    }
    if (depth < 3) for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
    }
  }
  return found
}

export async function simulatorDebugProjects(extra: string[] = []): Promise<SimulatorDebugProject[]> {
  const settings = getSettings()
  const roots = [...new Set([...extra, ...settings.recentProjects, ...settings.repoGroups.flatMap((g) => g.dirs)])]
  const projects = (await Promise.all(roots.map(discoverSimulatorProjects))).flat()
  return [...new Map(projects.map((p) => [p.root, p])).values()]
}

function debugService(root: string, name: string, command: string): string {
  const found = getSettings().services.find((s) => s.cwd === root && s.command === command)
  if (found) return found.id
  const id = randomUUID()
  const settings = saveSettings({ services: [...getSettings().services, { id, cwd: root, name, command, autostart: false }] })
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) wc.send('settings:changed', settings)
  return id
}

async function metroAt(port: number, root: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(800) })
    const reported = response.headers.get('X-React-Native-Project-Root')
    return response.ok && await response.text() === 'packager-status:running' && !!reported && await fs.realpath(reported).catch(() => '') === root
  } catch { return false }
}
function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
function serviceFailure(id: string, fallback: string) {
  return new Error(`${fallback}\n${serviceOutput(id, 12).join('\n')}`.trim())
}
async function ensureMetro(project: SimulatorDebugProject, progress: (message: string, serviceId?: string) => void) {
  const settings = getSettings()
  const states = serviceStates()
  const knownPorts = states.filter((state) => state.status === 'running' && settings.services.some((s) => s.id === state.id && s.cwd === project.root)).flatMap((s) => s.ports ?? [])
  const metroCommand = (port: number) => debugCommand(project.kind === 'expo'
    ? ['node', 'node_modules/expo/bin/cli', 'start', '--dev-client', '--localhost', '--port', String(port)]
    : ['node', 'node_modules/react-native/cli.js', 'start', '--port', String(port), '--no-interactive'])
  const ports = [...new Set([...knownPorts, ...Array.from({ length: 20 }, (_, n) => 8081 + n)])]
  const pending = settings.services.find((s) => s.cwd === project.root && ports.some((port) => s.command === metroCommand(port)) && states.some((state) => state.id === s.id && state.status === 'running'))
  let available: number | undefined
  let pendingPort: number | undefined
  for (const port of ports) {
    if (await metroAt(port, project.root)) return port
    if (pending?.command === metroCommand(port)) pendingPort = port
    if (available === undefined && await freePort(port)) available = port
  }
  const port = pendingPort ?? available
  if (!port) throw new Error('Nenhuma porta livre entre 8081 e 8100 para iniciar o Metro.')
  const id = pending?.id ?? debugService(project.root, `${project.name} · Metro`, metroCommand(port))
  progress('Iniciando o Metro…', id)
  await startService(id)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await metroAt(port, project.root)) return port
    if (serviceStates().find((s) => s.id === id)?.status !== 'running') throw serviceFailure(id, 'O Metro não iniciou.')
    await pause()
  }
  throw serviceFailure(id, 'O Metro não ficou pronto em 90 segundos. Confira o log antes de tentar novamente.')
}

export async function startSimulatorDebug(root: string, deviceId: string, notify: (progress: SimulatorDebugProgress) => void) {
  const project = await simulatorDebugProject(root)
  if (!project) throw new Error('Selecione um app Expo ou React Native com suporte a iOS ou Android.')
  if (process.platform === 'win32') throw new Error('A execução em depuração pelo painel ainda não está disponível no Windows.')
  if (activeProjects.has(project.root) || activeDevices.has(deviceId)) throw new Error('Já existe uma inicialização em andamento para este projeto ou aparelho. Acompanhe em Serviços.')
  activeProjects.add(project.root); activeDevices.add(deviceId)
  const progress = (message: string, serviceId?: string) => notify({ root: project.root, deviceId, message, serviceId })
  try {
    const platform = deviceId.startsWith('ios:') ? 'ios' : 'android'
    if (!project.platforms.includes(platform)) throw new Error(`O projeto não possui suporte a ${platform}.`)
    const cli = project.kind === 'expo' ? 'node_modules/expo/bin/cli' : 'node_modules/react-native/cli.js'
    await fs.access(path.join(project.root, cli)).catch(() => { throw new Error(`As dependências do projeto não estão instaladas (${cli} ausente).`) })
    progress('Preparando o aparelho selecionado…')
    const { device, target } = await simulatorDebugTarget(deviceId)
    // A escolha da porta e a subida do Metro são serializadas também entre projetos diferentes.
    const metro = metroQueue.catch(() => undefined).then(() => ensureMetro(project, progress))
    metroQueue = metro
    const port = await metro
    const command = debugCommand(project.kind === 'expo'
      ? ['node', cli, `run:${device.platform}`, '--device', target, device.platform === 'ios' ? '--configuration' : '--variant', device.platform === 'ios' ? 'Debug' : 'debug', '--no-bundler', '--port', String(port)]
      : ['node', cli, `run-${device.platform}`, device.platform === 'ios' ? '--udid' : '--deviceId', target, '--mode', device.platform === 'ios' ? 'Debug' : 'debug', '--no-packager', '--port', String(port)])
    const id = debugService(project.root, `${project.name} · Debug · ${device.name}`, command)
    if (serviceStates().find((s) => s.id === id)?.status === 'running') throw new Error('A compilação já está rodando. Acompanhe em Serviços.')
    progress('Compilando e abrindo o app em modo Debug…', id)
    await startService(id)
    // Sem limite de compilação: o primeiro build nativo pode demorar vários minutos.
    while (true) {
      const state = serviceStates().find((s) => s.id === id)
      if (state?.status === 'exited') {
        if (state.exitCode !== 0) throw serviceFailure(id, 'Não foi possível iniciar o app em depuração.')
        progress('App iniciado em modo Debug.', id)
        return
      }
      if (state?.status !== 'running') throw new Error('O serviço de depuração não está mais disponível.')
      await pause()
    }
  } finally { activeProjects.delete(project.root); activeDevices.delete(deviceId) }
}

export function registerSimulatorDebug() {
  ipcMain.handle('simulator:debug-projects', (_event, roots: unknown) => {
    if (roots !== undefined && (!Array.isArray(roots) || roots.length > 10 || roots.some((r) => typeof r !== 'string' || r.length > 4096))) throw new Error('Projetos inválidos.')
    return simulatorDebugProjects(roots as string[] | undefined)
  })
  ipcMain.handle('simulator:debug-start', (event, root: unknown, id: unknown) => {
    if (typeof root !== 'string' || root.length > 4096 || typeof id !== 'string' || id.length > 200) throw new Error('Projeto ou aparelho inválido.')
    return startSimulatorDebug(root, id, (progress) => { if (!event.sender.isDestroyed()) event.sender.send('simulator:debug-progress', progress) })
  })
}
