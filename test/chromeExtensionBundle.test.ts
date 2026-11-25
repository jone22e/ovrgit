import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acknowledgeChromeExtensionBundle, syncChromeExtensionBundle, writeChromeExtensionConnection } from '../src/main/chromeExtensionBundle'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'ovseer-extension-bundle-')); roots.push(root)
  const source = path.join(root, 'app', 'extensions', 'ovseer'), data = path.join(root, 'dados do usuário')
  cpSync(path.resolve('extensions/ovseer'), source, { recursive: true })
  return { source, data }
}

describe('extensão distribuída junto com o Ovseer', () => {
  it('prepara todos os arquivos da versão empacotada e mostra o guia na primeira abertura', () => {
    const { source, data } = setup()
    const bundle = syncChromeExtensionBundle(source, data)
    const manifest = JSON.parse(readFileSync(path.join(bundle.folder, 'manifest.json'), 'utf8'))
    for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.action.default_icon, 'controller.js', 'popup.js', 'popup.css', 'logo.png']) {
      expect(existsSync(path.join(bundle.folder, file))).toBe(true)
      expect(readFileSync(path.join(bundle.folder, file))).toEqual(readFileSync(path.join(source, file)))
    }
    expect(bundle.needsGuide).toBe(true)
    expect(bundle.folder).toBe(path.join(data, 'chrome-extension'))
  })

  it('não repete o guia nem reescreve os arquivos ao reiniciar a mesma versão', () => {
    const { source, data } = setup()
    const first = syncChromeExtensionBundle(source, data)
    acknowledgeChromeExtensionBundle(source, data, first.revision)
    const manifest = path.join(first.folder, 'manifest.json'), before = statSync(manifest).mtimeMs
    const next = syncChromeExtensionBundle(source, data)
    expect(next.needsGuide).toBe(false)
    expect(statSync(manifest).mtimeMs).toBe(before)
  })

  it('atualiza a instalação na mesma pasta e reapresenta o guia quando a extensão mudar', () => {
    const { source, data } = setup()
    const first = syncChromeExtensionBundle(source, data)
    acknowledgeChromeExtensionBundle(source, data, first.revision)
    const worker = path.join(source, 'background.js')
    writeFileSync(worker, readFileSync(worker, 'utf8') + '\n// nova versão\n')
    const next = syncChromeExtensionBundle(source, data)
    expect(next.folder).toBe(first.folder)
    expect(next.revision).not.toBe(first.revision)
    expect(next.needsGuide).toBe(true)
    expect(readFileSync(path.join(next.folder, 'background.js'))).toEqual(readFileSync(worker))
    expect(() => acknowledgeChromeExtensionBundle(source, data, first.revision)).toThrow('atualizada')
  })

  it('restaura arquivos removidos sem perder a confirmação do guia', () => {
    const { source, data } = setup()
    const first = syncChromeExtensionBundle(source, data)
    acknowledgeChromeExtensionBundle(source, data, first.revision)
    rmSync(path.join(first.folder, 'controller.js'))
    expect(syncChromeExtensionBundle(source, data).needsGuide).toBe(false)
    expect(existsSync(path.join(first.folder, 'controller.js'))).toBe(true)
  })

  it('prepara a conexão privada automaticamente sem incluí-la no código distribuído nem repetir o guia', () => {
    const { source, data } = setup()
    const bundle = syncChromeExtensionBundle(source, data)
    acknowledgeChromeExtensionBundle(source, data, bundle.revision)
    const connection = 'http://127.0.0.1:12345/extension/chave-local-do-teste'
    writeChromeExtensionConnection(bundle.folder, connection)
    const file = path.join(bundle.folder, 'connection.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ connection })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    const before = statSync(file).mtimeMs
    writeChromeExtensionConnection(bundle.folder, connection)
    expect(statSync(file).mtimeMs).toBe(before)
    const nextConnection = connection.replace('12345', '45678')
    writeChromeExtensionConnection(bundle.folder, nextConnection)
    expect(JSON.parse(readFileSync(file, 'utf8')).connection).toBe(nextConnection)
    expect(existsSync(path.join(source, 'connection.json'))).toBe(false)
    expect(syncChromeExtensionBundle(source, data).needsGuide).toBe(false)
    const manifest = JSON.parse(readFileSync(path.join(bundle.folder, 'manifest.json'), 'utf8'))
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['logo.png'], matches: ['http://*/*', 'https://*/*'] }])
  })
})
