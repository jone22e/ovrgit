import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SimulatorEnvironmentCheck, SimulatorEnvironmentReport, SimulatorPlatform } from '../shared/simulator'
import { debugCommand, simulatorDebugProjects } from './simulatorDebug'
import { androidSdkRoots, simulatorCatalog } from './simulators'
import { shellFor } from './services'

const exists = async (file: string) => !!await fs.stat(file).catch(() => null)
const read = (file: string) => fs.readFile(file, 'utf8').catch(() => '')
const lines = (value: string) => value.trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' · ').slice(0, 300)

/** Mesmo shell de login do Play; não usa o Node embutido no Electron como evidência de instalação. */
async function probe(args: string[], cwd: string) {
  const command = process.platform === 'win32'
    ? `$ErrorActionPreference='Stop'; & ${args.map((s) => `'${s.replace(/'/g, "''")}'`).join(' ')}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`
    : debugCommand(args)
  const shell = shellFor(command)
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(shell.file, shell.args, { cwd, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, env: { ...process.env, COCOAPODS_DISABLE_STATS: 'true', NO_COLOR: '1' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}\n${stderr ?? ''}`.trim() })
    })
  })
}

async function packagesAt(root: string, folder: string, witness: string) {
  const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])
  const installed = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => await exists(path.join(root, folder, e.name, witness)) ? e.name : null))
  return installed.filter((v): v is string => !!v).sort()
}

async function missingDependencies(root: string) {
  const pkg = JSON.parse(await read(path.join(root, 'package.json')) || '{}')
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const missing = await Promise.all(names.map(async (name) => {
    let dir = root
    while (true) {
      if (await exists(path.join(dir, 'node_modules', name))) return null
      const parent = path.dirname(dir)
      if (parent === dir) return name
      dir = parent
    }
  }))
  return missing.filter((name): name is string => !!name)
}

/** Só considera versões literais declaradas no Gradle; expressões ficam para a compilação resolver. */
export function androidDeclaredVersion(gradle: string, name: string) {
  return new RegExp(`^\\s*(?:val\\s+)?${name}\\s*(?:=|\\()?\\s*["']?([\\d.]+)["']?\\s*\\)?;?\\s*(?://[^\\n]*)?$`, 'm').exec(gradle)?.[1]
}

export async function checkSimulatorEnvironment(roots: string[], platform: SimulatorPlatform, deviceId: string): Promise<SimulatorEnvironmentReport> {
  const checks: SimulatorEnvironmentCheck[] = []
  const add = (id: string, label: string, ok: boolean, detail: string, fix?: string, warning = false) => checks.push({ id, label, status: ok ? 'ok' : warning ? 'warning' : 'missing', detail, ...(!ok && fix ? { fix } : {}) })
  const projects = (await simulatorDebugProjects(roots)).filter((p) => p.platforms.includes(platform))
  const project = projects.length === 1 ? projects[0] : undefined
  const cwd = project?.root ?? os.homedir()
  add('project', 'App da conversa', !!project, project ? `${project.name} · ${project.kind === 'expo' ? 'Expo' : 'React Native'}` : projects.length ? `${projects.length} apps encontrados.` : 'Nenhum app encontrado nos repositórios desta conversa.', 'Vincule à conversa o repositório do app que deseja executar.')
  const node = await probe(['node', '-e', 'console.log("OVSEER_NODE="+JSON.stringify({version:process.version,androidHome:process.env.ANDROID_HOME,androidSdkRoot:process.env.ANDROID_SDK_ROOT,developerDir:process.env.DEVELOPER_DIR}))'], cwd)
  let environment: { version?: string; androidHome?: string; androidSdkRoot?: string; developerDir?: string } = {}
  try { environment = JSON.parse(node.output.split(/\r?\n/).filter((s) => s.startsWith('OVSEER_NODE=')).at(-1)!.slice(12)) } catch { /* sem resposta válida do Node externo */ }
  add('node', 'Node.js', node.ok && !!environment.version, environment.version ?? 'Node não respondeu no shell usado pelo Play.', 'Instale o Node exigido pelo projeto e disponibilize-o no PATH do seu shell.')
  if (project) {
    const cli = project.kind === 'expo' ? 'node_modules/expo/bin/cli' : 'node_modules/react-native/cli.js'
    const present = await exists(path.join(project.root, cli))
    add('cli', 'CLI do app', present, present ? `CLI encontrado em ${project.root}.` : `Não encontrado: ${cli}.`, 'Instale as dependências com o gerenciador definido pelo projeto.')
    const missing = await missingDependencies(project.root)
    add('dependencies', 'Dependências JavaScript', missing.length === 0, missing.length ? `Pacotes ausentes: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` e mais ${missing.length - 8}` : ''}.` : 'Pacotes declarados encontrados em node_modules.', 'Instale as dependências com o gerenciador definido pelo projeto.')
  }

  if (platform === 'ios') {
    add('host', 'macOS', process.platform === 'darwin', process.platform === 'darwin' ? 'Simuladores iOS disponíveis neste sistema.' : 'O simulador iOS exige macOS.', 'Execute a depuração iOS em um Mac com Xcode.')
    if (process.platform === 'darwin') {
      const bundledPods = !!project && /\bgem\s+['"]cocoapods['"]/.test(await read(path.join(project.root, 'Gemfile')))
      const [selected, xcode, firstLaunch, sdk, pods] = await Promise.all([
        probe(['/usr/bin/xcode-select', '-p'], cwd), probe(['/usr/bin/xcodebuild', '-version'], cwd),
        probe(['/usr/bin/xcodebuild', '-checkFirstLaunchStatus'], cwd), probe(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version'], cwd), probe(bundledPods ? ['bundle', 'exec', 'pod', '--version'] : ['pod', '--version'], cwd)
      ])
      const developer = environment.developerDir || selected.output.split(/\r?\n/).filter((s) => s.startsWith('/')).at(-1) || ''
      add('xcode', 'Xcode e ferramentas de compilação', xcode.ok, xcode.ok ? lines(xcode.output) : 'Xcode completo não está disponível ou selecionado.', 'Instale o Xcode e selecione-o em Xcode → Settings → Locations → Command Line Tools.')
      add('xcode-setup', 'Preparação e licença do Xcode', firstLaunch.ok, firstLaunch.ok ? 'Preparação inicial concluída.' : 'Xcode ainda exige preparação inicial ou aceite de licença.', 'Abra o Xcode e conclua a instalação dos componentes e o aceite da licença.')
      add('ios-sdk', 'SDK do iOS Simulator', sdk.ok, sdk.ok ? `Versão ${lines(sdk.output)}.` : 'SDK do simulador não encontrado.', 'Instale o suporte ao iOS nas configurações de componentes do Xcode.')
      const simulator = !!developer && await exists(path.join(developer, 'Applications/Simulator.app'))
      add('simulator-app', 'Aplicativo Simulator', simulator, simulator ? 'Simulator encontrado no Xcode selecionado.' : 'Simulator não encontrado no Xcode selecionado.', 'Instale o Xcode completo com o componente Simulator.')
      add('cocoapods', 'CocoaPods', pods.ok, pods.ok ? `${lines(pods.output)}${bundledPods ? ' · Bundler do projeto' : ''}` : bundledPods ? 'CocoaPods não respondeu pelo Bundler do projeto.' : 'O comando pod não respondeu no shell do Play.', bundledPods ? 'Instale o Bundler e as gems declaradas no Gemfile do projeto.' : 'Instale o CocoaPods exigido pelo projeto e disponibilize pod no PATH do seu shell.')
      if (project && await exists(path.join(project.root, 'ios/Podfile'))) {
        const [lock, installed] = await Promise.all([read(path.join(project.root, 'ios/Podfile.lock')), read(path.join(project.root, 'ios/Pods/Manifest.lock'))])
        const synced = !!lock && lock.trim() === installed.trim()
        add('pods', 'Dependências nativas (Pods)', synced, synced ? 'Pods instalados e sincronizados com Podfile.lock.' : 'Pods ausentes ou diferentes do Podfile.lock.', 'Instale ou sincronize os Pods na pasta ios do projeto.', true)
      }
    }
  } else {
    const [java, javac] = await Promise.all([probe(['java', '-version'], cwd), probe(['javac', '-version'], cwd)])
    add('jdk', 'Java Development Kit (JDK)', java.ok && javac.ok, java.ok && javac.ok ? `${lines(java.output)} · ${lines(javac.output)}` : 'Java ou o compilador javac não respondeu.', 'Instale o JDK exigido pelo Gradle do projeto e configure JAVA_HOME/PATH.')
    const local = project ? /^(?:\s*)sdk\.dir\s*=\s*(.+)$/m.exec(await read(path.join(project.root, 'android/local.properties')))?.[1].trim().replace(/\\([\\ :])/g, '$1') : undefined
    const configured = local || environment.androidHome || environment.androidSdkRoot
    let sdkRoot = configured ?? ''
    if (!sdkRoot) for (const candidate of androidSdkRoots()) { if (await exists(candidate)) { sdkRoot = candidate; break } }
    const sdkPresent = !!sdkRoot && path.isAbsolute(sdkRoot) && await fs.stat(sdkRoot).then((s) => s.isDirectory()).catch(() => false)
    add('android-sdk', 'Android SDK', sdkPresent, sdkPresent ? sdkRoot : configured ? `SDK configurado não encontrado: ${configured}` : 'SDK não encontrado.', 'Instale o Android SDK pelo SDK Manager do Android Studio e configure ANDROID_HOME ou android/local.properties.')
    const suffix = process.platform === 'win32' ? '.exe' : ''
    for (const [id, label, relative, fix] of [
      ['adb', 'Android Platform Tools (ADB)', `platform-tools/adb${suffix}`, 'Instale Android SDK Platform-Tools pelo SDK Manager.'],
      ['emulator', 'Android Emulator', `emulator/emulator${suffix}`, 'Instale Android Emulator pelo SDK Manager.']
    ]) {
      const result = sdkPresent ? await probe([path.join(sdkRoot, relative), id === 'adb' ? 'version' : '-version'], cwd) : undefined
      add(id, label, !!result?.ok, result?.ok ? lines(result.output) : `${label} não respondeu no SDK configurado.`, fix)
    }
    const gradle = project ? (await Promise.all(['android/build.gradle', 'android/build.gradle.kts', 'android/app/build.gradle', 'android/app/build.gradle.kts'].map((p) => read(path.join(project.root, p))))).join('\n') : ''
    for (const [id, label, folder, witness, versionKey, prefix] of [
      ['platforms', 'Plataforma Android para compilação', 'platforms', 'android.jar', 'compileSdk(?:Version)?', 'android-'],
      ['build-tools', 'Android Build Tools', 'build-tools', `aapt2${suffix}`, 'buildToolsVersion', ''],
      ['ndk', 'Android NDK', 'ndk', 'source.properties', 'ndkVersion', '']
    ]) {
      const installed = sdkPresent ? await packagesAt(sdkRoot, folder, witness) : []
      const version = androidDeclaredVersion(gradle, versionKey)
      const required = version ? `${prefix}${version}` : undefined
      const ok = required ? installed.includes(required) : installed.length > 0
      add(id, label, ok, required ? `${required} ${ok ? 'instalado' : 'exigido pelo projeto e ausente'}.` : installed.length ? `Instalados: ${installed.join(', ')}.` : 'Nenhuma instalação encontrada.', required ? `Instale ${label} ${required} pelo SDK Manager.` : `Instale a versão de ${label} exigida pelo projeto no SDK Manager.`, id === 'ndk' && !required)
    }
    if (project && await exists(path.join(project.root, 'android'))) {
      const wrapper = await exists(path.join(project.root, 'android/gradle/wrapper/gradle-wrapper.jar')) && await exists(path.join(project.root, process.platform === 'win32' ? 'android/gradlew.bat' : 'android/gradlew'))
      add('gradle', 'Gradle Wrapper do projeto', wrapper, wrapper ? 'Launcher e wrapper encontrados.' : 'Arquivos do Gradle Wrapper ausentes.', 'Restaure os arquivos do Gradle Wrapper do projeto.')
    }
  }
  const catalog = await simulatorCatalog()
  const devices = catalog.devices.filter((d) => d.platform === platform)
  const selected = devices.find((d) => d.id === deviceId)
  add('device', platform === 'ios' ? 'Runtime e simulador selecionado' : 'Aparelho virtual selecionado', !!selected, selected ? `${selected.name} · ${selected.runtime}${selected.running ? ' · ligado' : ' · disponível para iniciar'}` : catalog.issues[platform] ?? (devices.length ? 'Selecione um aparelho no painel.' : 'Nenhum aparelho disponível.'), platform === 'ios' ? 'Instale um runtime iOS e crie um simulador em Xcode → Settings → Components / Devices and Simulators.' : 'Instale uma imagem de sistema e crie um aparelho no Device Manager do Android Studio.')
  return { platform, ...(project ? { project: project.name } : {}), checks }
}

export function registerSimulatorEnvironment() {
  ipcMain.handle('simulator:check-environment', (_event, roots: unknown, platform: unknown, id: unknown) => {
    if (!Array.isArray(roots) || roots.length > 10 || roots.some((r) => typeof r !== 'string' || r.length > 4096) || (platform !== 'ios' && platform !== 'android') || typeof id !== 'string' || id.length > 200) throw new Error('Projeto, plataforma ou aparelho inválido.')
    return checkSimulatorEnvironment(roots as string[], platform, id)
  })
}
