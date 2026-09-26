import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, systemPreferences,
  type MenuItemConstructorOptions
} from 'electron'
import { findTheme } from '../shared/themes'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import icon from '../../build/icon.png?asset'
import type {
  ProjectOverview, TaskHint,
  Analysis, CliProvider, FileChange, OvseerDeliveryInput, OvseerNewTask, Settings, TerminalSpec
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
import { commitWithHunks } from './partial'
import { createTerminal, killAllTerminals, killTerminal, listSshKeys, resizeTerminal, writeTerminal } from './terminal'
import type { ConflictChoice } from './git'
import { analysisHash, analyze, taskContext, cancelAnalysis, commitMessage, detectProviders, listModels } from './ai'
import { clearAnalysis, loadAnalysis, saveAnalysis } from './analysisStore'
import { authStatus, cancelLogin, logout, sendCode, startLogin } from './auth'
import * as g from './git'
import { getSettings, rememberProject, saveSettings } from './settings'

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
  win?.setTitle(`OvrGit — ${path.basename(r)}`)
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

/** Liga o acompanhamento das tarefas do Codex e repassa para a janela. */
function startAgents() {
  agentWatch.startAgentWatch({
    onUpdate: (list) => win?.webContents.send('agents:update', list),
    onFinished: (s) => win?.webContents.send('agents:finished', s)
  })
}

function createWindow() {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 450,
    minHeight: 560,
    title: 'OvrGit',
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const send = (ch: string) => () => win?.webContents.send('menu', ch)
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Trocar projeto…', accelerator: 'CmdOrCtrl+P', click: send('switch') },
        { label: 'Abrir pasta…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Atualizar', accelerator: 'CmdOrCtrl+R', click: send('refresh') },
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
    return createTerminal(e.sender, root ?? os.homedir(), cols, rows)
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
  const provider = (p: unknown): CliProvider => {
    if (p !== 'claude' && p !== 'codex') throw new Error('Provedor inválido.')
    return p
  }
  ipcMain.handle('auth:status', (_e, p: CliProvider) => authStatus(provider(p)))
  ipcMain.handle('auth:login', (e, p: CliProvider) =>
    startLogin(provider(p), (ev) => {
      if (!e.sender.isDestroyed()) e.sender.send('auth:event', ev)
    })
  )
  ipcMain.handle('auth:code', (_e, code: string) => sendCode(String(code)))
  ipcMain.handle('auth:cancel', () => cancelLogin())
  ipcMain.handle('auth:logout', (_e, p: CliProvider) => logout(provider(p)))
  ipcMain.on('window:theme', (e, background: string, symbols: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || !/^#[0-9a-f]{6}$/i.test(background)) return
    w.setBackgroundColor(background)
    if (process.platform !== 'darwin' && /^#[0-9a-f]{6}$/i.test(symbols))
      w.setTitleBarOverlay({ color: '#00000000', symbolColor: symbols, height: 48 })
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
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => saveSettings(patch))
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })
}

app.setName('OvrGit')
// Permite isolar as configurações (testes automatizados, múltiplos perfis)
if (process.env.OVRGIT_USER_DATA) app.setPath('userData', process.env.OVRGIT_USER_DATA)
if (process.platform === 'win32') app.setAppUserModelId('com.c2s.ovrgit')

app.whenReady().then(() => {
  // só o próprio app pode pedir microfone (gravação de áudio das tarefas); o resto é negado
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const own = wc.getURL().startsWith('file://') || wc.getURL().startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')
    callback(own && (permission === 'media' || permission === 'clipboard-sanitized-write'))
  })
  registerIpc()
  buildMenu()
  createWindow()
  if (getSettings().watchAgents) win?.webContents.once('did-finish-load', startAgents)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  cancelLogin()
  ovseer.cancelLogin()
  ovseer.stopStream()
  agentWatch.stopAgentWatch()
  killAllTerminals()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
