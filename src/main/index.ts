import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, systemPreferences,
  type MenuItemConstructorOptions
} from 'electron'
import { findTheme } from '../shared/themes'
import { cpSync, existsSync, mkdirSync, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import icon from '../../build/icon.png?asset'
import type {
  ProjectOverview, TaskHint, AgentAttachment, AgentChatOpen, AgentSendOptions, AgentTurn, GridPlacement, GridSize,
  AgentAction, AgentSnapshot, AgentStatus, Analysis, AuthProvider, CliProvider, FileChange, OvseerDeliveryInput, OvseerNewTask, Settings, TerminalSpec
} from '../shared/types'
import { findBinary, runCli } from './cli'
import { findFavicon } from './favicon'
import { findPullRequest, publishInfo, publishToGitHub } from './github'
import * as ovseer from './ovseer'
import * as safety from './safety'
import * as branches from './branches'
import * as pr from './pullRequest'
import * as assist from './assist'
import * as clone from './clone'
import * as sshImport from './sshImport'
import * as agentWatch from './agentWatch'
import * as agentChat from './agentChat'
import * as agentHistory from './agentHistory'
import type { DesignAction, DesignWindowState } from '../shared/architect'
import { getUsage } from './usage'
import { getCliUpdates, installCli, updateCli } from './cliUpdates'
import { commitWithHunks } from './partial'
import { adoptTerminal, createTerminal, killAllTerminals, killTerminal, listSshKeys, resizeTerminal, setTerminalMeta, terminalMeta, writeTerminal } from './terminal'
import type { ConflictChoice } from './git'
import { analysisHash, analyze, taskContext, cancelAnalysis, commitMessage, detectProviders, listModels } from './ai'
import { clearAnalysis, loadAnalysis, saveAnalysis } from './analysisStore'
import { agyStatus, authStatus, cancelLogin, logout, sendCode, startLogin } from './auth'
import * as g from './git'
import { createSourceFile, listSourceFiles, readSourceFile, readSourceImage, writeSourceFile } from './sourceFiles'
import { getSettings, rememberProject, saveSettings } from './settings'
import * as updater from './updater'
import * as aws from './aws'
import * as services from './services'

let win: BrowserWindow | null = null
let root: string | null = null

/** Operações que escrevem no repositório rodam uma de cada vez (evita conflito de index.lock). */
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

function requireRoot(): string {
  if (!root) throw new Error('Nenhum projeto aberto.')
  return root
}

async function load(dir: string) {
  const r = await g.findRoot(dir)
  root = r
  rememberProject(r)
  win?.setTitle(`Ovseer — ${path.basename(r)}`)
  return g.status(r)
}

/** Abre o projeto no VS Code (ou Cursor), útil para resolver conflitos; senão, na pasta do sistema. */
async function openInEditor(dir: string): Promise<string> {
  for (const name of ['code', 'cursor']) {
    const bin = await findBinary(name)
    if (bin) {
      runCli(bin, [dir], '', dir, 15_000).catch(() => undefined)
      return name === 'code' ? 'VS Code' : 'Cursor'
    }
  }
  if (process.platform === 'darwin') {
    for (const appName of ['Visual Studio Code', 'Cursor']) {
      if (existsSync(`/Applications/${appName}.app`)) {
        runCli('open', ['-a', appName, dir], '', dir, 15_000).catch(() => undefined)
        return appName
      }
    }
  }
  await shell.openPath(dir)
  return process.platform === 'darwin' ? 'Finder' : 'Explorer'
}

/** Cor de fundo inicial da janela (evita um flash de cor errada antes do tema carregar). */
function initialBackground(): string {
  const theme = findTheme(getSettings().theme)
  if (theme.colors) return theme.colors.bg
  if (!nativeTheme.shouldUseDarkColors) return '#f6f5f8'
  return process.platform === 'win32' ? '#202020' : '#1e1e1e'
}

/** Manda para a janela principal, se ela ainda existir (as janelas de agente mantêm o app vivo sem ela). */
function toMain(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Liga o acompanhamento dos agentes abertos pelo Ovseer e repassa para a janela. */
function startAgents() {
  agentWatch.startAgentWatch({
    onUpdate: (list) => toMain('agents:update', list),
    onFinished: (s) => toMain('agents:finished', s),
    // só as conversas do próprio app: as que têm janela aberta ou estão no histórico dele
    isOwn: (id) => agentChat.agentWindows().includes(id) || !!agentHistory.findHistory(id)
  })
}

function createWindow() {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 450,
    minHeight: 560,
    title: 'Ovseer',
    icon,
    show: false,
    backgroundColor: initialBackground(),
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#a9a3b8', height: 48 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // bloqueia navegação para fora, mas deixa a própria página recarregar (o servidor de desenvolvimento pede
  // recarga completa quando uma atualização a quente falha; sem isso a janela ficava com código antigo)
  const wc = win.webContents
  wc.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== wc.getURL().split('#')[0]) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const send = (ch: string) => () => {
    if (!win || win.isDestroyed()) createWindow()
    else toMain('menu', ch)
  }
  // novo agente igual ao último (vale também com uma janela de agente em foco); sem base, abre o diálogo
  const newAgent = () => {
    agentChat
      .openAgentLikeLast(BrowserWindow.getFocusedWindow(), root)
      .then((opened) => opened || send('newAgent')())
      .catch((e) => {
        console.error('Novo agente pelo atalho falhou:', e)
        send('newAgent')()
      })
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Trocar projeto…', accelerator: 'CmdOrCtrl+P', click: send('switch') },
        { label: 'Abrir pasta…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Atualizar', accelerator: 'CmdOrCtrl+R', click: send('refresh') },
        { type: 'separator' },
        { label: 'Novo agente', accelerator: 'CmdOrCtrl+Shift+N', click: newAgent },
        { type: 'separator' },
        { label: 'Configurações…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Sair' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Git',
      submenu: [
        { label: 'Analisar com IA', accelerator: 'CmdOrCtrl+I', click: send('analyze') },
        { label: 'Commit', accelerator: 'CmdOrCtrl+Enter', click: send('commit') },
        { label: 'Criar Feature…', accelerator: 'CmdOrCtrl+Shift+F', click: send('feature') },
        { label: 'Baixar (pull)', accelerator: 'CmdOrCtrl+Shift+L', click: send('pull') },
        { label: 'Enviar (push)', accelerator: 'CmdOrCtrl+Shift+P', click: send('push') }
      ]
    },
    {
      role: 'viewMenu',
      submenu: [
        { label: 'Diff', accelerator: 'CmdOrCtrl+D', click: send('toggleDiff') },
        { label: 'Terminal', accelerator: 'Ctrl+`', click: send('toggleTerminal') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Janelas de terminal desacoplado, por sessão (guardadas: uma BrowserWindow sem referência é coletada e fecha) */
const terminalWindows = new Map<number, BrowserWindow>()
/** Janela própria de um terminal desacoplado do painel */
function openTerminalWindow(id: number) {
  const meta = terminalMeta(id)
  const w = new BrowserWindow({
    width: 900,
    height: 560,
    minWidth: 480,
    minHeight: 280,
    title: `${meta?.title || 'Terminal'} · Terminal`,
    icon,
    show: false,
    backgroundColor: initialBackground(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  terminalWindows.set(id, w)
  w.on('closed', () => terminalWindows.delete(id))
  w.once('ready-to-show', () => w.show())
  w.on('page-title-updated', (e) => e.preventDefault())
  const load = () =>
    process.env.ELECTRON_RENDERER_URL
      ? w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/terminal.html?id=${id}`)
      : w.loadFile(path.join(__dirname, '../renderer/terminal.html'), { query: { id: String(id) } })
  load().catch((e) => console.error('Janela do terminal não carregou:', e))
}

function registerIpc() {
  ipcMain.handle('project:open', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Abrir projeto Git',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return load(res.filePaths[0])
  })
  ipcMain.handle('project:load', (_e, dir: string) => load(dir))
  ipcMain.handle('clone:repos', () => clone.listGithubRepos())
  ipcMain.handle('clone:defaults', () => ({ parent: clone.suggestedParent(getSettings().recentProjects) }))
  ipcMain.handle('dialog:pickFolder', async (_e, defaultPath: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Escolher pasta de destino',
      defaultPath: String(defaultPath || os.homedir()),
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('clone:run', async (e, url: string, parent: string, name: string) => {
    const dir = await clone.cloneRepo(String(url), String(parent), String(name), (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('clone:progress', p)
    })
    return load(dir)
  })
  ipcMain.handle('clone:cancel', () => clone.cancelClone())
  ipcMain.handle('term:create', (e, cols: number, rows: number, spec?: TerminalSpec) => {
    if (spec?.kind === 'ssh') {
      const conn = getSettings().sshConnections.find((c) => c.id === spec.connectionId)
      if (!conn) throw new Error('Conexão SSH não encontrada.')
      return createTerminal(e.sender, os.homedir(), cols, rows, conn)
    }
    // terminal fixado abre na pasta dele; se ela não existe mais, cai na do projeto
    const own = spec?.kind === 'local' && typeof spec.cwd === 'string' && existsSync(spec.cwd) ? spec.cwd : null
    return createTerminal(e.sender, own ?? root ?? os.homedir(), cols, rows)
  })
  // desacoplar: a aba vira uma janela própria (a sessão continua a mesma); acoplar: volta ao painel
  ipcMain.handle('term:detach', (_e, id: number, meta: { title: string; spec: TerminalSpec; cwd?: string }) => {
    setTerminalMeta(Number(id), { title: String(meta?.title ?? ''), spec: meta?.spec, cwd: meta?.cwd })
    openTerminalWindow(Number(id))
  })
  ipcMain.handle('term:adopt', (e, id: number, cols: number, rows: number) => adoptTerminal(Number(id), e.sender, Number(cols) || 0, Number(rows) || 0))
  ipcMain.handle('term:meta', (_e, id: number) => terminalMeta(Number(id)))
  ipcMain.handle('term:reattach', (e, id: number) => {
    const meta = terminalMeta(Number(id))
    if (!meta || !win || win.isDestroyed()) return false
    win.webContents.send('term:attach', Number(id), meta)
    win.show()
    win.focus()
    const from = BrowserWindow.fromWebContents(e.sender)
    // a janela desacoplada fecha depois que o painel adotar a sessão (senão o fechamento mataria o terminal)
    setTimeout(() => from && !from.isDestroyed() && from.close(), 400)
    return true
  })
  ipcMain.handle('ssh:listKeys', () => listSshKeys())
  ipcMain.handle('ssh:importConfig', () => sshImport.readSshConfig())
  ipcMain.handle('ssh:importCsv', (_e, text: string) => sshImport.parseCsv(String(text ?? '').slice(0, 2_000_000)))
  ipcMain.handle('dialog:pickText', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Escolher arquivo CSV/TSV',
      properties: ['openFile'],
      filters: [{ name: 'Planilha', extensions: ['csv', 'tsv', 'txt'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const { readFileSync, statSync } = await import('node:fs')
    if (statSync(res.filePaths[0]).size > 2_000_000) throw new Error('Arquivo grande demais.')
    return readFileSync(res.filePaths[0], 'utf8')
  })
  ipcMain.handle('ssh:pickKey', async () => {
    const sshDir = path.join(os.homedir(), '.ssh')
    const res = await dialog.showOpenDialog(win!, {
      title: 'Escolher chave privada SSH',
      defaultPath: existsSync(sshDir) ? sshDir : os.homedir(),
      properties: ['openFile', 'showHiddenFiles']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.on('term:write', (_e, id: number, data: string) => writeTerminal(id, String(data)))
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.handle('term:kill', (_e, id: number) => killTerminal(id))
  ipcMain.handle('project:icon', (_e, dir: string) => findFavicon(String(dir)))
  ipcMain.handle('git:status', () => (root ? g.status(root) : null))
  ipcMain.handle('git:diff', (_e, f: FileChange) => g.diff(requireRoot(), f))
  ipcMain.handle('src:list', () => listSourceFiles(requireRoot()))
  ipcMain.handle('src:create', (_e, rel: string, content: string) => createSourceFile(requireRoot(), String(rel), String(content ?? '')))
  ipcMain.handle('src:image', (_e, rel: string) => readSourceImage(requireRoot(), String(rel)))
  ipcMain.handle('src:read', (_e, rel: string) => readSourceFile(requireRoot(), String(rel)))
  ipcMain.handle('src:write', (_e, rel: string, content: string, mtime?: number) =>
    writeSourceFile(requireRoot(), String(rel), String(content), typeof mtime === 'number' ? mtime : undefined)
  )
  ipcMain.handle('git:log', (_e, limit?: number) => g.log(requireRoot(), limit))
  ipcMain.handle('safe:discard', (_e, files: string[]) => exclusive(() => safety.discard(requireRoot(), files.map(String))))
  ipcMain.handle('safe:undo', () => exclusive(() => safety.undoLastCommit(requireRoot())))
  ipcMain.handle('safe:editMessage', (_e, msg: string) => exclusive(() => safety.editLastMessage(requireRoot(), String(msg))))
  ipcMain.handle('safe:list', () => safety.savedChanges(requireRoot()))
  ipcMain.handle('branch:list', () => branches.listBranches(requireRoot()))
  ipcMain.handle('assist:check', (_e, files: string[]) => assist.quickCheck(requireRoot(), files.map(String)))
  ipcMain.handle('assist:review', async (_e, files: string[]) => {
    const r = requireRoot()
    const wanted = new Set(files.map(String))
    const sel = (await g.status(r)).files.filter((f) => wanted.has(f.path))
    return assist.aiReview(r, await g.aiContext(r, sel, 16000))
  })
  ipcMain.handle('assist:explain', (_e, hash: string) => assist.explainCommit(requireRoot(), String(hash)))
  ipcMain.handle('assist:propose', (_e, file: string) => assist.proposeResolution(requireRoot(), String(file)))
  ipcMain.handle('assist:apply', (_e, file: string, content: string) =>
    exclusive(() => assist.applyResolution(requireRoot(), String(file), String(content)))
  )
  ipcMain.handle('assist:delivery', (_e, plan: string, commits: string[]) =>
    assist.deliveryReport(String(plan ?? ''), (commits ?? []).map(String))
  )
  ipcMain.handle('pr:current', () => (root ? pr.currentPullRequest(root).catch(() => null) : null))
  ipcMain.handle('pr:draft', (_e, taskInfo: string | null) => pr.draftPullRequest(requireRoot(), taskInfo ? String(taskInfo).slice(0, 500) : null))
  ipcMain.handle('pr:create', (_e, input: { title: string; body: string; base: string; draft: boolean }) =>
    exclusive(() =>
      pr.createPullRequest(requireRoot(), {
        title: String(input?.title ?? '').slice(0, 250),
        body: String(input?.body ?? '').slice(0, 60000),
        base: String(input?.base ?? 'main'),
        draft: !!input?.draft
      })
    )
  )
  ipcMain.handle('pr:merge', (_e, method: string) => exclusive(() => pr.mergePullRequest(requireRoot(), method === 'squash' ? 'squash' : 'merge')))
  ipcMain.handle('branch:switch', (_e, name: string, mode: string) =>
    exclusive(() => branches.switchBranch(requireRoot(), String(name), mode === 'stash' ? 'stash' : 'carry'))
  )
  ipcMain.handle('branch:create', (_e, name: string) => exclusive(() => branches.createBranch(requireRoot(), String(name))))
  ipcMain.handle('branch:cleanup', () => branches.cleanupCandidates(requireRoot()))
  ipcMain.handle('branch:delete', (_e, names: string[]) => exclusive(() => branches.deleteBranches(requireRoot(), names.map(String))))
  ipcMain.handle('safe:restore', (_e, ref: string) => exclusive(() => safety.restoreSaved(requireRoot(), String(ref))))
  ipcMain.handle('safe:drop', (_e, ref: string) => exclusive(() => safety.dropSaved(requireRoot(), String(ref))))
  ipcMain.handle('git:commit', (_e, files: string[], msg: string) => exclusive(() => g.commit(requireRoot(), files, msg)))
  ipcMain.handle('git:commitPartial', (_e, full: string[], partial: { path: string; hunks: number[] }[], msg: string) =>
    exclusive(() =>
      commitWithHunks(
        requireRoot(),
        full.map(String),
        partial.map((p) => ({ path: String(p.path), hunks: (p.hunks ?? []).map(Number).filter(Number.isInteger) })),
        String(msg)
      )
    )
  )
  ipcMain.handle('git:commitGroups', (_e, groups: { files: string[]; message: string }[]) =>
    exclusive(() => g.commitGroups(requireRoot(), groups))
  )
  ipcMain.handle('git:pull', (_e, stash: boolean) => exclusive(() => g.pull(requireRoot(), stash)))
  ipcMain.handle('git:push', () => exclusive(() => g.push(requireRoot())))
  ipcMain.handle('git:publishInfo', () => publishInfo(requireRoot()))
  ipcMain.handle('git:publishUrl', (_e, url: string) => exclusive(() => g.publishToUrl(requireRoot(), String(url))))
  ipcMain.handle('git:publishGitHub', (_e, name: string, isPrivate: boolean) =>
    exclusive(() => publishToGitHub(requireRoot(), String(name), !!isPrivate))
  )
  ipcMain.handle('git:featurePreview', () => g.featurePreview(requireRoot()))
  ipcMain.handle('git:createFeature', (_e, name: string, prefix?: string) =>
    exclusive(() => g.createFeature(requireRoot(), String(name), typeof prefix === 'string' ? prefix : 'feature'))
  )
  ipcMain.handle('ai:analyze', async (_e, force?: boolean, tasks?: TaskHint[]) => {
    const r = requireRoot()
    const st = await g.status(r)
    const context = taskContext(tasks) + (await g.aiContext(r, st.files))
    const saved = loadAnalysis(r)
    const { hash, ...result } = await analyze(getSettings(), st.files, context, { cached: saved, force })
    if (result.source === 'ai') saveAnalysis(r, result, hash)
    return result
  })
  ipcMain.handle('ai:cancel', () => cancelAnalysis())
  ipcMain.handle('ai:message', async (_e, paths: string[]) => {
    const r = requireRoot()
    const wanted = new Set(paths)
    const files = (await g.status(r)).files.filter((f) => wanted.has(f.path))
    if (!files.length) throw new Error('Selecione ao menos um arquivo.')
    return commitMessage(getSettings(), await g.aiContext(r, files, 10000))
  })
  ipcMain.handle('analysis:get', async () => {
    const r = root
    const saved = r ? loadAnalysis(r) : null
    if (!r || !saved || !saved.analysis.groups.length) return null
    const st = await g.status(r)
    const stale = analysisHash(getSettings(), await g.aiContext(r, st.files)) !== saved.hash
    return { analysis: saved.analysis, stale }
  })
  ipcMain.handle('analysis:clear', () => {
    if (root) clearAnalysis(root)
  })
  ipcMain.handle('analysis:save', (_e, a: Analysis) => {
    if (root) saveAnalysis(root, a)
  })
  ipcMain.handle('git:resolve', (_e, file: string, choice: ConflictChoice) =>
    exclusive(() => g.resolveConflict(requireRoot(), String(file), choice))
  )
  ipcMain.handle('git:abort', () => exclusive(() => g.abortOperation(requireRoot())))
  ipcMain.handle('git:continue', () => exclusive(() => g.continueOperation(requireRoot())))
  ipcMain.handle('editor:open', () => openInEditor(requireRoot()))
  ipcMain.handle('ai:models', () => listModels(getSettings()))
  ipcMain.handle('ai:detect', () => detectProviders(getSettings()))
  ipcMain.handle('auth:status', (_e, p: CliProvider) => (p === 'agy' ? agyStatus() : authStatus(authProvider(p))))
  ipcMain.handle('auth:login', (e, p: AuthProvider) =>
    startLogin(authProvider(p), (ev) => {
      if (!e.sender.isDestroyed()) e.sender.send('auth:event', ev)
    })
  )
  ipcMain.handle('auth:code', (_e, code: string) => sendCode(String(code)))
  ipcMain.handle('auth:cancel', () => cancelLogin())
  ipcMain.handle('auth:logout', (_e, p: AuthProvider) => logout(authProvider(p)))
  ipcMain.on('window:theme', (e, background: string, symbols: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || !/^#[0-9a-f]{6}$/i.test(background)) return
    w.setBackgroundColor(background)
    if (process.platform !== 'darwin' && /^#[0-9a-f]{6}$/i.test(symbols))
      w.setTitleBarOverlay({ color: '#00000000', symbolColor: symbols, height: 48 })
  })
  // arrasto manual da janela: regiões que precisam receber cliques (o título, renomeado com clique duplo)
  // não podem ser `-webkit-app-region: drag`, então a página manda os deslocamentos do mouse
  const dragOrigin = new WeakMap<BrowserWindow, [number, number]>()
  ipcMain.on('window:drag', (e, dx: number, dy: number, begin: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isFullScreen() || w.isMaximized()) return
    if (begin) return void dragOrigin.set(w, w.getPosition() as [number, number])
    const o = dragOrigin.get(w)
    if (o && Number.isFinite(dx) && Number.isFinite(dy)) w.setPosition(Math.round(o[0] + dx), Math.round(o[1] + dy))
  })
  ipcMain.handle('ovseer:status', () => ovseer.status())
  ipcMain.handle('ovseer:login', () => ovseer.login())
  ipcMain.handle('ovseer:cancelLogin', () => ovseer.cancelLogin())
  ipcMain.handle('ovseer:logout', () => {
    ovseer.stopStream()
    return ovseer.logout()
  })
  ipcMain.handle('ovseer:members', (_e, workspaceId: string) => ovseer.members(String(workspaceId)))
  ipcMain.handle('ovseer:createTask', (_e, input: OvseerNewTask) => ovseer.createTask({
    workspaceId: String(input?.workspaceId ?? ''),
    title: String(input?.title ?? '').slice(0, 300),
    plan: String(input?.plan ?? '').slice(0, 20000),
    ownerId: String(input?.ownerId ?? ''),
    priority: (['low', 'medium', 'high', 'urgent'] as const).includes(input?.priority) ? input.priority : 'medium',
    dueDate: typeof input?.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : null
  }))
  ipcMain.handle(
    'ovseer:upload',
    (_e, taskId: string, file: { name: string; type: string; data: ArrayBuffer }, purpose?: string) =>
      ovseer.uploadAttachment(
        String(taskId),
        { name: String(file?.name ?? 'arquivo').slice(0, 255), type: String(file?.type ?? ''), data: new Uint8Array(file.data) },
        purpose === 'plan_audio' ? 'plan_audio' : undefined
      )
  )
  ipcMain.handle('media:microphone', async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.handle('ovseer:delivery', async (_e, taskId: string) => {
    const [d, pr] = await Promise.all([
      ovseer.delivery(String(taskId)),
      root ? findPullRequest(root).catch(() => null) : Promise.resolve(null)
    ])
    return { commits: d.commits, pullRequestUrl: pr, plan: d.plan ?? '' }
  })
  ipcMain.handle('ovseer:submitDelivery', (_e, taskId: string, input: OvseerDeliveryInput) =>
    ovseer.submitDelivery(String(taskId), {
      adherence: input?.adherence === 'changed' ? 'changed' : 'as_planned',
      summary: typeof input?.summary === 'string' ? input.summary.slice(0, 20000) : undefined,
      commitUrl: typeof input?.commitUrl === 'string' ? input.commitUrl : undefined,
      commitEventId: typeof input?.commitEventId === 'string' ? input.commitEventId : undefined,
      pullRequestUrl: typeof input?.pullRequestUrl === 'string' ? input.pullRequestUrl : undefined
    })
  )
  ipcMain.handle('ovseer:task', (_e, id: string) => ovseer.taskDetail(String(id)))
  ipcMain.handle('ovseer:setStatus', (_e, id: string, status: string, ack: boolean) =>
    ovseer.setTaskStatus(String(id), status === 'paused' ? 'paused' : status === 'blocked' ? 'blocked' : 'doing', !!ack)
  )
  ipcMain.handle('ovseer:attachmentUrl', async (_e, id: string, index: number) => {
    const url = await ovseer.attachmentUrl(String(id), Number(index))
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return url
  })
  ipcMain.handle('ovseer:approvalAudioUrl', (_e, id: string) => ovseer.approvalAudioUrl(String(id)))
  ipcMain.handle('ovseer:comments', (_e, id: string) => ovseer.taskComments(String(id)))
  ipcMain.handle('task:branch', (_e, key: string, title: string) =>
    exclusive(() => branches.startTaskBranch(requireRoot(), String(key), String(title), getSettings().branchPrefix || 'feature'))
  )
  ipcMain.handle('ovseer:live', (e, on: boolean) => {
    if (!on) return ovseer.stopStream()
    const send = (ch: string, ...args: unknown[]) => {
      if (!e.sender.isDestroyed()) e.sender.send(ch, ...args)
    }
    ovseer.startStream({ onChange: () => send('ovseer:changed'), onLive: (live) => send('ovseer:liveState', live) })
  })
  ipcMain.handle('ovseer:tasks', (_e, workspaceId: string) => ovseer.tasks(String(workspaceId)))
  ipcMain.handle('ovseer:link', async (_e, workspaceId: string, links: { taskId: string; sha: string; message: string }[]) => {
    const r = requireRoot()
    const info = await g.commitsForLink(r, links.map((l) => l.sha))
    return ovseer.linkCommits({
      workspaceId: String(workspaceId),
      repo: info.repo,
      branch: info.branch,
      commits: links.map((l) => ({ taskId: String(l.taskId), sha: l.sha, message: l.message, ...info.commit(l.sha) }))
    })
  })
  ipcMain.handle('agents:list', () => agentWatch.listAgents())
  const provider = (p: unknown): CliProvider => {
    if (p !== 'claude' && p !== 'codex' && p !== 'agy') throw new Error('Provedor inválido.')
    return p
  }
  const authProvider = (p: unknown): AuthProvider => {
    if (p !== 'claude' && p !== 'codex') throw new Error('Provedor inválido.')
    return p
  }
  ipcMain.handle('projects:overview', (_e, roots: string[]) =>
    Promise.all(
      roots.slice(0, 30).map(async (root): Promise<ProjectOverview> => {
        try {
          const s = await g.status(root)
          return {
            root, ok: true, branch: s.branch, changes: s.files.length, ahead: s.ahead, behind: s.behind,
            published: s.published, unpublished: s.unpublished, operation: !!s.operation, conflicts: s.conflicts
          }
        } catch {
          return { root, ok: false, branch: null, changes: 0, ahead: 0, behind: 0, published: false, unpublished: 0, operation: false, conflicts: 0 }
        }
      })
    )
  )
  ipcMain.handle('agents:enable', (_e, on: boolean) => {
    saveSettings({ watchAgents: !!on })
    if (on) startAgents()
    else agentWatch.stopAgentWatch()
  })
  // janela exclusiva de um agente de IA (Claude Code / Codex)
  ipcMain.handle('agent:open', (_e, opts: AgentChatOpen) => {
    const cwd = typeof opts?.cwd === 'string' && opts.cwd ? opts.cwd : requireRoot()
    if (!existsSync(cwd)) throw new Error('Pasta do projeto não encontrada.')
    return agentChat.openAgentWindow({
      provider: provider(opts?.provider),
      model: String(opts?.model ?? '').slice(0, 80),
      effort: opts?.effort,
      mode: agentChat.normalizeMode(opts?.mode),
      cwd,
      extraDirs: Array.isArray(opts?.extraDirs) ? opts.extraDirs.map(String).filter((d) => d !== cwd && existsSync(d)).slice(0, 12) : undefined,
      firstMessage: typeof opts?.firstMessage === 'string' ? opts.firstMessage.slice(0, 50000) : undefined,
      resumeId: typeof opts?.resumeId === 'string' && /^[\w-]{8,80}$/.test(opts.resumeId) ? opts.resumeId : undefined
    })
  })
  ipcMain.handle('agent:info', (_e, uid: string) => agentChat.agentInfo(String(uid)))
  ipcMain.handle('agent:send', (_e, uid: string, text: string, opts: AgentSendOptions, attachments?: AgentAttachment[]) =>
    agentChat.sendToAgent(
      String(uid),
      String(text ?? '').slice(0, 200000),
      {
        model: String(opts?.model ?? ''),
        effort: opts?.effort,
        mode: agentChat.normalizeMode(opts?.mode),
        provider: opts?.provider === 'claude' || opts?.provider === 'codex' || opts?.provider === 'agy' ? opts.provider : undefined
      },
      (Array.isArray(attachments) ? attachments : []).slice(0, 20).map((a) => agentChat.describeFile(String(a?.path ?? '')))
    )
  )
  ipcMain.handle('agent:pick', async (e, uid: string) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Anexar arquivos',
      defaultPath: agentChat.agentInfo(String(uid))?.cwd,
      properties: ['openFile', 'multiSelections']
    }
    const res = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths.slice(0, 20).map((p) => agentChat.describeFile(p))
  })
  ipcMain.handle('agent:blob', (_e, uid: string, file: { name: string; type: string; data: ArrayBuffer }) =>
    agentChat.saveBlob(String(uid), String(file?.name ?? 'arquivo').slice(0, 120), String(file?.type ?? ''), new Uint8Array(file.data))
  )
  ipcMain.handle('agent:keepFile', (_e, uid: string, p: string) => agentChat.keepFile(String(uid), String(p)))
  ipcMain.handle('agent:image', (_e, p: string) => agentChat.attachmentImage(String(p)))
  ipcMain.handle('agent:cancel', (_e, uid: string) => agentChat.cancelAgent(String(uid)))
  ipcMain.handle('agent:new', (_e, uid: string) => agentChat.newChat(String(uid)))
  ipcMain.handle('agent:back', (_e, uid: string) => agentChat.backToPreviousChat(String(uid)))
  ipcMain.handle('agent:steer', (_e, uid: string, text: string, attachments?: AgentAttachment[]) =>
    agentChat.steerAgent(String(uid), String(text ?? ''), Array.isArray(attachments) ? attachments : [])
  )
  ipcMain.handle('agent:history', (_e, cwd?: string) => agentHistory.listHistory(typeof cwd === 'string' && cwd ? cwd : undefined))
  ipcMain.handle('agent:saveTranscript', (_e, uid: string, turns: AgentTurn[]) => {
    const info = agentChat.agentInfo(String(uid))
    if (info && Array.isArray(turns)) agentHistory.saveTranscript(info, turns, agentChat.agentStatus(String(uid)))
  })
  ipcMain.handle('agent:loadTranscript', (_e, sessionId: string) => agentHistory.loadTranscript(String(sessionId)))
  ipcMain.handle('agent:fileRepos', (_e, uid: string, paths: string[]) =>
    agentChat.agentFileRepos(String(uid), Array.isArray(paths) ? paths.map(String) : [])
  )
  ipcMain.handle('agent:forget', (_e, sessionId: string) => agentHistory.forget(String(sessionId)))
  ipcMain.handle('agent:pin', (_e, sessionId: string, pinned: boolean) => agentHistory.setHistoryPinned(String(sessionId), !!pinned))
  ipcMain.handle('agent:setTitle', (_e, uid: string, title: string) => agentChat.setTitle(String(uid), String(title ?? '').slice(0, 120)))
  // conceito visual do Modo Arquiteto: pedido à parte da conversa, possivelmente em outra IA
  ipcMain.handle('design:run', (_e, uid: string, o: agentChat.DesignRunOptions) =>
    agentChat.runDesign(String(uid), {
      provider: provider(o?.provider),
      model: String(o?.model ?? '').slice(0, 80),
      effort: o?.effort,
      prompt: String(o?.prompt ?? ''),
      attachments: Array.isArray(o?.attachments) ? o.attachments.slice(0, 20) : []
    })
  )
  ipcMain.handle('design:open', (_e, uid: string) => agentChat.openDesignWindow(String(uid)))
  ipcMain.on('design:push', (_e, uid: string, state: DesignWindowState) => agentChat.pushDesignState(String(uid), state))
  ipcMain.handle('design:state', (_e, uid: string) => agentChat.designState(String(uid)))
  ipcMain.handle('design:act', (_e, uid: string, action: DesignAction) => agentChat.actOnDesign(String(uid), action))
  ipcMain.handle('design:cancel', (_e, uid: string) => agentChat.cancelDesign(String(uid)))
  ipcMain.handle('design:save', (_e, uid: string, html: string, name: string) => agentChat.saveDesign(String(uid), String(html ?? ''), String(name ?? 'conceito.html')))
  ipcMain.handle('agent:setCwd', (_e, uid: string, cwd: string) => agentChat.setCwd(String(uid), String(cwd ?? '')))
  ipcMain.handle('agent:setExtraDirs', (_e, uid: string, dirs: string[]) => agentChat.setExtraDirs(String(uid), Array.isArray(dirs) ? dirs.map(String) : []))
  // repositórios recentes (os do seletor de projeto) para a janela do agente trocar de pasta antes de começar
  ipcMain.handle('agent:projects', () => getSettings().recentProjects.filter((p) => existsSync(p)))
  ipcMain.handle('agent:pickCwd', async (e, uid: string) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Escolher o repositório do agente',
      defaultPath: agentChat.agentInfo(String(uid))?.cwd,
      properties: ['openDirectory']
    }
    const res = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('agent:focus', (_e, sessionId: string) => agentChat.focusAgentWindow(String(sessionId)))
  ipcMain.handle('agent:windows', () => agentChat.agentWindows())
  ipcMain.on('agent:status', (_e, uid: string, status: AgentStatus) => agentChat.reportStatus(String(uid), status))
  ipcMain.handle('agent:statuses', () => agentChat.agentStatuses())
  ipcMain.on('agent:snapshot', (_e, uid: string, snap: AgentSnapshot) => agentChat.reportSnapshot(String(uid), snap))
  ipcMain.handle('agent:snapshots', () => agentChat.agentSnapshots())
  ipcMain.handle('agent:act', (_e, uid: string, action: AgentAction) => agentChat.actOnAgent(String(uid), action))
  ipcMain.handle('agent:show', (_e, uid: string) => agentChat.showAgentWindow(String(uid)))
  ipcMain.handle('agent:close', (_e, uids: string[]) => agentChat.closeAgentWindows(Array.isArray(uids) ? uids.map(String) : []))
  ipcMain.handle('agent:arrange', () => agentChat.arrangeAgentWindows())
  ipcMain.handle('agent:daySummary', () => agentHistory.daySummary(agentChat.openSessionIds()))
  ipcMain.handle('agent:place', (_e, uid: string, p: GridPlacement) => agentChat.placeAgentWindow(String(uid), p))
  // uid vazio: pelo gerenciador, na tela da janela principal
  ipcMain.handle('agent:regrid', (e, uid: string, from: GridSize, to: GridSize) =>
    agentChat.regridAgentWindows(String(uid ?? ''), from, to, BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.handle('agent:gridCells', (e, uid: string, grid: GridSize) => agentChat.agentGridCells(String(uid ?? ''), grid, BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('agents:models', async () => {
    await agentWatch.refreshAgyCatalog(findBinary, async (bin, args) => (await runCli(bin, args, '', os.tmpdir(), 30_000)).stdout)
    return agentWatch.knownModels()
  })
  ipcMain.handle('usage:get', (_e, force?: boolean) => getUsage(!!force))
  ipcMain.handle('cli:updates', (_e, force?: boolean) => getCliUpdates(!!force))
  ipcMain.handle('cli:update', (_e, id: CliProvider) => {
    if (id !== 'claude' && id !== 'codex' && id !== 'agy') throw new Error('CLI desconhecido.')
    return updateCli(id)
  })
  ipcMain.handle('cli:install', (_e, id: CliProvider) => {
    if (id !== 'claude' && id !== 'codex' && id !== 'agy') throw new Error('CLI desconhecido.')
    return installCli(id)
  })
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (e, patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    // as outras janelas (chats de agente) acompanham tema e fonte sem precisar reabrir
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('settings:changed', next)
    return next
  })
  // serviços em segundo plano (menu do usuário → Serviços)
  ipcMain.handle('services:states', () => services.serviceStates())
  ipcMain.handle('services:start', (_e, id: string) => services.startService(String(id)))
  ipcMain.handle('services:stop', (_e, id: string) => services.stopService(String(id)))
  ipcMain.handle('services:openWindow', (_e, id: string) => services.openServiceWindow(String(id)))
  ipcMain.handle('services:reattach', (e, id: string) => {
    if (!win || win.isDestroyed()) return false
    win.webContents.send('services:attachPanel', String(id))
    win.show()
    win.focus()
    const from = BrowserWindow.fromWebContents(e.sender)
    setTimeout(() => from && !from.isDestroyed() && from.close(), 300)
    return true
  })
  ipcMain.handle('services:attach', (e, id: string, cols: number, rows: number) => services.attachService(e.sender, String(id), Number(cols) || 0, Number(rows) || 0))
  ipcMain.on('services:write', (_e, id: string, data: string) => services.writeService(String(id), String(data)))
  ipcMain.on('services:resize', (_e, id: string, cols: number, rows: number) => services.resizeService(String(id), Number(cols) || 0, Number(rows) || 0))
  // AWS: instalação do CLI, login por SSO e sessão (Configurações → AWS)
  ipcMain.handle('aws:status', () => aws.awsStatus())
  ipcMain.handle('aws:install', (e) => aws.awsInstall((p) => !e.sender.isDestroyed() && e.sender.send('aws:installProgress', p)))
  ipcMain.handle('aws:login', (e, profile: string) => aws.awsLogin(String(profile ?? ''), (line) => !e.sender.isDestroyed() && e.sender.send('aws:loginOutput', line)))
  ipcMain.handle('aws:cancelLogin', () => aws.awsCancelLogin())
  ipcMain.handle('aws:logout', (_e, profile: string) => aws.awsLogout(String(profile ?? '')))
  ipcMain.handle('update:state', () => updater.updateState())
  ipcMain.handle('update:check', () => updater.checkForUpdates())
  ipcMain.handle('update:download', () => updater.downloadUpdate())
  ipcMain.handle('update:install', () => updater.installUpdate())
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })
  // arquivos gerados pelo agente (cartão na conversa): existe? tamanho; abrir no app padrão; mostrar na pasta
  ipcMain.handle('files:info', async (_e, paths: string[]) =>
    Promise.all(
      paths.map(String).map(async (p) => {
        const full = expandHome(p)
        try {
          const st = await fsp.stat(full)
          return { path: p, exists: st.isFile(), size: st.size, mtime: st.mtimeMs }
        } catch {
          return { path: p, exists: false, size: 0, mtime: 0 }
        }
      })
    )
  )
  // copiar uma imagem da conversa: a janela manda o PNG (data URL) e a escrita é feita aqui, sem depender do
  // foco do documento que a API de clipboard do navegador exige
  ipcMain.handle('clipboard:writeImage', (_e, dataUrl: string) => {
    const url = String(dataUrl ?? '')
    if (!url.startsWith('data:image/png;base64,') || url.length > 60_000_000) throw new Error('Imagem inválida.')
    const image = nativeImage.createFromDataURL(url)
    if (image.isEmpty()) throw new Error('Imagem inválida.')
    clipboard.writeImage(image)
  })
  ipcMain.handle('files:open', (_e, p: string) => shell.openPath(expandHome(String(p))))
  ipcMain.handle('files:reveal', (_e, p: string) => shell.showItemInFolder(expandHome(String(p))))
}

const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

app.setName('Ovseer')
// Permite isolar as configurações (testes automatizados, múltiplos perfis)
if (process.env.OVSEER_USER_DATA) app.setPath('userData', process.env.OVSEER_USER_DATA)
else migrateUserData()

/**
 * O app se chamava OvrGit. Na primeira abertura com o nome novo, os dados da pasta antiga (configurações, login,
 * histórico de conversas, análises) são copiados para a nova, item a item: o Electron já cria a pasta nova
 * antes deste código rodar, então não dá para simplesmente renomear a antiga.
 */
function migrateUserData() {
  const data = app.getPath('userData')
  if (existsSync(path.join(data, 'settings.json'))) return
  const old = ['OvrGit', 'ovrgit'].map((n) => path.join(path.dirname(data), n)).find((d) => existsSync(path.join(d, 'settings.json')))
  if (!old) return
  mkdirSync(data, { recursive: true })
  for (const item of ['settings.json', 'ovseer-token.bin', 'agent-history', 'analysis', 'agent-attachments']) {
    const from = path.join(old, item)
    const to = path.join(data, item)
    if (!existsSync(from) || existsSync(to)) continue
    try {
      cpSync(from, to, { recursive: true })
    } catch (e) {
      console.warn(`Não foi possível migrar ${item} da pasta de dados antiga:`, e)
    }
  }
}
if (process.platform === 'win32') app.setAppUserModelId('com.c2s.ovseer')

app.whenReady().then(() => {
  // só o próprio app pode pedir microfone (gravação de áudio das tarefas); o resto é negado
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const own = wc.getURL().startsWith('file://') || wc.getURL().startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')
    callback(own && (permission === 'media' || permission === 'clipboard-sanitized-write'))
  })
  registerIpc()
  buildMenu()
  agentChat.setupAgentWindows({ icon, background: initialBackground })
  services.setupServices({ icon, background: initialBackground })
  createWindow()
  if (getSettings().watchAgents) startAgents()
  updater.setupUpdater((s) => toMain('update:changed', s))
  aws.setupAws((s) => toMain('aws:changed', s))
  app.on('activate', () => {
    // clicar no Dock com só janelas de agente abertas: reabre a principal
    if (!win || win.isDestroyed()) createWindow()
  })
})

app.on('before-quit', () => {
  cancelLogin()
  ovseer.cancelLogin()
  ovseer.stopStream()
  agentWatch.stopAgentWatch()
  updater.stopUpdater()
  aws.stopAws()
  agentChat.shutdownAgents()
  killAllTerminals()
  services.stopAllServices()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
