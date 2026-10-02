import { BrowserWindow, Menu, clipboard, ipcMain, screen, type Display } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentChatOpen } from '../shared/types'
import { agentBase, openAgentWindow } from './agentChat'
import { getSettings, saveSettings } from './settings'

/**
 * Mascote: um personagem no topo da tela, ao lado do recorte da câmera (o "notch"), numa janelinha
 * transparente acima da barra de menus, com um pedaço preto que se emenda ao recorte. Os olhos seguem o
 * cursor (o processo principal manda a posição, que uma página não vê fora de si) e a cara mostra como os
 * agentes estão. A janelinha se abre como uma "ilha" abaixo do recorte, com o painel dos agentes; arrastar um
 * arquivo nela, ou clicar e colar, abre um agente com aquilo. Clique duplo traz o Ovseer.
 */

/**
 * Largura do recorte da câmera, estimada pela altura da barra de menus (o recorte tem a altura da barra e uns
 * 5,8× isso de largura; a proporção vale em qualquer escala de tela), com folga: sobrando, o preto se perde
 * no preto; faltando, o recorte cortaria o mascote.
 */
const NOTCH_RATIO = 5.8
const NOTCH_SLACK = 12
/** A ilha aberta (abaixo do recorte): o mascote grande à esquerda e o painel dos agentes à direita */
const OPEN = { width: 540, height: 184 }
/**
 * Consulta do cursor: 20 vezes por segundo enquanto ele se move (o suficiente para o olhar parecer contínuo) e
 * 5 por segundo quando está parado. A página só recebe quando o olhar mudaria de fato: perto, a cada pixel;
 * longe, só a direção importa, e o ponto vai arredondado a um passo que cresce com a distância.
 */
const CURSOR_MS_MOVING = 50
const CURSOR_MS_STILL = 200
const STILL_AFTER_MS = 1500

let win: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null
let lastSent = ''
let lastCursor = { x: 0, y: 0, at: 0 }
let showMain: (() => void) | null = null
let replaceTimer: NodeJS.Timeout | null = null
/** A ilha está aberta (a janela cresceu para baixo do recorte) */
let open = false

export function setupBuddy(o: { showMain: () => void }) {
  // só no Mac: é um truque com a barra de menus e o recorte da câmera, que não existem nos outros sistemas
  if (process.platform !== 'darwin') return
  showMain = o.showMain
  if (getSettings().buddy) showBuddy()
  // trocou de tela ou de resolução: o mascote se reposiciona no topo da tela do computador
  const replace = () => {
    if (replaceTimer) clearTimeout(replaceTimer)
    replaceTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        hideBuddy()
        showBuddy()
      }
    }, 400)
  }
  screen.on('display-metrics-changed', replace)
  screen.on('display-added', replace)
  screen.on('display-removed', replace)
}

/**
 * Onde o mascote fica: no topo da tela do próprio computador (a que tem a câmera), ocupando a altura da barra
 * de menus. Com recorte (barra alta, de 37 pt ou mais), o pedaço preto cobre o recorte com folga e o mascote
 * fica à direita dele; sem recorte, só uma cápsula pequena no centro.
 */
function layout(): { x: number; y: number; width: number; height: number; notch: number; r: number; br: number } {
  const displays = screen.getAllDisplays()
  const d: Display = displays.find((x) => x.internal) ?? screen.getPrimaryDisplay()
  const bar = Math.max(0, d.workArea.y - d.bounds.y) || 24
  const hasNotch = bar >= 30
  const notch = hasNotch ? Math.round(bar * NOTCH_RATIO) + NOTCH_SLACK : 0
  const r = hasNotch ? 13 : 9
  const br = hasNotch ? 7 : 5
  // de cada lado do recorte: folga, o corpo, o balão (do lado de fora, longe do recorte) e a margem do preto
  const width = notch + 2 * (6 + 2 * r + 2 + 2 * br + 8)
  return { x: Math.round(d.bounds.x + d.bounds.width / 2 - width / 2), y: d.bounds.y, width, height: bar, notch, r, br }
}

