import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), mkdtemp: vi.fn(), readFile: vi.fn(), rm: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/ovseer' }, ipcMain: { handle: vi.fn() } }))
vi.mock('node:child_process', () => mocks)
vi.mock('node:fs', () => ({ existsSync: () => true, promises: { mkdtemp: mocks.mkdtemp, readFile: mocks.readFile, rm: mocks.rm, readdir: async () => [], realpath: async (p: string) => p, stat: async (p: string) => ({ isDirectory: () => p.endsWith('.app'), isFile: () => p.endsWith('.apk') }) } }))
vi.mock('../src/main/proto/emulator.proto?asset', () => ({ default: '/emulator.proto' }))
import { connectedSimulators, connectSimulator, disconnectSimulator, shutdownSimulators, simulatorAgentBackend, simulatorInput } from '../src/main/simulators'

class Owner extends EventEmitter {
  id = 80
  send = vi.fn()
  isDestroyed = () => false
  isCrashed = () => false
}
class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
}
let child: Child
let appMetadata: { CFBundleIdentifier: string; DTPlatformName: string }
let androidRunning = false
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const ios = { runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iOS 26.5' }], devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'ID', name: 'iPhone', isAvailable: true, state: 'Booted' }] } }

beforeEach(() => {
  vi.useFakeTimers()
  child = new Child()
  androidRunning = false
  mocks.mkdtemp.mockReset().mockResolvedValue('/temp/ovseer-simulator-test')
  mocks.readFile.mockReset().mockResolvedValue(png)
  mocks.rm.mockReset().mockResolvedValue(undefined)
  appMetadata = { CFBundleIdentifier: 'com.exemplo.app', DTPlatformName: 'iphonesimulator' }
  mocks.spawn.mockReset().mockReturnValue(child)
  mocks.execFile.mockReset().mockImplementation((_file, args: string[], _options, cb) => {
    const value = args.includes('screencap') ? png : args.includes('--json') ? JSON.stringify(ios) : args.includes('-convert') ? JSON.stringify(appMetadata)
      : args.includes('-list-avds') ? androidRunning ? 'Pixel\n' : ''
      : args.includes('devices') ? `List of devices attached\n${androidRunning ? 'emulator-5554\tdevice\n' : ''}`
      : args.includes('avd') ? 'Pixel\n' : args.includes('getprop') ? '1\n'
      : args.includes('resolve-activity') ? 'com.exemplo.app/.MainActivity\n'
      : args.includes('-p') ? '/Applications/Xcode.app/Contents/Developer' : ''
    cb(null, Buffer.from(value), Buffer.alloc(0))
    return new EventEmitter()
  })
})
afterEach(() => { shutdownSimulators(); vi.clearAllTimers(); vi.useRealTimers() })
async function connect(owner: Owner) {
  const pending = connectSimulator(owner as unknown as WebContents, 'ios:ID')
  await vi.advanceTimersByTimeAsync(1200)
  child.stdout.write(JSON.stringify({ type: 'frame', image: 'data:image/jpeg;base64,AA==', width: 720, height: 1560 }) + '\n')
  await pending
}

describe('conexão do painel com simuladores', () => {
  it('lê a captura iOS de um arquivo temporário e limpa mesmo quando a leitura falha', async () => {
    expect(await simulatorAgentBackend.screenshot('ios:ID')).toEqual(png)
    expect(mocks.execFile.mock.calls.some(([,args]) => JSON.stringify(args) === JSON.stringify(['simctl', 'io', 'ID', 'screenshot', '--type=png', '/temp/ovseer-simulator-test/screen.png']))).toBe(true)
    expect(mocks.rm).toHaveBeenCalledWith('/temp/ovseer-simulator-test', { recursive: true, force: true })
    mocks.readFile.mockRejectedValueOnce(new Error('falha na leitura'))
    await expect(simulatorAgentBackend.screenshot('ios:ID')).rejects.toThrow('falha na leitura')
    expect(mocks.rm).toHaveBeenCalledTimes(2)
  })
  it('instala e abre o APK no Android confirmado, preservando argumentos de texto e URL', async () => {
    androidRunning = true
    const owner = new Owner()
    await connectSimulator(owner, 'android:Pixel')
    await expect(simulatorAgentBackend.install('android:Pixel', '/p/App.app')).rejects.toThrow('.apk')
    expect(await simulatorAgentBackend.install('android:Pixel', '/p/Meu App.apk')).toEqual({ installed: true })
    expect(await simulatorAgentBackend.launch('android:Pixel', 'com.exemplo.app')).toEqual({ launched: true, appId: 'com.exemplo.app' })
    const url = 'exp://localhost:8081/path?a=1&b=$test'
    await simulatorAgentBackend.openUrl('android:Pixel', url)
    await simulatorAgentBackend.action('android:Pixel', { type: 'text', text: "@'" })
    const calls = mocks.execFile.mock.calls.map(([,args]) => args)
    expect(calls).toContainEqual(['-s', 'emulator-5554', 'install', '-r', '/p/Meu App.apk'])
    expect(calls).toContainEqual(['-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-n', 'com.exemplo.app/.MainActivity'])
    expect(calls).toContainEqual(['-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`])
    expect(calls).toContainEqual(['-s', 'emulator-5554', 'shell', 'input', 'text', "'@'"])
    expect(calls).toContainEqual(['-s', 'emulator-5554', 'shell', 'input', 'text', "''\\'''"])
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('instala somente o artefato confirmado para iOS Simulator no aparelho solicitado', async () => {
    const owner = new Owner()
    await connect(owner)
    await expect(simulatorAgentBackend.install('ios:ID', 'relativo.app')).rejects.toThrow('absoluto')
    appMetadata.DTPlatformName = 'iphoneos'
    await expect(simulatorAgentBackend.install('ios:ID', '/p/Meu App.app')).rejects.toThrow('iOS Simulator')
    expect(mocks.execFile.mock.calls.some(([,args]) => args.includes('install'))).toBe(false)
    appMetadata.DTPlatformName = 'iphonesimulator'
    expect(await simulatorAgentBackend.install('ios:ID', '/p/Meu App.app')).toEqual({ installed: true, appId: 'com.exemplo.app' })
    expect(mocks.execFile.mock.calls.some(([file,args]) => file === '/usr/bin/xcrun' && JSON.stringify(args) === JSON.stringify(['simctl', 'install', 'ID', '/p/Meu App.app']))).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })
  it('reaproveita o painel e serializa gestos de agentes para não misturar toques', async () => {
    const owner = new Owner()
    await connect(owner)
    const sent: string[] = []
    child.stdin.on('data', (b) => sent.push(b.toString()))
    const a = simulatorAgentBackend.action('ios:ID', { type: 'tap', x: 0.2, y: 0.3 })
    const b = simulatorAgentBackend.action('ios:ID', { type: 'tap', x: 0.7, y: 0.8 })
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all([a,b])
    expect(sent.map((s) => JSON.parse(s).phase)).toEqual(['down', 'up', 'down', 'up'])
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })
  it('encerra a captura temporária de um agente depois de ficar ociosa', async () => {
    const pending = simulatorAgentBackend.start('ios:ID')
    await vi.advanceTimersByTimeAsync(1200)
    child.stdout.write('{"type":"frame","image":"data:image/png;base64,AA==","width":720,"height":1560}\n')
    expect(await pending).toMatchObject({ id: 'ios:ID', running: true })
    expect(connectedSimulators()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(connectedSimulators()).toEqual([])
    expect(child.stdin.writableEnded).toBe(true)
  })
  it('preserva a posição da tela dentro da captura do aparelho inteiro', async () => {
    const owner = new Owner()
    const pending = connectSimulator(owner as unknown as WebContents, 'ios:ID')
    await vi.advanceTimersByTimeAsync(1200)
    const touchArea = { x: 0.06, y: 0.03, width: 0.88, height: 0.95 }
    child.stdout.write(JSON.stringify({ type: 'frame', image: 'data:image/png;base64,AA==', width: 818, height: 1652, touchArea }) + '\n')
    await pending
    expect(owner.send).toHaveBeenCalledWith('simulator:frame', { deviceId: 'ios:ID', image: 'data:image/png;base64,AA==', width: 818, height: 1652, touchArea })
  })
  it('encaminha a tela apenas para a janela solicitante e para ao desconectar', async () => {
    const owner = new Owner()
    await connect(owner)
    expect(owner.send).toHaveBeenCalledWith('simulator:frame', { deviceId: 'ios:ID', image: 'data:image/jpeg;base64,AA==', width: 720, height: 1560 })
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['/Applications/Xcode.app/Contents/Developer', 'ID', 'iPhone', 'iOS 26.5'])
    disconnectSimulator(owner.id)
    owner.send.mockClear()
    child.stdout.write('{"type":"frame","image":"data:image/jpeg;base64,BB==","width":720,"height":1560}\n')
    expect(owner.send).not.toHaveBeenCalled()
    expect(child.stdin.writableEnded).toBe(true)
    expect(owner.listenerCount('destroyed')).toBe(0)
  })
  it('rejeita um aparelho que não está no catálogo sem executar comandos de inicialização', async () => {
    const owner = new Owner()
    await expect(connectSimulator(owner as unknown as WebContents, 'ios:inventado;rm -rf /')).rejects.toThrow('não está mais disponível')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.execFile.mock.calls.some(([,args]) => args.includes('boot'))).toBe(false)
  })
  it('cancela a descoberta quando o painel é fechado antes da lista chegar', async () => {
    let finish: ((...args: unknown[]) => void) | undefined
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, cb) => { finish = cb; return new EventEmitter() })
    const owner = new Owner()
    const pending = connectSimulator(owner as unknown as WebContents, 'ios:ID')
    const outcome = expect(pending).rejects.toThrow('cancelada')
    disconnectSimulator(owner.id)
    finish!(null, Buffer.from(JSON.stringify(ios)), Buffer.alloc(0))
    await outcome
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('valida a entrada antes de encaminhar e desconecta junto com a janela', async () => {
    const owner = new Owner()
    await connect(owner)
    const sent: string[] = []
    child.stdin.on('data', (b) => sent.push(b.toString()))
    await simulatorInput(owner.id, { type: 'touch', phase: 'down', x: NaN, y: 0.3 })
    expect(sent).toEqual([])
    await simulatorInput(owner.id, { type: 'touch', phase: 'down', x: 0.2, y: 0.3 })
    expect(JSON.parse(sent[0])).toEqual({ type: 'touch', phase: 'down', x: 0.2, y: 0.3 })
    owner.emit('destroyed')
    await simulatorInput(owner.id, { type: 'home' })
    expect(sent).toHaveLength(1)
    expect(child.stdin.writableEnded).toBe(true)
  })
  it('encerra a conexão pendente se o painel fecha antes do primeiro quadro', async () => {
    const owner = new Owner()
    const pending = connectSimulator(owner as unknown as WebContents, 'ios:ID')
    const outcome = expect(pending).rejects.toThrow('cancelada')
    await vi.advanceTimersByTimeAsync(1200)
    disconnectSimulator(owner.id)
    child.emit('exit', 0)
    await outcome
    expect(owner.send).not.toHaveBeenCalled()
  })
  it('apresenta erros do componente nativo e encerra a captura que não iniciou', async () => {
    const owner = new Owner()
    const pending = connectSimulator(owner as unknown as WebContents, 'ios:ID')
    const outcome = expect(pending).rejects.toThrow('Permita Gravação da Tela')
    await vi.advanceTimersByTimeAsync(1200)
    child.stdout.write('{"type":"error","message":"Permita Gravação da Tela"}\n')
    await outcome
    expect(child.stdin.writableEnded).toBe(true)
  })
})
