import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Ferramenta MCP nativa do Ovseer para controlar os aplicativos deste Mac. */
export function computerUseBinary(): string | null {
  if (process.platform !== 'darwin') return null
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'ovseer-computer')
    : path.join(app.getAppPath(), 'dist-native', 'darwin', 'ovseer-computer')
  return existsSync(file) ? file : null
}