export function showBuddy() {
  if (win && !win.isDestroyed()) {
    win.show()
    return
  }
  const l = layout()
  const w = new BrowserWindow({
    x: l.x,
    y: l.y,
    width: l.width,
    height: l.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // não toma o foco: clicar nele não tira você do app em que está (a ilha aberta por clique é a exceção)
    focusable: false,
    title: 'Mascote',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win = w
  open = false
  // Acima da barra de menus (nível "status", 25, logo acima dela), em todas as mesas (inclusive sobre apps em tela
  // cheia). Não mais alto que isso: o macOS só entrega um arrasto de arquivo a janelas abaixo do nível da imagem
  // arrastada (500); no nível "screen-saver" o mouse chegava, mas o soltar não.
  w.setAlwaysOnTop(true, 'status')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.on('page-title-updated', (e) => e.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.once('ready-to-show', () => {
    if (w.isDestroyed()) return
    w.show()
    // a barra de menus é terreno do sistema: confere se a janela ficou mesmo no topo (senão, encosta de novo)
    w.setBounds({ x: l.x, y: l.y, width: l.width, height: l.height })
  })
  w.on('show', startCursor)
  w.on('hide', stopCursor)
  w.on('closed', () => {
    if (win === w) win = null
    open = false
    stopCursor()
  })
  // a ilha aberta por clique tem o foco (para o ⌘V); perdeu o foco, encolhe
  w.on('blur', () => open && expand(false))
  const query = { notch: String(l.notch), r: String(l.r), br: String(l.br), bar: String(l.height) }
  const load = () =>
    process.env.ELECTRON_RENDERER_URL
      ? w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/buddy.html?${new URLSearchParams(query)}`)
      : w.loadFile(path.join(__dirname, '../renderer/buddy.html'), { query })
  load().catch((e) => console.error('Mascote não carregou:', e))
}

export function hideBuddy() {
  if (win && !win.isDestroyed()) win.close()
  win = null
}

/** Liga ou desliga pela configuração */
export function setBuddyEnabled(on: boolean) {
  const next = saveSettings({ buddy: on })
  // a janela principal (o interruptor nas configurações) acompanha
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('settings:changed', next)
  if (on) showBuddy()
  else hideBuddy()
}

/**
 * Abre ou fecha a ilha: a janela cresce para baixo do recorte (com a animação de quadro do sistema) e a página
 * se reorganiza pelo tamanho novo. Aberta por clique, ela passa a aceitar o foco, para o ⌘V chegar; ao fechar,
 * volta a não tomar o foco de ninguém.
 */
function expand(on: boolean, focus = false) {
  if (!win || win.isDestroyed()) return
  const l = layout()
  open = on
  if (on) {
    win.setBounds({ x: Math.round(l.x + l.width / 2 - OPEN.width / 2), y: l.y, width: OPEN.width, height: OPEN.height }, true)
    if (focus) {
      win.setFocusable(true)
      win.focus()
    }
  } else {
    if (win.isFocused()) win.blur()
    win.setFocusable(false)
    win.setBounds({ x: l.x, y: l.y, width: l.width, height: l.height }, true)
  }
}

const mine = (sender: Electron.WebContents) => !!win && !win.isDestroyed() && win.webContents === sender

// ---------- cursor: a página recebe onde ele está em relação à janela ----------

function startCursor() {
  if (timer) return
  lastCursor = { ...screen.getCursorScreenPoint(), at: Date.now() }
  timer = setTimeout(tick, CURSOR_MS_MOVING)
}
function stopCursor() {
  if (timer) clearTimeout(timer)
  timer = null
}
function tick() {
  timer = null
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const c = screen.getCursorScreenPoint()
  const now = Date.now()
  if (c.x !== lastCursor.x || c.y !== lastCursor.y) lastCursor = { x: c.x, y: c.y, at: now }
  const b = win.getBounds()
  const rx = c.x - b.x
  const ry = c.y - b.y
  // passo do arredondamento: 1 px perto da janela, maior conforme a distância (longe, só a direção conta)
  const dist = Math.hypot(rx - b.width / 2, ry - b.height / 2)
  const step = Math.max(1, Math.round(dist / 60))
  const msg = `${Math.round(rx / step) * step},${Math.round(ry / step) * step}`
  if (msg !== lastSent) {
    lastSent = msg
    const [x, y] = msg.split(',').map(Number)
    win.webContents.send('buddy:cursor', { x, y })
  }
  timer = setTimeout(tick, now - lastCursor.at < STILL_AFTER_MS ? CURSOR_MS_MOVING : CURSOR_MS_STILL)
}

// ---------- o que o mascote come ----------

/** Abre um agente como o último usado, com os arquivos e o texto que o mascote recebeu */
async function feed(o: { files?: string[]; text?: string }) {
  const base = agentBase()
  const cwd = [getSettings().lastProject, base?.cwd].find((p) => p && existsSync(p))
  if (!cwd) {
    // sem projeto conhecido não há onde abrir o agente: traz o app, para o usuário abrir um
    showMain?.()
    return
  }
  const chat: AgentChatOpen = {
    provider: base?.provider ?? 'claude',
    model: base?.model ?? '',
    effort: base?.effort ?? 'medium',
    mode: 'full',
    cwd,
    firstMessage: o.text?.trim() || undefined,
    firstFiles: o.files?.filter((p) => existsSync(p))
  }
  if (!chat.firstMessage && !chat.firstFiles?.length) return
  await openAgentWindow(chat)
}

/** Imagem da área de transferência gravada num arquivo temporário (a janela do agente guarda uma cópia) */
function clipboardImageFile(): string | null {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  const dir = path.join(os.tmpdir(), 'ovseer-mascote')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `colado-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`)
  writeFileSync(file, img.toPNG())
  return file
}

export function registerBuddyIpc() {
  ipcMain.handle('buddy:files', (e, paths: unknown) => {
    if (!mine(e.sender)) return
    const files = Array.isArray(paths) ? paths.map(String).filter(Boolean).slice(0, 20) : []
    return feed({ files })
  })
  ipcMain.handle('buddy:paste', (e) => {
    if (!mine(e.sender)) return { ate: false }
    const image = clipboardImageFile()
    const text = image ? '' : clipboard.readText()
    if (!image && !text.trim()) return { ate: false }
    feed({ files: image ? [image] : [], text }).catch((err) => console.error('Mascote: colar falhou:', err))
    return { ate: true, kind: image ? 'image' : 'text' }
  })
  ipcMain.on('buddy:expand', (e, on: boolean) => {
    if (mine(e.sender)) expand(!!on)
  })
  ipcMain.on('buddy:focus', (e) => {
    if (mine(e.sender)) expand(true, true)
  })
  ipcMain.on('buddy:openMain', (e) => {
    if (mine(e.sender)) showMain?.()
  })
  ipcMain.on('buddy:menu', (e) => {
    if (!mine(e.sender) || !win) return
    Menu.buildFromTemplate([
      { label: 'Abrir o Ovseer', click: () => showMain?.() },
      { type: 'separator' },
      { label: 'Esconder o mascote', click: () => setBuddyEnabled(false) }
    ]).popup({ window: win })
  })
  ipcMain.handle('buddy:set', (_e, on: boolean) => setBuddyEnabled(!!on))
}
