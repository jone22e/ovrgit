import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SourceFile } from '../shared/types'
import { git, run } from './git'

/** Acima disso o arquivo não abre no editor (fica lento e raramente é código) */
const MAX_BYTES = 2 * 1024 * 1024

/** Arquivos .env* (ignorados pelo git, mas que a gente edita e precisa ver) */
const DOTENV = /(^|\/)\.env(\.[^/]*)?$/
const HEAVY = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git)\//

/**
 * Arquivos do projeto: os versionados e os novos que o .gitignore não ignora,
 * mais os .env* ignorados (como no JetBrains, que mostra os ignorados)
 */
export async function listSourceFiles(root: string): Promise<string[]> {
  const [out, ignored] = await Promise.all([
    git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).catch(() => '')
  ])
  const env = ignored.split('\0').filter((p) => DOTENV.test(p) && !HEAVY.test(p))
  return [...new Set([...out.split('\0'), ...env].filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/**
 * Cria um arquivo novo (as pastas também, se faltarem). Recusa se já existe.
 * `ignored`: se o git vai ignorar o arquivo (para avisar quando um .env ficaria de fora do .gitignore)
 */
export async function createSourceFile(root: string, rel: string, content: string): Promise<{ path: string; ignored: boolean }> {
  const abs = inside(root, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  try {
    await writeFile(abs, content, { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${rel} já existe.`)
    throw e
  }
  const r = await run(root, ['check-ignore', '-q', '--', rel]).catch(() => null)
  return { path: rel, ignored: r?.code === 0 }
}

/** Caminho relativo → absoluto, recusando o que sair da pasta do repositório */
function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const r = path.relative(root, abs)
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error('Arquivo fora do projeto.')
  return abs
}

export async function readSourceFile(root: string, rel: string): Promise<SourceFile> {
  const abs = inside(root, rel)
  const st = await stat(abs)
  if (st.size > MAX_BYTES) return { path: rel, content: null, reason: `Arquivo grande demais para abrir aqui (${(st.size / 1024 / 1024).toFixed(1)} MB).` }
  const buf = await readFile(abs)
  // byte nulo no começo: binário (imagem, fonte, executável…)
  if (buf.subarray(0, 8000).includes(0)) return { path: rel, content: null, reason: 'Arquivo binário: não dá para mostrar como texto.' }
  const file: SourceFile = { path: rel, content: buf.toString('utf8'), mtimeMs: st.mtimeMs }
  // .env*: o editor avisa se o arquivo está (ou não) fora do git
  if (DOTENV.test(rel)) file.ignored = (await run(root, ['check-ignore', '-q', '--', rel]).catch(() => ({ code: 1 }))).code === 0
  return file
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml'
}
const MAX_IMAGE = 25 * 1024 * 1024

/** Imagem do projeto como data URL, para a prévia (no editor e nas imagens do Markdown) */
export async function readSourceImage(root: string, rel: string): Promise<{ dataUrl: string; bytes: number }> {
  const mime = IMAGE_MIME[rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()]
  if (!mime) throw new Error('Não é uma imagem.')
  const abs = inside(root, rel)
  const st = await stat(abs)
  if (st.size > MAX_IMAGE) throw new Error(`Imagem grande demais para mostrar (${(st.size / 1024 / 1024).toFixed(1)} MB).`)
  return { dataUrl: `data:${mime};base64,${(await readFile(abs)).toString('base64')}`, bytes: st.size }
}

/**
 * Salva o conteúdo. Com `expectedMtimeMs`, recusa se o arquivo mudou no disco desde que foi aberto
 * (um agente ou outro editor mexeu nele), para não apagar essas mudanças.
 */
export async function writeSourceFile(root: string, rel: string, content: string, expectedMtimeMs?: number): Promise<number> {
  const abs = inside(root, rel)
  if (expectedMtimeMs !== undefined) {
    const cur = await stat(abs).catch(() => null)
    if (cur && Math.abs(cur.mtimeMs - expectedMtimeMs) > 1) throw new Error('O arquivo mudou no disco desde que foi aberto. Recarregue antes de salvar.')
  }
  await writeFile(abs, content, 'utf8')
  return (await stat(abs)).mtimeMs
}
