import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ projects: vi.fn(), catalog: vi.fn(), sdkRoots: vi.fn(), execFile: vi.fn(), shell: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../src/main/simulatorDebug', () => ({ simulatorDebugProjects: mocks.projects, debugCommand: (args: string[]) => args.map((s) => JSON.stringify(s)).join(' ') }))
vi.mock('../src/main/simulators', () => ({ simulatorCatalog: mocks.catalog, androidSdkRoots: mocks.sdkRoots }))
vi.mock('../src/main/services', () => ({ shellFor: mocks.shell }))
import { androidDeclaredVersion, checkSimulatorEnvironment } from '../src/main/simulatorEnvironment'

let root: string
let sdk: string
let developer: string
let unavailable: Set<string>
let configuredSdk: string | undefined
async function file(relative: string, content = '') {
  const full = path.join(root, relative)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}
beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ovseer-environment-')))
  sdk = path.join(root, 'sdk')
  developer = path.join(root, 'Xcode.app/Contents/Developer')
  configuredSdk = sdk
  unavailable = new Set()
  await file('package.json', '{"dependencies":{"react-native":"0.84.1"}}')
  await file('node_modules/react-native/cli.js')
  await fs.mkdir(path.join(developer, 'Applications/Simulator.app'), { recursive: true })
  for (const artifact of ['platform-tools/adb', 'emulator/emulator', 'platforms/android-36/android.jar', 'build-tools/36.0.0/aapt2', 'ndk/27.1.12297006/source.properties']) await file(`sdk/${artifact}`)
  await file('android/build.gradle', 'buildscript {\n ext {\n compileSdkVersion = 36\n buildToolsVersion = "36.0.0"\n ndkVersion = "27.1.12297006"\n }\n}')
  await file('android/gradle/wrapper/gradle-wrapper.jar')
  await file('android/gradlew')
  mocks.projects.mockResolvedValue([{ root, name: 'App da conversa', kind: 'react-native', platforms: ['ios', 'android'] }])
  mocks.catalog.mockResolvedValue({ devices: [
    { id: 'ios:ID', name: 'iPhone', platform: 'ios', runtime: 'iOS 26.5', running: false },
    { id: 'android:Pixel', name: 'Pixel', platform: 'android', runtime: 'Android', running: false }
  ], issues: {} })
  mocks.sdkRoots.mockReturnValue([sdk])
  mocks.shell.mockImplementation((command) => ({ file: 'shell-do-play', args: [command] }))
  mocks.execFile.mockImplementation((_file, [command]: string[], _options, callback) => {
    const key = command.includes('OVSEER_NODE=') ? 'node' : command.includes('xcode-select') ? 'xcode-select'
      : command.includes('checkFirstLaunchStatus') ? 'xcode-setup' : command.includes('xcodebuild') ? 'xcode'
      : command.includes('xcrun') ? 'sdk' : command.includes('pod') ? command.includes('bundle') ? 'bundle-pod' : 'pod' : command.includes('javac') ? 'javac'
      : command.includes('java') ? 'java' : command.includes('adb') ? 'adb' : 'emulator'
    const outputs: Record<string, string> = {
      node: `aviso do shell\nOVSEER_NODE=${JSON.stringify({ version: 'v26.13.0', androidHome: configuredSdk })}`,
      'xcode-select': developer, xcode: 'Xcode 26.5\nBuild version 17F42', 'xcode-setup': '', sdk: '26.5', pod: '1.16.2', 'bundle-pod': '1.15.2',
      java: 'openjdk version "17.0.10"', javac: 'javac 17.0.10', adb: 'Android Debug Bridge version 1.0.41', emulator: 'Android emulator version 36.5.0'
    }
    callback(unavailable.has(key) ? new Error('Não encontrado') : null, outputs[key] ?? '', '')
  })
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('checagem do ambiente do simulador', () => {
  it.skipIf(process.platform !== 'darwin')('verifica iOS no shell do Play sem ligar aparelhos, compilar ou instalar', async () => {
    const report = await checkSimulatorEnvironment([root], 'ios', 'ios:ID')
    expect(report.checks.filter((c) => c.status !== 'ok')).toEqual([])
    expect(report.checks.find((c) => c.id === 'device')?.detail).toContain('disponível para iniciar')
    expect(mocks.projects).toHaveBeenCalledWith([root])
    for (const [file, args, options] of mocks.execFile.mock.calls) {
      expect(file).toBe('shell-do-play')
      expect(options.cwd).toBe(root)
      expect(args[0]).not.toMatch(/simctl.*boot|run-ios|pod.*install|brew|runFirstLaunch|license.*accept/)
    }
  })

  it.skipIf(process.platform !== 'darwin')('mostra Xcode, CocoaPods e dependências ausentes individualmente', async () => {
    unavailable = new Set(['xcode', 'xcode-setup', 'pod'])
    await file('package.json', '{"dependencies":{"react-native":"0.84.1","pacote-ausente":"1"}}')
    const report = await checkSimulatorEnvironment([root], 'ios', 'ios:ID')
    for (const id of ['xcode', 'xcode-setup', 'cocoapods', 'dependencies']) expect(report.checks.find((c) => c.id === id)?.status).toBe('missing')
    expect(report.checks.find((c) => c.id === 'dependencies')?.detail).toContain('pacote-ausente')
    expect(report.checks.find((c) => c.id === 'cocoapods')?.fix).toContain('PATH')
  })

  it.skipIf(process.platform !== 'darwin')('detecta Pods fora de sincronia com o lock do projeto', async () => {
    await file('ios/Podfile', "target 'App' do\nend")
    await file('ios/Podfile.lock', 'PODS: versao-nova')
    await file('ios/Pods/Manifest.lock', 'PODS: versao-antiga')
    const report = await checkSimulatorEnvironment([root], 'ios', 'ios:ID')
    expect(report.checks.find((c) => c.id === 'pods')?.status).toBe('warning')
  })

  it.skipIf(process.platform !== 'darwin')('reconhece CocoaPods instalado pelo Bundler sem exigir pod global', async () => {
    unavailable.add('pod')
    await file('Gemfile', "gem 'cocoapods', '>= 1.13'")
    const report = await checkSimulatorEnvironment([root], 'ios', 'ios:ID')
    expect(report.checks.find((c) => c.id === 'cocoapods')).toMatchObject({ status: 'ok', detail: '1.15.2 · Bundler do projeto' })
    expect(mocks.shell.mock.calls.some(([command]) => command.includes('"bundle" "exec" "pod" "--version"'))).toBe(true)
  })

  it('verifica SDK, ferramentas, JDK e as versões declaradas pelo Gradle', async () => {
    const report = await checkSimulatorEnvironment([root], 'android', 'android:Pixel')
    expect(report.checks.filter((c) => c.status !== 'ok')).toEqual([])
    expect(report.checks.find((c) => c.id === 'platforms')?.detail).toBe('android-36 instalado.')
    expect(report.checks.find((c) => c.id === 'ndk')?.detail).toBe('27.1.12297006 instalado.')
    expect(report.checks.some((c) => c.id === 'xcode')).toBe(false)
  })

  it('não confunde outra plataforma instalada com a versão exigida pelo app', async () => {
    await fs.rm(path.join(sdk, 'platforms/android-36'), { recursive: true })
    await file('sdk/platforms/android-35/android.jar')
    const report = await checkSimulatorEnvironment([root], 'android', 'android:Pixel')
    expect(report.checks.find((c) => c.id === 'platforms')).toMatchObject({ status: 'missing', detail: 'android-36 exigido pelo projeto e ausente.' })
  })

  it('respeita um SDK explicitamente configurado, mesmo quando existe outro instalado', async () => {
    configuredSdk = path.join(root, 'sdk-inexistente')
    const report = await checkSimulatorEnvironment([root], 'android', 'android:Pixel')
    expect(report.checks.find((c) => c.id === 'android-sdk')?.status).toBe('missing')
    expect(report.checks.find((c) => c.id === 'adb')?.status).toBe('missing')
  })

  it('distingue Java sem compilador e um aparelho que não está no catálogo', async () => {
    unavailable.add('javac')
    const report = await checkSimulatorEnvironment([root], 'android', 'android:Inventado')
    expect(report.checks.find((c) => c.id === 'jdk')?.status).toBe('missing')
    expect(report.checks.find((c) => c.id === 'device')?.status).toBe('missing')
  })

  it('confere as ferramentas mesmo quando a conversa não tem app e o Node está ausente', async () => {
    mocks.projects.mockResolvedValue([])
    unavailable.add('node')
    const report = await checkSimulatorEnvironment([], 'android', '')
    expect(report.checks.find((c) => c.id === 'project')?.status).toBe('missing')
    expect(report.checks.find((c) => c.id === 'node')?.status).toBe('missing')
    expect(report.checks.find((c) => c.id === 'jdk')?.status).toBe('ok')
  })

  it('usa somente versões literais, sem adivinhar valores de variáveis ou comentários', () => {
    expect(androidDeclaredVersion(' // compileSdkVersion = 99\n compileSdkVersion = 36', 'compileSdk(?:Version)?')).toBe('36')
    expect(androidDeclaredVersion('compileSdk = libs.versions.compileSdk.get().toInt()', 'compileSdk(?:Version)?')).toBeUndefined()
    expect(androidDeclaredVersion('ndkVersion = "27.1.12297006" // versao do projeto', 'ndkVersion')).toBe('27.1.12297006')
  })
})
