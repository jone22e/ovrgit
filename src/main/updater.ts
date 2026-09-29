import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { getSettings } from './settings'

/** Atualização automática pelos releases do GitHub: checa ao abrir e de tempos em tempos, baixa em segundo plano. */
const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 4 * 60 * 60 * 1000

let current: UpdateState = { status: 'idle', current: app.getVersion() }
let notify: (s: UpdateState) => void = () => undefined
let timer: ReturnType<typeof setInterval> | undefined

function set(patch: Partial<UpdateState>) {
  current = { ...current, ...patch }
  notify(current)
}

/** Mensagem curta para o usuário; o erro completo do updater traz cabeçalhos HTTP e pilha. */
function friendly(e: unknown): string {
  const text = String((e as Error)?.message ?? e)
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|ERR_INTERNET|ERR_NETWORK|ERR_NAME_NOT_RESOLVED/i.test(text)) return 'Sem conexão com o servidor de atualizações.'
  if (/404|latest.*\.yml/i.test(text)) return 'Nenhuma versão publicada foi encontrada.'
  return text.split('\n')[0].slice(0, 200)
}

export function updateState(): UpdateState {
  return current
}

export function setupUpdater(onChange: (s: UpdateState) => void) {
  notify = onChange
  // em desenvolvimento não há pacote instalado para substituir
  if (!app.isPackaged) return void set({ status: 'unsupported' })

  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => set({ status: 'idle', version: undefined, checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (e) => set({ status: 'error', error: friendly(e) }))

  setTimeout(() => getSettings().autoUpdate && checkForUpdates(), FIRST_CHECK_MS)
  timer = setInterval(() => getSettings().autoUpdate && checkForUpdates(), INTERVAL_MS)
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return current
  // não interrompe um download em andamento nem descarta uma versão já pronta
  if (current.status === 'checking' || current.status === 'downloading' || current.status === 'ready') return current
  autoUpdater.autoDownload = getSettings().autoUpdate
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ status: 'error', error: friendly(e) })
  }
  return current
}

export async function downloadUpdate(): Promise<void> {
  if (current.status !== 'available') return
  set({ status: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    set({ status: 'error', error: friendly(e) })
  }
}

export function installUpdate() {
  if (current.status === 'ready') autoUpdater.quitAndInstall()
}

export function stopUpdater() {
  clearInterval(timer)
}
