import { app, clipboard, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ChromeBridge, type ChromeSession } from './chromeBridge'

let bridge: Promise<ChromeBridge> | undefined

function getBridge(): Promise<ChromeBridge> {
  if (bridge) return bridge
  bridge = (async () => {
    const file = path.join(app.getPath('userData'), 'chrome-bridge.json')
    let token = randomBytes(32).toString('base64url'), port = 0
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof saved.token === 'string' && /^[\w-]{40,}$/.test(saved.token)) token = saved.token
      if (Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536) port = saved.port
    } catch { /* primeira configuração */ }
    let instance = new ChromeBridge(token, port)
    try { await instance.ready } catch (e) {
      if (!port || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      await instance.close()
      instance = new ChromeBridge(token)
      await instance.ready
    }
    const info = await instance.ready
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ token, port: info.port }), { mode: 0o600 })
    return instance
  })().catch((e) => { bridge = undefined; throw e })
  return bridge
}

export async function chromeAgentSession(label: string): Promise<ChromeSession> {
  return (await getBridge()).session(label)
}

/** Instala uma cópia persistente, fora do asar, para o usuário carregar no Chrome. */
export async function prepareChromeExtension(): Promise<string> {
  await getBridge()
  const folder = path.join(app.getPath('userData'), 'chrome-extension')
  mkdirSync(folder, { recursive: true })
  for (const name of ['manifest.json', 'background.js', 'controller.js', 'popup.html', 'popup.css', 'popup.js', 'icon.png', 'README.md']) {
    writeFileSync(path.join(folder, name), readFileSync(path.join(app.getAppPath(), 'extensions', 'ovseer', name)))
  }
  const error = await shell.openPath(folder)
  if (error) throw new Error(error)
  return folder
}

export async function copyChromeConnection(): Promise<void> {
  clipboard.writeText((await (await getBridge()).ready).connection)
}

export async function stopChromeBridge() {
  const current = bridge
  bridge = undefined
  if (current) await (await current).close()
}
