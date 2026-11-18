// Compila o ajudante nativo de transcrição (macOS) e copia o binário para dist-native/darwin/, onde o processo
// principal o procura em desenvolvimento (no app empacotado ele vai em Resources/native).
//   node scripts/build-native.mjs              só a arquitetura desta máquina (rápido, para o dia a dia)
//   node scripts/build-native.mjs --universal  arm64 + x64 num binário só (para os instaladores)
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[build-native] falhou: ${command} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

if (process.platform !== 'darwin') {
  console.log(`[build-native] sem ajudante nativo para ${process.platform}; nada a fazer`)
  process.exit(0)
}

const out = join(root, 'dist-native', 'darwin')
mkdirSync(out, { recursive: true })
for (const [folder, name] of [['Transcribe', 'ovseer-transcribe'], ['ComputerUse', 'ovseer-computer']]) {
  const pkg = join(root, 'native', 'macos', folder)
  const staged = join(out, `${name}.new`)
  if (process.argv.includes('--universal')) {
    // uma compilação por arquitetura, unidas com o lipo (não depende do Xcode completo)
    const built = ['arm64', 'x86_64'].map((arch) => {
      const scratch = join(pkg, '.build', arch)
      run('swift', ['build', '-c', 'release', '--triple', `${arch}-apple-macosx`, '--scratch-path', scratch], pkg)
      return join(scratch, 'release', name)
    })
    run('lipo', ['-create', ...built, '-output', staged], pkg)
  } else {
    run('swift', ['build', '-c', 'release'], pkg)
    copyFileSync(join(pkg, '.build', 'release', name), staged)
  }
  // troca por renomear: um ajudante em execução segue com a cópia dele
  renameSync(staged, join(out, name))
  console.log(`[build-native] ${name} -> ${join(out, name)}`)
}

// Captura contínua e entrada do Simulator do Xcode; não depende de frameworks privados para compilar.
const simulatorSource = join(root, 'native', 'macos', 'Simulator', 'main.m')
const simulatorOutput = join(out, 'ovseer-simulator')
const simulatorBuilds = (process.argv.includes('--universal') ? ['arm64', 'x86_64'] : [process.arch === 'arm64' ? 'arm64' : 'x86_64']).map((arch) => {
  const file = `${simulatorOutput}.${arch}.new`
  run('xcrun', ['clang', '-arch', arch, '-fobjc-arc', '-O2', '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'ImageIO', '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-framework', 'IOSurface', simulatorSource, '-o', file], root)
  return file
})
if (simulatorBuilds.length > 1) {
  run('lipo', ['-create', ...simulatorBuilds, '-output', `${simulatorOutput}.new`], root)
  renameSync(`${simulatorOutput}.new`, simulatorOutput)
} else renameSync(simulatorBuilds[0], simulatorOutput)
console.log(`[build-native] ovseer-simulator -> ${simulatorOutput}`)
