import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computerUseBinary } from './computerUse'
import type { CaptureShortcutKey } from '../shared/types'

const keyNames: Record<CaptureShortcutKey, string> = {
  shift: 'Shift', control: 'Control', option: 'Option', command: 'Command'
}

let watcher: ChildProcess | null = null
let watchedKey: CaptureShortcutKey = 'shift'
let chooser: ChildProcess | null = null
let thumbnail: BrowserWindow | null = null
let captureDir: string | null = null
let busy = false

function tempFile(): string {
  captureDir ??= mkdtempSync(path.join(os.tmpdir(), 'ovseer-capture-'))
  return path.join(captureDir, `captura-${Date.now()}.png`)
}

function showThumbnail(file: string) {
  thumbnail?.destroy()
  const point = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(point).workArea
  const image = nativeImage.createFromPath(file)
  const size = image.getSize()
  const scale = Math.min(1, 220 / Math.max(1, size.width), 180 / Math.max(1, size.height))
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const x = area.x + area.width - width - 16
  const y = area.y + area.height - height - 16
  const win = new BrowserWindow({
    width, height, x, y, frame: false, transparent: true, resizable: false,
    hasShadow: false, acceptFirstMouse: true, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  })
  thumbnail = win
  win.on('closed', () => { if (thumbnail === win) thumbnail = null })
  win.webContents.on('ipc-message', (event, channel) => {
    if (channel !== 'capture:drag' || win.isDestroyed()) return
    const icon = nativeImage.createFromPath(file).resize({ width: 96 })
    event.sender.startDrag({ file, icon })
  })
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    const preview = image.resize({ width: width * 2, height: height * 2 }).toDataURL()
    win.webContents.send('capture:image', preview)
    win.showInactive()
  })
  const load = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture.html`)
    : win.loadFile(path.join(__dirname, '../renderer/capture.html'))
  load.catch((error) => {
    console.error('Miniatura da captura não carregou:', error)
    if (!win.isDestroyed()) win.destroy()
  })
}

function capture() {
  if (busy) return
  busy = true
  thumbnail?.destroy()
  const file = tempFile()
  chooser = spawn('/usr/sbin/screencapture', ['-i', '-s', file], { stdio: 'ignore' })
  chooser.once('error', (error) => {
    console.error('Não foi possível iniciar a captura:', error)
    busy = false
    chooser = null
  })
  chooser.once('exit', (code) => {
    chooser = null
    busy = false
    if (code !== 0 || !existsSync(file) || statSync(file).size === 0) return
    showThumbnail(file)
  })
}

/** Três toques na tecla configurada em qualquer app do Mac iniciam uma seleção de tela. */
export function startScreenCapture(key: CaptureShortcutKey = 'shift') {
  if (process.platform !== 'darwin') return
  ipcMain.on('capture:close', (event) => {
    if (thumbnail && !thumbnail.isDestroyed() && event.sender === thumbnail.webContents) thumbnail.close()
  })
  setScreenCaptureShortcut(key)
}

export function setScreenCaptureShortcut(value: CaptureShortcutKey = 'shift') {
  if (process.platform !== 'darwin') return
  const key = Object.hasOwn(keyNames, value) ? value : 'shift'
  if (watcher && watchedKey === key) return
  const previous = watcher
  watcher = null
  previous?.kill()
  const binary = computerUseBinary()
  if (!binary) {
    console.warn('Atalho de captura indisponível: ajudante nativo não encontrado.')
    return
  }
  let buffer = ''
  const child = spawn(binary, ['--watch-capture-key', key], { stdio: ['ignore', 'pipe', 'pipe'] })
  watcher = child
  watchedKey = key
  child.stdout?.on('data', (chunk: Buffer) => {
    if (watcher !== child) return
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line === 'capture') capture()
  })
  child.stderr?.on('data', (chunk: Buffer) => console.warn('Atalho de captura:', chunk.toString().trim()))
  child.on('error', (error) => console.error('Atalho de captura falhou:', error))
  child.on('exit', (code) => {
    if (watcher !== child) return
    watcher = null
    if (code !== 2) return
    dialog.showMessageBox({
      type: 'info',
      title: 'Atalho de captura indisponível',
      message: `O macOS ainda não permite detectar os três toques em ${keyNames[key]}.`,
      detail: `Em Ajustes do Sistema > Privacidade e Segurança > Monitoração de Entrada, adicione e permita ${app.isPackaged ? 'o Ovseer' : binary}. Depois reinicie o Ovseer.`,
      buttons: ['Abrir ajustes', 'Agora não'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => response === 0
      ? shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
      : undefined
    ).catch((error) => console.error('Não foi possível mostrar a orientação do atalho:', error))
  })
}

export function stopScreenCapture() {
  watcher?.kill()
  watcher = null
  chooser?.kill()
  chooser = null
  thumbnail?.destroy()
  thumbnail = null
  if (captureDir) rmSync(captureDir, { recursive: true, force: true })
  captureDir = null
}
