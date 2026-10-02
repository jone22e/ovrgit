import { dialog, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportServices, normalizeRemote, parseServicesFile, resolveServices, type ImportedService, type RepoRef, type ServicesFile } from '../shared/servicesShare'
import { suggestedParent } from './clone'
import { findRoot, run } from './git'
import { getSettings } from './settings'

/** Exportar e importar os serviços (a parte que toca disco e git; as regras estão em shared/servicesShare) */

/** Repositório a que a pasta pertence, com o remoto "origin" normalizado (null: não é um repositório) */
async function repoRef(dir: string): Promise<RepoRef | null> {
  if (!dir || !existsSync(dir)) return null
  try {
    const root = await findRoot(dir)
    const r = await run(root, ['remote', 'get-url', 'origin'])
    return { root, name: path.basename(root), remote: r.code === 0 ? normalizeRemote(r.stdout) : '' }
  } catch {
    return null
  }
}

/** Grava os serviços num arquivo escolhido pelo usuário, sem caminhos deste computador */
export async function exportToFile(win: BrowserWindow): Promise<{ path: string; count: number } | null> {
  const services = getSettings().services
  if (!services.length) throw new Error('Não há serviços para exportar.')
  const refs = new Map<string, RepoRef | null>()
  for (const s of services) if (s.cwd && !refs.has(s.cwd)) refs.set(s.cwd, await repoRef(s.cwd))
  const file = exportServices(services, (cwd) => refs.get(cwd) ?? null, os.homedir())
  const res = await dialog.showSaveDialog(win, {
    title: 'Exportar serviços',
    defaultPath: path.join(os.homedir(), 'ovseer-servicos.json'),
    filters: [{ name: 'Serviços do Ovseer', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return null
  writeFileSync(res.filePath, JSON.stringify(file, null, 2) + '\n', 'utf8')
  return { path: res.filePath, count: file.services.length }
}

/** Abre um arquivo de serviços; devolve o conteúdo validado e a pasta raiz sugerida (onde ficam os projetos do usuário) */
export async function pickImport(win: BrowserWindow): Promise<{ file: ServicesFile; root: string } | null> {
  const res = await dialog.showOpenDialog(win, {
    title: 'Importar serviços',
    properties: ['openFile'],
    filters: [{ name: 'Serviços do Ovseer', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  if (statSync(res.filePaths[0]).size > 2_000_000) throw new Error('Arquivo grande demais.')
  const file = parseServicesFile(readFileSync(res.filePaths[0], 'utf8'))
  return { file, root: suggestedParent(getSettings().recentProjects) }
}

/** Pasta de cada serviço do arquivo neste computador, com o que o usuário precisa saber antes de importar */
export async function resolveImport(input: ServicesFile, root: string): Promise<ImportedService[]> {
  // o arquivo volta da janela: valida de novo
  const file = parseServicesFile(JSON.stringify(input))
  const known: RepoRef[] = []
  for (const p of getSettings().recentProjects) {
    const r = await repoRef(p)
    if (r && !known.some((k) => k.root === r.root)) known.push(r)
  }
  const mine = getSettings().services
  return resolveServices(file, { root: root || os.homedir(), known, home: os.homedir() }).map((s) => ({
    ...s,
    exists: !s.cwd || existsSync(s.cwd),
    duplicate: mine.some((m) => m.name === s.name && m.command === s.command && m.cwd === s.cwd)
  }))
}
