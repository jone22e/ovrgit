import { app, ipcMain } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import * as grpc from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'
import emulatorProto from './proto/emulator.proto?asset'
import { macSimulatorKeyCode, parseAvds, parseIosDevices, simulatorTextKeys, validSimulatorAction, validSimulatorInput, type SimulatorAction, type SimulatorCatalog, type SimulatorDevice, type SimulatorFrame, type SimulatorInput, type SimulatorTouchArea } from '../shared/simulator'

function run(file: string, args: string[], timeout = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr?.toString().trim() || err.message))
    else resolve(stdout)
  }))
}
async function text(file: string, args: string[], timeout?: number) { return (await run(file, args, timeout)).toString().trim() }
function sdkTools() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library/Android/sdk'), path.join(os.homedir(), 'Android/Sdk'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk')].filter((s): s is string => !!s)
  for (const root of roots) {
    const suffix = process.platform === 'win32' ? '.exe' : ''
    const adb = path.join(root, 'platform-tools', `adb${suffix}`), emulator = path.join(root, 'emulator', `emulator${suffix}`)
    if (existsSync(adb) && existsSync(emulator)) return { adb, emulator }
  }
  return null
}
export async function simulatorCatalog(): Promise<SimulatorCatalog> {
  const result: SimulatorCatalog = { devices: [], issues: {} }
  if (process.platform === 'darwin') {
    try { result.devices.push(...parseIosDevices(JSON.parse(await text('/usr/bin/xcrun', ['simctl', 'list', '--json'])))) }
    catch { result.issues.ios = 'Instale o Xcode, selecione-o com xcode-select e adicione um simulador iOS.' }
  } else result.issues.ios = 'Os simuladores iOS precisam do Xcode no macOS.'
  const sdk = sdkTools()
  if (sdk) {
    try {
      const devices = parseAvds(await text(sdk.emulator, ['-list-avds']))
      const running = await runningAndroids(sdk.adb)
      for (const device of devices) device.running = running.has(device.id.slice(8))
      result.devices.push(...devices)
    } catch { result.issues.android = 'Não foi possível listar os aparelhos do Android SDK.' }
  } else result.issues.android = 'Instale o Android SDK com Emulator e Platform Tools e crie um aparelho no Android Studio.'
  return result
}
async function runningAndroids(adb: string): Promise<Map<string, string>> {
  const devices = await text(adb, ['devices'])
  const result = new Map<string, string>()
  for (const match of devices.matchAll(/^(emulator-\d+)\s+device\s*$/gm)) {
    const name = (await text(adb, ['-s', match[1], 'emu', 'avd', 'name'])).split(/\r?\n/)[0]
    result.set(name, match[1])
  }
  return result
}
interface AndroidImage { format?: { width: number; height: number }; width: number; height: number; image: Buffer }
interface EmulatorRpc extends grpc.Client {
  streamScreenshot(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<AndroidImage>
  sendTouch(request: object, metadata: grpc.Metadata, callback: (error: Error | null) => void): grpc.ClientUnaryCall
  sendKey(request: object, metadata: grpc.Metadata, callback: (error: Error | null) => void): grpc.ClientUnaryCall
}
interface AndroidConnection { client: EmulatorRpc; metadata: grpc.Metadata; serial: string; process?: ChildProcess }
const androids = new Map<string, AndroidConnection>()
const startingAndroids = new Map<string, Promise<AndroidConnection>>()
const androidLaunches = new Set<ChildProcess>()
interface SimulatorOwner {
  id: number
  isDestroyed(): boolean
  isCrashed(): boolean
  send(channel: string, value: unknown): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}
interface Session {
  owner: SimulatorOwner
  device: SimulatorDevice
  stopped: boolean
  child?: ChildProcess
  stream?: grpc.ClientReadableStream<AndroidImage>
  timer?: ReturnType<typeof setTimeout>
  android?: AndroidConnection
  adb?: string
  serial?: string
  width: number
  height: number
  nativeWidth?: number
  nativeHeight?: number
  onDestroyed?: () => void
  lastTouch?: Extract<SimulatorInput, { type: 'touch' }>
  gesture?: { x: number; y: number; at: number }
  inputQueue: Promise<void>
}
const sessions = new Map<number, Session>()
function send(session: Session, channel: string, value: unknown) {
  if (!session.stopped && !session.owner.isDestroyed() && !session.owner.isCrashed()) session.owner.send(channel, value)
}
function frame(session: Session, image: string, width: number, height: number, touchArea?: SimulatorTouchArea) {
  if (!width || !height || !image) return
  session.width = width; session.height = height
  send(session, 'simulator:frame', { deviceId: session.device.id, image, width, height, ...(touchArea ? { touchArea } : {}) } satisfies SimulatorFrame)
}
function errorMessage(error: unknown) {
  // O servidor gRPC pode incluir o token recebido no texto de uma falha de autenticação.
  if (error && typeof error === 'object' && 'code' in error && error.code === grpc.status.UNAUTHENTICATED) return 'O Android recusou a autenticação local. Reconecte o aparelho.'
  return error instanceof Error ? error.message.replace(/Bearer\s+[^\s`]+/g, 'Bearer [oculto]') : String(error)
}
const shellArgument = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
function touchSize(session: Session) {
  if (!session.nativeWidth || !session.nativeHeight) return { width: session.width, height: session.height }
  const [small, large] = [session.nativeWidth, session.nativeHeight].sort((a,b) => a-b)
  return session.width > session.height ? { width: large, height: small } : { width: small, height: large }
}
export function disconnectSimulator(ownerId: number) {
  for (const [id, client] of agentClients) if (client.owner.id === ownerId) { clearTimeout(client.timer); agentClients.delete(id) }
  const session = sessions.get(ownerId)
  if (!session) return
  session.stopped = true
  sessions.delete(ownerId)
  clearTimeout(session.timer)
  if (session.onDestroyed) session.owner.removeListener('destroyed', session.onDestroyed)
  if (session.android && session.lastTouch) {
    const c = session.android
    c.client.sendTouch({ touches: [{ identifier: 0, x: Math.round(session.lastTouch.x * (touchSize(session).width - 1)), y: Math.round(session.lastTouch.y * (touchSize(session).height - 1)), pressure: 0 }] }, c.metadata, () => undefined)
  }
  session.stream?.cancel()
  const child = session.child
  if (child) {
    child.stdin?.end()
    const timer = setTimeout(() => child.kill(), 1500)
    child.once('exit', () => clearTimeout(timer))
  }
}
async function checkSession(session: Session) {
  if (session.stopped || session.owner.isDestroyed()) throw new Error('Conexão do simulador cancelada.')
}
async function connectIos(session: Session) {
  const binary = app.isPackaged ? path.join(process.resourcesPath, 'native/ovseer-simulator') : path.join(app.getAppPath(), 'dist-native/darwin/ovseer-simulator')
  if (!existsSync(binary)) throw new Error('O componente nativo dos simuladores não está instalado. Execute npm run build:native em desenvolvimento.')
  const udid = session.device.id.slice(4)
  if (!session.device.running) await text('/usr/bin/xcrun', ['simctl', 'boot', udid], 60_000)
  await checkSession(session)
  await text('/usr/bin/xcrun', ['simctl', 'bootstatus', udid, '-b'], 180_000)
  const developer = await text('/usr/bin/xcode-select', ['-p'])
  await checkSession(session)
  await text('/usr/bin/open', ['-g', '-a', path.join(developer, 'Applications/Simulator.app'), '--args', '-CurrentDeviceUDID', udid])
  await new Promise((resolve) => setTimeout(resolve, 1200))
  await checkSession(session)
  const child = spawn(binary, [developer, udid, session.device.name, session.device.runtime], { stdio: ['pipe', 'pipe', 'pipe'] })
  session.child = child
  child.stdin?.on('error', () => undefined)
  let stderr = ''
  child.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000) })
  await new Promise<void>((resolve, reject) => {
    let received = false, settled = false
    const timeout = setTimeout(() => { settled = true; reject(new Error('O Simulator não enviou a tela. Verifique as permissões de Gravação da Tela e Acessibilidade do Ovseer.')) }, 20_000)
    const problem = (message: string) => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(session.stopped ? 'Conexão do simulador cancelada.' : message)) }
      else send(session, 'simulator:error', { deviceId: session.device.id, message })
    }
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const event = JSON.parse(line)
        if (event.type === 'error') problem(String(event.message))
        else if (event.type === 'frame') {
          received = true
          frame(session, event.image, event.width, event.height, event.touchArea)
          if (!settled) { settled = true; clearTimeout(timeout); resolve() }
        }
      } catch { /* saída incompleta não pode derrubar o app */ }
    })
    child.once('error', (e) => problem(e.message))
    child.once('exit', () => { clearTimeout(timeout); problem(received ? 'O Simulator desconectou. Reconecte o aparelho.' : stderr || 'O componente do Simulator encerrou antes de enviar a tela.') })
  })
}
function freePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close((err) => err ? reject(err) : resolve(port))
    })
  })
}
async function emulatorPort() {
  for (let p = 5554; p < 5680; p += 2) {
    try { await freePort(p); await freePort(p + 1); return p } catch { /* próximo par */ }
  }
  throw new Error('Não há uma porta disponível para o Android Emulator.')
}
function androidClient(port: number, token: string, serial: string): AndroidConnection {
  const definition = grpc.loadPackageDefinition(loadSync(emulatorProto, { defaults: true, bytes: Buffer })) as unknown as { android: { emulation: { control: { EmulatorController: new (address: string, credentials: grpc.ChannelCredentials, options: object) => EmulatorRpc } } } }
  const client = new definition.android.emulation.control.EmulatorController(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), { 'grpc.max_receive_message_length': 32 * 1024 * 1024 })
  const metadata = new grpc.Metadata()
  metadata.set('authorization', `Bearer ${token}`)
  return { client, metadata, serial }
}
async function discoverAndroid(name: string, serial: string, expectedPort?: number): Promise<AndroidConnection | null> {
  const dirs = [path.join(os.homedir(), 'Library/Caches/TemporaryItems/avd/running'), path.join(os.homedir(), '.android/avd/running'), path.join(os.tmpdir(), 'avd/running'), process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'avd/running')].filter((d): d is string => !!d)
  for (const dir of dirs) {
    for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
      const match = /^pid_(\d+)\.ini$/.exec(file)
      if (!match) continue
      try {
        process.kill(Number(match[1]), 0)
        const ini = await fs.readFile(path.join(dir, file), 'utf8')
        const values = Object.fromEntries(ini.split(/\r?\n/).map((line) => { const index = line.indexOf('='); return index < 0 ? ['', ''] : [line.slice(0,index).trim(), line.slice(index+1).trim()] }))
        const port = Number(values['grpc.port'])
        if (values['avd.id'] !== name || `emulator-${values['port.serial']}` !== serial || !Number.isInteger(port) || port < 1 || port > 65535 || expectedPort !== undefined && port !== expectedPort || !values['grpc.token']) continue
        return androidClient(port, values['grpc.token'], serial)
      } catch { /* descriptor de um emulador encerrado ou ainda iniciando */ }
    }
  }
  return null
}
async function startAndroid(name: string, sdk: NonNullable<ReturnType<typeof sdkTools>>): Promise<AndroidConnection> {
  const existing = androids.get(name)
  if (existing) return existing
  const pending = startingAndroids.get(name)
  if (pending) return pending
  const start = (async () => {
    const port = await freePort(), consolePort = await emulatorPort()
    const child = spawn(sdk.emulator, ['-avd', name, '-no-window', '-port', String(consolePort), '-grpc', String(port), '-grpc-use-token'], { detached: true, stdio: 'ignore' })
    androidLaunches.add(child)
    child.once('exit', () => androidLaunches.delete(child))
    let launchError: Error | null = null
    child.on('error', (e) => { launchError = e })
    child.unref()
    let connection: AndroidConnection | null = null
    try {
      const deadline = Date.now() + 90_000
      while (!connection && Date.now() < deadline) {
        if (launchError) throw launchError
        if (child.killed) throw new Error('Inicialização do Android cancelada.')
        if (child.exitCode !== null) throw new Error('O Android Emulator encerrou durante a inicialização.')
        connection = await discoverAndroid(name, `emulator-${consolePort}`, port)
        if (!connection) await new Promise((resolve) => setTimeout(resolve, 400))
      }
      if (!connection) throw new Error('O Android Emulator não disponibilizou a conexão em 90 segundos.')
      const ready = connection
      await new Promise<void>((resolve, reject) => ready.client.waitForReady(Date.now() + 15_000, (e) => e ? reject(new Error('O Android Emulator não respondeu à conexão local.')) : resolve()))
      ready.process = child
      androids.set(name, ready)
      child.once('exit', () => { if (androids.get(name) === ready) androids.delete(name); ready.client.close() })
      return ready
    } catch (e) { connection?.client.close(); child.kill(); throw e }
  })()
  startingAndroids.set(name, start)
  try { return await start } finally { startingAndroids.delete(name) }
}
async function connectAndroid(session: Session) {
  const sdk = sdkTools()
  if (!sdk) throw new Error('Android SDK não encontrado.')
  const name = session.device.id.slice(8)
  session.adb = sdk.adb
  const running = await runningAndroids(sdk.adb)
  await checkSession(session)
  let owned = androids.get(name)
  if (!owned && running.has(name)) {
    owned = (await discoverAndroid(name, running.get(name)!)) ?? undefined
    if (owned) androids.set(name, owned)
  }
  // Aparelhos já abertos por outras ferramentas continuam funcionando via ADB.
  if (running.has(name) && !owned && !startingAndroids.has(name)) {
    session.serial = running.get(name)!
    const capture = async (): Promise<void> => {
      await checkSession(session)
      const png = await run(sdk.adb, ['-s', session.serial!, 'exec-out', 'screencap', '-p'])
      if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('O Android não enviou uma captura válida.')
      frame(session, `data:image/png;base64,${png.toString('base64')}`, png.readUInt32BE(16), png.readUInt32BE(20))
      if (!session.stopped) session.timer = setTimeout(() => void capture().catch((e) => send(session, 'simulator:error', { deviceId: session.device.id, message: errorMessage(e) })), 150)
    }
    await capture()
    return
  }
  session.android = owned ?? await startAndroid(name, sdk)
  session.serial = session.android.serial
  await checkSession(session)
  const connection = session.android
  const size = await text(sdk.adb, ['-s', connection.serial, 'shell', 'wm', 'size']).catch(() => '')
  const sizes = [...size.matchAll(/(?:Physical|Override) size: (\d+)x(\d+)/g)]
  const dimensions = sizes.at(-1)
  if (dimensions) { session.nativeWidth = Number(dimensions[1]); session.nativeHeight = Number(dimensions[2]) }
  await checkSession(session)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error('O Android ainda não enviou a tela. Aguarde a inicialização e reconecte.')) } }, 90_000)
    const stream = connection.client.streamScreenshot({ format: 0, width: dimensions ? 720 : 0, height: dimensions ? 1600 : 0 }, connection.metadata)
    session.stream = stream
    stream.on('data', (image: AndroidImage) => {
      const width = image.format?.width || image.width, height = image.format?.height || image.height
      if (!image.image.length || !width || !height) return
      frame(session, `data:image/png;base64,${image.image.toString('base64')}`, width, height)
      if (!settled) { settled = true; clearTimeout(timeout); resolve() }
    })
    const problem = (message: string) => {
      clearTimeout(timeout)
      if (!settled) { settled = true; reject(new Error(message)) }
      else send(session, 'simulator:error', { deviceId: session.device.id, message })
    }
    let ended = false
    stream.on('error', (e: Error) => { ended = true; problem(errorMessage(e)) })
    stream.on('end', () => { if (!ended) problem('O Android desconectou. Reconecte o aparelho.') })
  })
}
export async function connectSimulator(owner: SimulatorOwner, deviceId: string) {
  disconnectSimulator(owner.id)
  // Reserva antes de listar: fechar/trocar o painel também cancela a descoberta em andamento.
  const session: Session = { owner, device: { id: deviceId } as SimulatorDevice, stopped: false, width: 0, height: 0, inputQueue: Promise.resolve() }
  sessions.set(owner.id, session)
  session.onDestroyed = () => { if (sessions.get(owner.id) === session) disconnectSimulator(owner.id) }
  owner.once('destroyed', session.onDestroyed)
  try {
    const catalog = await simulatorCatalog()
    await checkSession(session)
    const device = catalog.devices.find((d) => d.id === deviceId)
    if (!device) throw new Error('O aparelho selecionado não está mais disponível.')
    session.device = device
    if (device.platform === 'ios') await connectIos(session)
    else await connectAndroid(session)
    await checkSession(session)
  } catch (e) {
    if (sessions.get(owner.id) === session) disconnectSimulator(owner.id)
    throw e
  }
}
export function simulatorInput(ownerId: number, input: unknown): Promise<void> {
  const session = sessions.get(ownerId)
  if (!session || session.stopped || !validSimulatorInput(input)) return Promise.resolve()
  const next = session.inputQueue.then(async () => {
    if (session.stopped) return
    if (session.device.platform === 'ios') { session.child?.stdin?.write(`${JSON.stringify(input)}\n`); return }
    if (input.type === 'touch') {
      if (input.phase !== 'up') session.lastTouch = input
      else session.lastTouch = undefined
      const x = Math.round(input.x * (touchSize(session).width - 1)), y = Math.round(input.y * (touchSize(session).height - 1))
      if (session.android) {
        const c = session.android
        await new Promise<void>((resolve, reject) => c.client.sendTouch({ touches: [{ identifier: 0, x, y, pressure: input.phase === 'up' ? 0 : 1 }] }, c.metadata, (e) => e ? reject(e) : resolve()))
      } else if (input.phase === 'down') session.gesture = { x, y, at: Date.now() }
      else if (input.phase === 'up' && session.gesture) {
        const start = session.gesture; session.gesture = undefined
        const distance = Math.hypot(x - start.x, y - start.y)
        await text(session.adb!, ['-s', session.serial!, 'shell', 'input', ...(distance < 8 ? ['tap', String(x), String(y)] : ['swipe', String(start.x), String(start.y), String(x), String(y), String(Math.min(2000, Math.max(80, Date.now() - start.at)))])])
      }
    } else if (session.android) {
      const c = session.android
      const key = input.type === 'home' ? 'GoHome' : input.type === 'back' ? 'GoBack' : input.key
      await new Promise<void>((resolve, reject) => c.client.sendKey({ key, eventType: 2 }, c.metadata, (e) => e ? reject(e) : resolve()))
    } else {
      const keys: Record<string, string> = { Enter: 'KEYCODE_ENTER', Backspace: 'KEYCODE_DEL', Escape: 'KEYCODE_BACK', Tab: 'KEYCODE_TAB', ArrowLeft: 'KEYCODE_DPAD_LEFT', ArrowRight: 'KEYCODE_DPAD_RIGHT', ArrowUp: 'KEYCODE_DPAD_UP', ArrowDown: 'KEYCODE_DPAD_DOWN' }
      const key = input.type === 'home' ? 'KEYCODE_HOME' : input.type === 'back' ? 'KEYCODE_BACK' : keys[input.key]
      if (key) await text(session.adb!, ['-s', session.serial!, 'shell', 'input', 'keyevent', key])
      else if (input.type === 'key' && /^[\x20-\x7e]$/.test(input.key)) await text(session.adb!, ['-s', session.serial!, 'shell', 'input', 'text', shellArgument(input.key === ' ' ? '%s' : input.key)])
    }
  })
  session.inputQueue = next.catch(() => undefined)
  return next
}
export async function stopSimulator(deviceId: string) {
  const device = (await simulatorCatalog()).devices.find((d) => d.id === deviceId)
  if (!device) throw new Error('O aparelho selecionado não está mais disponível.')
  for (const [id, session] of sessions) {
    if (session.device.id !== deviceId) continue
    send(session, 'simulator:error', { deviceId, message: 'O aparelho foi desligado.' })
    disconnectSimulator(id)
  }
  if (device.platform === 'ios') {
    if (device.running) await text('/usr/bin/xcrun', ['simctl', 'shutdown', device.id.slice(4)], 30_000)
  } else {
    const sdk = sdkTools()
    if (!sdk) throw new Error('Android SDK não encontrado.')
    const name = device.id.slice(8)
    const serial = (await runningAndroids(sdk.adb)).get(name)
    if (serial) await text(sdk.adb, ['-s', serial, 'emu', 'kill'])
    androids.get(name)?.client.close()
    androids.delete(name)
  }
}

// A API reutiliza o painel aberto. Sem painel, a conexão temporária tem o mesmo controle nativo.
class AgentSimulatorOwner extends EventEmitter implements SimulatorOwner {
  constructor(readonly id: number) { super() }
  isDestroyed() { return false }
  isCrashed() { return false }
  send() { /* a API lê a tela original por screenshot, sem enviar frames a um renderer */ }
}
let nextAgentOwner = -1
const agentClients = new Map<string, { owner: AgentSimulatorOwner; timer: ReturnType<typeof setTimeout> }>()
const agentConnecting = new Map<string, Promise<number>>()
export function connectedSimulators(): SimulatorDevice[] {
  return [...new Map([...sessions.values()].filter((s) => !s.stopped && s.width > 0).map((s) => [s.device.id, { ...s.device, running: true }])).values()]
}
async function requireDevice(id: string): Promise<SimulatorDevice> {
  const device = (await simulatorCatalog()).devices.find((d) => d.id === id)
  if (!device) throw new Error('Aparelho não encontrado. Consulte GET /simulators e use um id retornado.')
  return device
}
async function agentCapture(id: string): Promise<number> {
  const panel = [...sessions.values()].find((s) => s.device.id === id && !s.stopped && s.owner.id >= 0 && s.width > 0)
  if (panel) {
    const previous = agentClients.get(id)
    if (previous) disconnectSimulator(previous.owner.id)
    return panel.owner.id
  }
  const pending = agentConnecting.get(id)
  if (pending) return pending
  const existing = agentClients.get(id)
  if (existing && sessions.has(existing.owner.id)) {
    clearTimeout(existing.timer)
    existing.timer = setTimeout(() => disconnectSimulator(existing.owner.id), 120_000).unref()
    return existing.owner.id
  }
  const connecting = (async () => {
    const owner = new AgentSimulatorOwner(nextAgentOwner--)
    await connectSimulator(owner, id)
    agentClients.set(id, { owner, timer: setTimeout(() => disconnectSimulator(owner.id), 120_000).unref() })
    return owner.id
  })()
  agentConnecting.set(id, connecting)
  try { return await connecting } finally { agentConnecting.delete(id) }
}
async function androidTarget(device: SimulatorDevice) {
  const sdk = sdkTools()
  if (!sdk) throw new Error('Android SDK não encontrado.')
  const name = device.id.slice(8)
  const serial = androids.get(name)?.serial ?? (await runningAndroids(sdk.adb)).get(name)
  if (!serial) throw new Error('O aparelho Android não está ligado. Use POST /{id}/start.')
  return { ...sdk, serial }
}
async function readyAndroid(device: SimulatorDevice) {
  const target = await androidTarget(device)
  await text(target.adb, ['-s', target.serial, 'wait-for-device'], 90_000)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if ((await text(target.adb, ['-s', target.serial, 'shell', 'getprop', 'sys.boot_completed'])).trim() === '1') return target
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('O Android ainda não concluiu a inicialização.')
}
const appIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value)
/** O serial Android vem do ADB, nunca do nome do AVD. */
export async function simulatorDebugTarget(id: string) {
  const device = await requireDevice(id)
  await agentCapture(id)
  return { device, target: device.platform === 'ios' ? device.id.slice(4) : (await readyAndroid(device)).serial }
}
async function agentAction(id: string, action: SimulatorAction) {
  if (!validSimulatorAction(action)) throw new Error('Ação inválida. Use coordenadas de 0 a 1 e texto ASCII de até 1000 caracteres.')
  const ownerId = await agentCapture(id)
  const device = sessions.get(ownerId)!.device
  if (action.type === 'tap') {
    await simulatorInput(ownerId, { type: 'touch', phase: 'down', x: action.x, y: action.y })
    try { await new Promise((resolve) => setTimeout(resolve, 60)) }
    finally { await simulatorInput(ownerId, { type: 'touch', phase: 'up', x: action.x, y: action.y }) }
  } else if (action.type === 'swipe') {
    const duration = action.durationMs ?? 400
    let x = action.x, y = action.y
    await simulatorInput(ownerId, { type: 'touch', phase: 'down', x, y })
    try {
      for (let n = 1; n <= 12; n++) {
        await new Promise((resolve) => setTimeout(resolve, duration / 12))
        x = action.x + (action.toX - action.x) * n / 12
        y = action.y + (action.toY - action.y) * n / 12
        await simulatorInput(ownerId, { type: 'touch', phase: 'move', x, y })
      }
    } finally { await simulatorInput(ownerId, { type: 'touch', phase: 'up', x, y }) }
  } else if (action.type === 'text') {
    for (const key of simulatorTextKeys(action.text)) {
      await simulatorInput(ownerId, key)
      if (device.platform === 'ios') await new Promise((resolve) => setTimeout(resolve, 5))
    }
  } else {
    if (action.type === 'back' && device.platform === 'ios') throw new Error('iOS não possui botão Voltar universal. Capture a tela e toque no botão do app.')
    if (action.type === 'key' && device.platform === 'ios' && action.code === undefined) {
      const key = action.key.length === 1 ? simulatorTextKeys(action.key)[0] : { ...action, code: macSimulatorKeyCode(action.key) }
      if (key.code === undefined) throw new Error('Tecla iOS sem código físico reconhecido.')
      await simulatorInput(ownerId, key)
    } else await simulatorInput(ownerId, action)
  }
}
const agentActions = new Map<string, Promise<void>>()
async function queuedAgentAction(id: string, action: SimulatorAction) {
  const next = (agentActions.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => agentAction(id, action))
  agentActions.set(id, next)
  try { await next } finally { if (agentActions.get(id) === next) agentActions.delete(id) }
}

/** Operações locais para agentes, com o mesmo catálogo e controles usados pelo painel. */
export const simulatorAgentBackend = {
  async list() { return { ...await simulatorCatalog(), connected: connectedSimulators().map((d) => d.id) } },
  async start(id: string) { const ownerId = await agentCapture(id); return { ...sessions.get(ownerId)!.device, running: true } },
  stop: stopSimulator,
  action: queuedAgentAction,
  async screenshot(id: string) {
    const device = await requireDevice(id)
    if (!device.running) throw new Error('Aparelho desligado. Use POST /{id}/start.')
    if (device.platform === 'ios') {
      // Alguns Xcodes tratam "-" como nome de arquivo, apesar da ajuda anunciar stdout.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ovseer-simulator-'))
      try {
        const file = path.join(dir, 'screen.png')
        await run('/usr/bin/xcrun', ['simctl', 'io', id.slice(4), 'screenshot', '--type=png', file])
        return await fs.readFile(file)
      } finally { await fs.rm(dir, { recursive: true, force: true }) }
    }
    const target = await androidTarget(device)
    return run(target.adb, ['-s', target.serial, 'exec-out', 'screencap', '-p'])
  },
  async install(id: string, inputPath: string) {
    if (!path.isAbsolute(inputPath)) throw new Error('O caminho do app deve ser absoluto.')
    const artifact = await fs.realpath(inputPath)
    const device = await requireDevice(id)
    const stat = await fs.stat(artifact)
    if (device.platform === 'ios') {
      if (!artifact.toLowerCase().endsWith('.app') || !stat.isDirectory()) throw new Error('iOS exige um diretório .app compilado para iOS Simulator.')
      const info = JSON.parse(await text('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(artifact, 'Info.plist')])) as { CFBundleIdentifier?: string; DTPlatformName?: string; CFBundleSupportedPlatforms?: string[] }
      if (info.DTPlatformName !== 'iphonesimulator' && !info.CFBundleSupportedPlatforms?.includes('iPhoneSimulator')) throw new Error('O .app não é uma compilação para iOS Simulator.')
      if (!appIdentifier(info.CFBundleIdentifier)) throw new Error('CFBundleIdentifier inválido no Info.plist.')
      await agentCapture(id)
      await text('/usr/bin/xcrun', ['simctl', 'install', id.slice(4), artifact], 120_000)
      return { installed: true, appId: info.CFBundleIdentifier }
    }
    if (!artifact.toLowerCase().endsWith('.apk') || !stat.isFile()) throw new Error('Android exige um arquivo .apk.')
    await agentCapture(id)
    const target = await readyAndroid(device)
    await text(target.adb, ['-s', target.serial, 'install', '-r', artifact], 120_000)
    return { installed: true }
  },
  async launch(id: string, appId: string) {
    if (!appIdentifier(appId)) throw new Error('appId inválido. Use o identificador confirmado no projeto ou na instalação.')
    await agentCapture(id)
    const device = await requireDevice(id)
    if (device.platform === 'ios') await text('/usr/bin/xcrun', ['simctl', 'launch', id.slice(4), appId], 60_000)
    else {
      const target = await readyAndroid(device)
      const component = (await text(target.adb, ['-s', target.serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', appId])).split(/\r?\n/).find((s) => /^[\w.]+\/[\w.]+$/.test(s.trim()))?.trim()
      if (!component) throw new Error('Não foi encontrada uma atividade inicial para este appId.')
      const result = await text(target.adb, ['-s', target.serial, 'shell', 'am', 'start', '-W', '-n', component], 60_000)
      if (/Error:|Exception/.test(result)) throw new Error(result)
    }
    return { launched: true, appId }
  },
  async openUrl(id: string, value: string) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('URL inválida.')
    const url = new URL(value)
    if (['file:', 'data:', 'javascript:', 'intent:'].includes(url.protocol)) throw new Error('Protocolo de URL não permitido.')
    await agentCapture(id)
    const device = await requireDevice(id)
    if (device.platform === 'ios') await text('/usr/bin/xcrun', ['simctl', 'openurl', id.slice(4), value])
    else {
      const target = await readyAndroid(device)
      const quoted = shellArgument(value)
      const result = await text(target.adb, ['-s', target.serial, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', quoted])
      if (/Error:|Exception/.test(result)) throw new Error(result)
    }
    return { opened: true }
  }
}
export function registerSimulators() {
  ipcMain.handle('simulator:list', () => simulatorCatalog())
  ipcMain.handle('simulator:connect', (event, id: unknown) => {
    if (typeof id !== 'string' || id.length > 200) throw new Error('Aparelho inválido.')
    return connectSimulator(event.sender, id)
  })
  ipcMain.handle('simulator:stop', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length > 200) throw new Error('Aparelho inválido.')
    return stopSimulator(id)
  })
  ipcMain.handle('simulator:disconnect', (event) => disconnectSimulator(event.sender.id))
  ipcMain.handle('simulator:input', (event, input: unknown) => simulatorInput(event.sender.id, input))
}
export function shutdownSimulators() {
  for (const id of sessions.keys()) disconnectSimulator(id)
  for (const { client, process: child } of androids.values()) { client.close(); child?.kill() }
  androids.clear()
  for (const child of androidLaunches) child.kill()
  androidLaunches.clear()
}
