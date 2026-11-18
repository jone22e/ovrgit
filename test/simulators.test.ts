import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/ovseer' }, ipcMain: { handle: vi.fn() } }))
vi.mock('node:child_process', () => mocks)
vi.mock('node:fs', () => ({ existsSync: () => true, promises: { readdir: async () => [] } }))
vi.mock('../src/main/proto/emulator.proto?asset', () => ({ default: '/emulator.proto' }))
import { connectSimulator, disconnectSimulator, shutdownSimulators, simulatorInput } from '../src/main/simulators'

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
const ios = { runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iOS 26.5' }], devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'ID', name: 'iPhone', isAvailable: true, state: 'Booted' }] } }

beforeEach(() => {
  vi.useFakeTimers()
  child = new Child()
  mocks.spawn.mockReset().mockReturnValue(child)
  mocks.execFile.mockReset().mockImplementation((_file, args: string[], _options, cb) => {
    const value = args.includes('--json') ? JSON.stringify(ios) : args.includes('-p') ? '/Applications/Xcode.app/Contents/Developer' : args.includes('devices') ? 'List of devices attached\n' : ''
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
