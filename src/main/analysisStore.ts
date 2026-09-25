import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Analysis } from '../shared/types'

/** A última análise de cada projeto fica salva, para não se perder ao fechar o app. */
interface Saved {
  root: string
  /** Hash do contexto enviado à IA: se nada mudou, a análise é reaproveitada sem chamar a IA */
  hash: string
  savedAt: string
  analysis: Analysis
}

const dir = () => path.join(app.getPath('userData'), 'analysis')
const fileFor = (root: string) => path.join(dir(), `${createHash('sha1').update(root).digest('hex')}.json`)

export const contextHash = (parts: string[]) => createHash('sha1').update(parts.join('\0')).digest('hex')

export function loadAnalysis(root: string): Saved | null {
  try {
    const s = JSON.parse(readFileSync(fileFor(root), 'utf8')) as Saved
    return s.root === root ? s : null
  } catch {
    return null
  }
}

export function clearAnalysis(root: string) {
  rmSync(fileFor(root), { force: true })
}

export function saveAnalysis(root: string, analysis: Analysis, hash?: string) {
  mkdirSync(dir(), { recursive: true })
  const prev = loadAnalysis(root)
  const data: Saved = { root, hash: hash ?? prev?.hash ?? '', savedAt: new Date().toISOString(), analysis }
  const f = fileFor(root)
  writeFileSync(`${f}.tmp`, JSON.stringify(data))
  renameSync(`${f}.tmp`, f)
}
