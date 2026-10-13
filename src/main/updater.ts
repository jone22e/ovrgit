import { app, powerMonitor } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { isNewerVersion } from '../shared/version'
import { getSettings } from './settings'

/**
 * Atualização automática pelos releases do GitHub: checa ao abrir, de tempos em tempos, quando o app volta ao
 * primeiro plano e quando o computador acorda; baixa em segundo plano. Uma versão publicada aparece em
 * minutos, não só na próxima abertura do app.
 *
 * Com uma versão já baixada, as checagens continuam: se sair outra mais nova, ela é baixada por cima e é a que
 * se instala no reinício, sem o usuário ter de instalar uma por uma. Nessas checagens a versão pronta fica na
 * tela como está (sem "procurando…" nem erro passageiro); só um download novo muda o estado.
 */
const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 30 * 60 * 1000
/** Ao focar a janela ou acordar o computador, só checa de novo passado este tempo desde a última tentativa */
const FOCUS_MIN_GAP_MS = 10 * 60 * 1000
let lastAttempt = 0

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
  const ready = () => current.status === 'ready'
  autoUpdater.on('checking-for-update', () => !ready() && set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => {
    if (!ready()) return set({ status: 'available', version: info.version })
    // já há uma versão pronta: só uma mais nova interessa (substitui a baixada); a mesma, ou uma mais velha, não muda nada
    if (!current.version || !isNewerVersion(info.version, current.version)) return
    set(autoUpdater.autoDownload ? { status: 'downloading', version: info.version, percent: 0 } : { status: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => !ready() && set({ status: 'idle', version: undefined, checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (e) => !ready() && set({ status: 'error', error: friendly(e) }))

  setTimeout(() => getSettings().autoUpdate && checkForUpdates(), FIRST_CHECK_MS)
  timer = setInterval(() => getSettings().autoUpdate && checkForUpdates(), INTERVAL_MS)
  // o computador dormiu: o intervalo pode ter ficado para trás; checa logo ao acordar (com rede de volta)
  powerMonitor.on('resume', () => setTimeout(checkIfStale, 5_000))
  app.on('browser-window-focus', checkIfStale)
}

/** Checagem oportunista (foco, acordar): só se a automática está ligada e faz tempo desde a última tentativa */
function checkIfStale() {
  if (!getSettings().autoUpdate || Date.now() - lastAttempt < FOCUS_MIN_GAP_MS) return
  void checkForUpdates()
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return current
  // não interrompe um download em andamento (com uma versão pronta, checa mesmo assim: pode ter saído outra mais nova)
  if (current.status === 'checking' || current.status === 'downloading') return current
  autoUpdater.autoDownload = getSettings().autoUpdate
  lastAttempt = Date.now()
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
