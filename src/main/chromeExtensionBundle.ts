import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const FILES = ['manifest.json', 'background.js', 'controller.js', 'popup.html', 'popup.css', 'popup.js', 'icon.png', 'README.md']
type Saved = { revision?: string; acknowledged?: string }
const stateFile = (data: string) => path.join(data, 'chrome-extension-bundle.json')
function saved(data: string): Saved {
  try { return JSON.parse(readFileSync(stateFile(data), 'utf8')) } catch { return {} }
}

/** A mesma pasta persiste entre versões; o Chrome pode recarregar a instalação existente. */
export function syncChromeExtensionBundle(source: string, data: string) {
  const files = FILES.map((name) => ({ name, contents: readFileSync(path.join(source, name)) }))
  const manifest = JSON.parse(files[0].contents.toString()) as { version: string }
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.name).update('\0').update(file.contents)
  const revision = hash.digest('hex')
  const folder = path.join(data, 'chrome-extension')
  const previous = saved(data)
  mkdirSync(folder, { recursive: true })
  for (const { name, contents } of files) {
    const target = path.join(folder, name)
    try { if (readFileSync(target).equals(contents)) continue } catch { /* arquivo novo ou removido */ }
    writeFileSync(target, contents)
  }
  if (previous.revision !== revision) writeFileSync(stateFile(data), JSON.stringify({ ...previous, revision }))
  return { folder, version: manifest.version, revision, needsGuide: previous.acknowledged !== revision }
}

export function acknowledgeChromeExtensionBundle(source: string, data: string, revision: string) {
  const current = syncChromeExtensionBundle(source, data)
  if (current.revision !== revision) throw new Error('A extensão foi atualizada. Reabra o guia para ver as instruções atuais.')
  writeFileSync(stateFile(data), JSON.stringify({ revision, acknowledged: revision }))
}

/** Credencial por computador, fora do código distribuído e sem acesso por páginas web. */
export function writeChromeExtensionConnection(folder: string, connection: string) {
  const file = path.join(folder, 'connection.json')
  const contents = JSON.stringify({ connection })
  try { if (readFileSync(file, 'utf8') === contents) { chmodSync(file, 0o600); return } } catch { /* primeira conexão */ }
  const temporary = `${file}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}
