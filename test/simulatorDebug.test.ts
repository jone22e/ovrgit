import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceState, Settings } from '../src/shared/types'

const mocks = vi.hoisted(() => ({ settings: vi.fn(), save: vi.fn(), states: vi.fn(), start: vi.fn(), target: vi.fn(), fetch: vi.fn(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, webContents: { getAllWebContents: () => [{ isDestroyed: () => false, send: mocks.send }] } }))
vi.mock('../src/main/settings', () => ({ getSettings: mocks.settings, saveSettings: mocks.save }))
vi.mock('../src/main/services', () => ({ serviceStates: mocks.states, startService: mocks.start, serviceOutput: () => ['erro de compilação confirmado'] }))
vi.mock('../src/main/simulators', () => ({ simulatorDebugTarget: mocks.target }))
vi.mock('node:net', () => ({ default: { createServer: () => {
  const server = new EventEmitter() as EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  server.listen = vi.fn((_port, _host, cb) => cb())
  server.close = vi.fn((cb) => cb())
  return server
} } }))
import { debugCommand, discoverSimulatorProjects, simulatorDebugProject, simulatorDebugProjects, startSimulatorDebug } from '../src/main/simulatorDebug'

let root: string
let settings: Pick<Settings, 'services' | 'recentProjects' | 'repoGroups'>
let states: ServiceState[]
let metroRoots: Map<number, string>
let buildCode: number
const progress = vi.fn()

beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovseer-debug-'$-")))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.84.1' } }))
  await fs.mkdir(path.join(root, 'ios'))
  await fs.mkdir(path.join(root, 'android'))
  await fs.mkdir(path.join(root, 'node_modules/react-native'), { recursive: true })
  await fs.writeFile(path.join(root, 'node_modules/react-native/cli.js'), '')
  settings = { services: [], recentProjects: [root], repoGroups: [] }
  states = []
  metroRoots = new Map()
  buildCode = 0
  mocks.settings.mockImplementation(() => settings)
  mocks.save.mockImplementation((patch) => { settings = { ...settings, ...patch }; return settings })
  mocks.states.mockImplementation(() => states)
  mocks.target.mockImplementation(async (id: string) => ({ device: { id, name: 'Aparelho escolhido', platform: id.startsWith('ios:') ? 'ios' : 'android' }, target: id.startsWith('ios:') ? id.slice(4) : 'emulator-5580' }))
  mocks.fetch.mockImplementation(async (url: string) => {
    const port = Number(new URL(url).port)
    return { ok: metroRoots.has(port), text: async () => 'packager-status:running', headers: new Headers(metroRoots.has(port) ? { 'X-React-Native-Project-Root': metroRoots.get(port)! } : {}) }
  })
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.start.mockImplementation(async (id: string) => {
    const service = settings.services.find((s) => s.id === id)!
    if (service.name.endsWith('· Metro')) {
      const port = Number(/'--port' '(\d+)'/.exec(service.command)![1])
      metroRoots.set(port, root)
      states.push({ id, status: 'running', ports: [port] })
    } else states.push({ id, status: 'exited', exitCode: buildCode })
  })
})
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }) })

