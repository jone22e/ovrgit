// Compila o ajudante nativo de transcrição (macOS) e copia o binário para dist-native/darwin/, onde o processo
// principal o procura em desenvolvimento (no app empacotado ele vai em Resources/native).
//   node scripts/build-native.mjs              só a arquitetura desta máquina (rápido, para o dia a dia)
//   node scripts/build-native.mjs --universal  arm64 + x64 num binário só (para os instaladores)
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'ovseer-transcribe'

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

const pkg = join(root, 'native', 'macos', 'Transcribe')
const out = join(root, 'dist-native', 'darwin')
mkdirSync(out, { recursive: true })
const staged = join(out, `${NAME}.new`)
if (process.argv.includes('--universal')) {
  // uma compilação por arquitetura, unidas com o lipo (não depende do Xcode completo)
  const built = ['arm64', 'x86_64'].map((arch) => {
    const scratch = join(pkg, '.build', arch)
    run('swift', ['build', '-c', 'release', '--triple', `${arch}-apple-macosx`, '--scratch-path', scratch], pkg)
    return join(scratch, 'release', NAME)
  })
  run('lipo', ['-create', ...built, '-output', staged], pkg)
} else {
  run('swift', ['build', '-c', 'release'], pkg)
  copyFileSync(join(pkg, '.build', 'release', NAME), staged)
}
// troca por renomear: um ajudante em execução segue com a cópia dele
renameSync(staged, join(out, NAME))
console.log(`[build-native] ${NAME} -> ${join(out, NAME)}`)