describe('Play de depuração no simulador', () => {
  it('busca somente nos repositórios da conversa, sem incluir apps de recentes ou grupos salvos', async () => {
    settings.repoGroups = [{ id: 'grupo', name: 'Grupo', dirs: [root] }]
    const web = path.join(root, 'web')
    await fs.mkdir(web)
    await fs.writeFile(path.join(web, 'package.json'), '{"dependencies":{"vite":"7"}}')
    settings.recentProjects.push(web, '/pasta/inexistente')
    expect(await simulatorDebugProjects([])).toEqual([])
    expect(await simulatorDebugProjects([web])).toEqual([])
    expect(await simulatorDebugProjects([root, root])).toEqual([{ root, name: path.basename(root), kind: 'react-native', platforms: ['ios', 'android'] }])
    await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"react-native":"0.84","expo":"55"}}')
    expect(await simulatorDebugProject(root)).toMatchObject({ kind: 'expo', platforms: ['ios', 'android'] })
    expect(await simulatorDebugProject('relativo')).toBeNull()
  })

  it('descobre o app Expo dentro do monorepo mesmo sem ios/android e ignora dependências e arquivos de build', async () => {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"academia","private":true}')
    const mobile = path.join(root, 'apps/mobile')
    await fs.mkdir(mobile, { recursive: true })
    await fs.writeFile(path.join(mobile, 'package.json'), '{"dependencies":{"react-native":"0.88.1","expo":"~58.0.26"}}')
    await fs.writeFile(path.join(mobile, 'app.json'), '{"expo":{"name":"Academia","ios":{"bundleIdentifier":"app.academia.aluno"}}}')
    const hidden = path.join(root, 'node_modules/falso')
    await fs.mkdir(hidden, { recursive: true })
    await fs.copyFile(path.join(mobile, 'package.json'), path.join(hidden, 'package.json'))
    expect(await discoverSimulatorProjects(root)).toEqual([{ root: mobile, name: `${path.basename(root)} / apps/mobile`, kind: 'expo', platforms: ['ios', 'android'] }])
    expect(await simulatorDebugProjects([root, mobile])).toHaveLength(1)
    await fs.writeFile(path.join(mobile, 'app.json'), '{"expo":{"platforms":["ios"]}}')
    expect(await simulatorDebugProject(mobile)).toMatchObject({ platforms: ['ios'] })
  })

  it('usa o CLI Expo para iniciar o servidor e compilar Debug no dispositivo exato', async () => {
    await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"react-native":"0.88.1","expo":"~58.0.26"}}')
    await fs.mkdir(path.join(root, 'node_modules/expo/bin'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules/expo/bin/cli'), '')
    await startSimulatorDebug(root, 'ios:EXPO-UDID', progress)
    expect(settings.services[0].command).toContain("'node_modules/expo/bin/cli' 'start' '--dev-client' '--localhost' '--port' '8081'")
    expect(settings.services[1].command).toContain("'run:ios' '--device' 'EXPO-UDID' '--configuration' 'Debug' '--no-bundler' '--port' '8081'")
    states = states.filter((s) => s.status === 'running')
    await startSimulatorDebug(root, 'android:ExpoAVD', progress)
    expect(settings.services.at(-1)!.command).toContain("'run:android' '--device' 'emulator-5580' '--variant' 'debug' '--no-bundler' '--port' '8081'")
  })

  it('inicia Metro e compila Debug no UDID escolhido, sem abrir terminal externo', async () => {
    await startSimulatorDebug(root, 'ios:UDID-EXATO', progress)
    expect(mocks.target).toHaveBeenCalledWith('ios:UDID-EXATO')
    const metro = settings.services.find((s) => s.name.endsWith('· Metro'))!
    const build = settings.services.find((s) => s.id !== metro.id)!
    expect(metro.command).toContain("'start' '--port' '8081' '--no-interactive'")
    expect(build.cwd).toBe(root)
    expect(build.command).toContain("'run-ios' '--udid' 'UDID-EXATO' '--mode' 'Debug' '--no-packager' '--port' '8081'")
    expect(build.autostart).toBe(false)
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ root, deviceId: 'ios:UDID-EXATO', message: 'App iniciado em modo Debug.', serviceId: build.id }))
  })

  it('reaproveita somente Metro que confirma o mesmo projeto, inclusive em porta de serviço cadastrado', async () => {
    const other = path.join(root, 'outro')
    await fs.mkdir(other)
    metroRoots.set(8081, other)
    metroRoots.set(9090, root)
    settings.services = [{ id: 'metro-existente', name: 'Metro existente', cwd: root, command: 'npm start' }]
    states = [{ id: 'metro-existente', status: 'running', ports: [9090] }]
    await startSimulatorDebug(root, 'ios:ID', progress)
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(settings.services.at(-1)!.command).toContain("'--port' '9090'")
    expect(settings.services).toHaveLength(2)
  })

  it('usa outra porta quando 8081 pertence a outro projeto e usa o serial ADB real do AVD', async () => {
    const other = path.join(root, 'outro')
    await fs.mkdir(other)
    metroRoots.set(8081, other)
    // A porta ocupada deve ser recusada pelo bind, mesmo que a resposta HTTP seja de outro app.
    const net = (await import('node:net')).default
    const original = net.createServer
    const create = vi.spyOn(net, 'createServer')
    create.mockImplementation(() => {
      const server = original()
      server.listen = vi.fn((port, _host, cb) => { if (port === 8081) server.emit('error', new Error('EADDRINUSE')); else cb(); return server }) as typeof server.listen
      return server
    })
    try {
      await startSimulatorDebug(root, 'android:Nome-do-AVD', progress)
      expect(settings.services.at(-1)!.command).toContain("'run-android' '--deviceId' 'emulator-5580' '--mode' 'debug' '--no-packager' '--port' '8082'")
    } finally { create.mockRestore() }
  })

  it('propaga erros da compilação com log e permite tentar novamente', async () => {
    metroRoots.set(8081, root)
    buildCode = 1
    await expect(startSimulatorDebug(root, 'ios:ID', progress)).rejects.toThrow('erro de compilação confirmado')
    buildCode = 0
    states = []
    await startSimulatorDebug(root, 'ios:ID', progress)
    expect(settings.services).toHaveLength(1)
  })

  it('não executa comandos se faltam dependências ou se o aparelho não existe', async () => {
    await fs.rm(path.join(root, 'node_modules'), { recursive: true })
    await expect(startSimulatorDebug(root, 'ios:ID', progress)).rejects.toThrow('dependências')
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    await fs.mkdir(path.join(root, 'node_modules/react-native'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules/react-native/cli.js'), '')
    mocks.target.mockRejectedValueOnce(new Error('Aparelho não encontrado'))
    await expect(startSimulatorDebug(root, 'ios:inventado', progress)).rejects.toThrow('Aparelho não encontrado')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('impede duas inicializações simultâneas do mesmo projeto ou aparelho', async () => {
    let finish!: () => void
    mocks.target.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ device: { platform: 'ios', name: 'iPhone' }, target: 'ID' }) }))
    const first = startSimulatorDebug(root, 'ios:ID', progress)
    await vi.waitFor(() => expect(mocks.target).toHaveBeenCalled())
    await expect(startSimulatorDebug(root, 'ios:OUTRO', progress)).rejects.toThrow('em andamento')
    finish()
    await first
  })

  it('preserva argumentos com espaços, aspas, dólar e substituições no shell dos serviços', async () => {
    const args = ["pasta d'app", '$HOME', '$(printf injetado)', 'linha\nseguinte', '`printf teste`']
    const command = debugCommand([process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args])
    const result = await promisify(execFile)('/bin/sh', ['-c', command])
    expect(JSON.parse(result.stdout)).toEqual(args)
  })
})
