import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentAction, AgentChatEvent, AgentSession, AgentSnapshot, AgentStatus, AuthEvent, OvseerApi, Settings, UpdateState } from '../shared/types'

const api: OvseerApi = {
  openProject: () => ipcRenderer.invoke('project:open'),
  loadProject: (p) => ipcRenderer.invoke('project:load', p),
  githubRepos: () => ipcRenderer.invoke('clone:repos'),
  cloneDefaults: () => ipcRenderer.invoke('clone:defaults'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  cloneRepo: (url, parent, name) => ipcRenderer.invoke('clone:run', url, parent, name),
  cancelClone: () => ipcRenderer.invoke('clone:cancel'),
  onCloneProgress: (cb) => {
    const h = (_e: unknown, p: { phase: string; percent: number | null }) => cb(p)
    ipcRenderer.on('clone:progress', h)
    return () => ipcRenderer.off('clone:progress', h)
  },
  projectIcon: (p) => ipcRenderer.invoke('project:icon', p),
  status: () => ipcRenderer.invoke('git:status'),
  diff: (f) => ipcRenderer.invoke('git:diff', f),
  log: (limit) => ipcRenderer.invoke('git:log', limit),
  sourceFiles: () => ipcRenderer.invoke('src:list'),
  readSource: (p) => ipcRenderer.invoke('src:read', p),
  readSourceImage: (p) => ipcRenderer.invoke('src:image', p),
  createSource: (p, content) => ipcRenderer.invoke('src:create', p, content),
  writeSource: (p, content, mtime) => ipcRenderer.invoke('src:write', p, content, mtime),
  discard: (files) => ipcRenderer.invoke('safe:discard', files),
  undoLastCommit: () => ipcRenderer.invoke('safe:undo'),
  editLastMessage: (msg) => ipcRenderer.invoke('safe:editMessage', msg),
  savedChanges: () => ipcRenderer.invoke('safe:list'),
  branches: () => ipcRenderer.invoke('branch:list'),
  pullRequest: () => ipcRenderer.invoke('pr:current'),
  quickCheck: (files) => ipcRenderer.invoke('assist:check', files),
  aiReview: (files) => ipcRenderer.invoke('assist:review', files),
  explainCommit: (hash) => ipcRenderer.invoke('assist:explain', hash),
  proposeResolution: (file) => ipcRenderer.invoke('assist:propose', file),
  applyResolution: (file, content) => ipcRenderer.invoke('assist:apply', file, content),
  deliveryReport: (plan, commits) => ipcRenderer.invoke('assist:delivery', plan, commits),
  draftPullRequest: (taskInfo) => ipcRenderer.invoke('pr:draft', taskInfo),
  createPullRequest: (input) => ipcRenderer.invoke('pr:create', input),
  mergePullRequest: (method) => ipcRenderer.invoke('pr:merge', method),
  switchBranch: (name, mode) => ipcRenderer.invoke('branch:switch', name, mode),
  createBranch: (name) => ipcRenderer.invoke('branch:create', name),
  cleanupCandidates: () => ipcRenderer.invoke('branch:cleanup'),
  deleteBranches: (names) => ipcRenderer.invoke('branch:delete', names),
  restoreSaved: (ref) => ipcRenderer.invoke('safe:restore', ref),
  dropSaved: (ref) => ipcRenderer.invoke('safe:drop', ref),
  analyze: (force, tasks) => ipcRenderer.invoke('ai:analyze', force, tasks),
  cancelAnalysis: () => ipcRenderer.invoke('ai:cancel'),
  commitMessage: (files) => ipcRenderer.invoke('ai:message', files),
  savedAnalysis: () => ipcRenderer.invoke('analysis:get'),
  saveAnalysis: (a) => ipcRenderer.invoke('analysis:save', a),
  clearAnalysis: () => ipcRenderer.invoke('analysis:clear'),
  resolveConflict: (file, choice) => ipcRenderer.invoke('git:resolve', file, choice),
  abortOperation: () => ipcRenderer.invoke('git:abort'),
  continueOperation: () => ipcRenderer.invoke('git:continue'),
  openInEditor: () => ipcRenderer.invoke('editor:open'),
  commit: (files, message) => ipcRenderer.invoke('git:commit', files, message),
  commitPartial: (full, partial, message) => ipcRenderer.invoke('git:commitPartial', full, partial, message),
  commitGroups: (groups) => ipcRenderer.invoke('git:commitGroups', groups),
  pull: (stash) => ipcRenderer.invoke('git:pull', stash),
  push: () => ipcRenderer.invoke('git:push'),
  publishInfo: () => ipcRenderer.invoke('git:publishInfo'),
  publishToUrl: (url) => ipcRenderer.invoke('git:publishUrl', url),
  publishToGitHub: (name, isPrivate) => ipcRenderer.invoke('git:publishGitHub', name, isPrivate),
  featurePreview: () => ipcRenderer.invoke('git:featurePreview'),
  createFeature: (name, prefix) => ipcRenderer.invoke('git:createFeature', name, prefix),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  onSettingsChanged: (cb) => {
    const h = (_e: unknown, s: Settings) => cb(s)
    ipcRenderer.on('settings:changed', h)
    return () => ipcRenderer.off('settings:changed', h)
  },
  listModels: () => ipcRenderer.invoke('ai:models'),
  detectProviders: () => ipcRenderer.invoke('ai:detect'),
  authStatus: (p) => ipcRenderer.invoke('auth:status', p),
  authLogin: (p) => ipcRenderer.invoke('auth:login', p),
  authSendCode: (code) => ipcRenderer.invoke('auth:code', code),
  authCancel: () => ipcRenderer.invoke('auth:cancel'),
  authLogout: (p) => ipcRenderer.invoke('auth:logout', p),
  onAuthEvent: (cb) => {
    const h = (_e: unknown, ev: AuthEvent) => cb(ev)
    ipcRenderer.on('auth:event', h)
    return () => ipcRenderer.off('auth:event', h)
  },
  onMenu: (cb) => {
    const h = (_e: unknown, action: string) => cb(action)
    ipcRenderer.on('menu', h)
    return () => ipcRenderer.off('menu', h)
  },
  termCreate: (cols, rows, spec) => ipcRenderer.invoke('term:create', cols, rows, spec),
  pickSshKey: () => ipcRenderer.invoke('ssh:pickKey'),
  listSshKeys: () => ipcRenderer.invoke('ssh:listKeys'),
  sshImportConfig: () => ipcRenderer.invoke('ssh:importConfig'),
  sshImportCsv: (text) => ipcRenderer.invoke('ssh:importCsv', text),
  pickTextFile: () => ipcRenderer.invoke('dialog:pickText'),
  termWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  termKill: (id) => ipcRenderer.invoke('term:kill', id),
  onTermData: (cb) => {
    const h = (_e: unknown, id: number, data: string) => cb(id, data)
    ipcRenderer.on('term:data', h)
    return () => ipcRenderer.off('term:data', h)
  },
  onTermExit: (cb) => {
    const h = (_e: unknown, id: number, code: number) => cb(id, code)
    ipcRenderer.on('term:exit', h)
    return () => ipcRenderer.off('term:exit', h)
  },
  ovseerStatus: () => ipcRenderer.invoke('ovseer:status'),
  ovseerLogin: () => ipcRenderer.invoke('ovseer:login'),
  ovseerCancelLogin: () => ipcRenderer.invoke('ovseer:cancelLogin'),
  ovseerLogout: () => ipcRenderer.invoke('ovseer:logout'),
  ovseerTasks: (workspaceId) => ipcRenderer.invoke('ovseer:tasks', workspaceId),
  ovseerLink: (workspaceId, links) => ipcRenderer.invoke('ovseer:link', workspaceId, links),
  ovseerMembers: (workspaceId) => ipcRenderer.invoke('ovseer:members', workspaceId),
  ovseerCreateTask: (input) => ipcRenderer.invoke('ovseer:createTask', input),
  ovseerLive: (on) => ipcRenderer.invoke('ovseer:live', on),
  ovseerDelivery: (taskId) => ipcRenderer.invoke('ovseer:delivery', taskId),
  ovseerSubmitDelivery: (taskId, input) => ipcRenderer.invoke('ovseer:submitDelivery', taskId, input),
  ovseerTaskDetail: (id) => ipcRenderer.invoke('ovseer:task', id),
  ovseerSetStatus: (id, status, ack) => ipcRenderer.invoke('ovseer:setStatus', id, status, ack),
  ovseerAttachmentUrl: (id, index) => ipcRenderer.invoke('ovseer:attachmentUrl', id, index),
  ovseerApprovalAudioUrl: (id) => ipcRenderer.invoke('ovseer:approvalAudioUrl', id),
  ovseerComments: (id) => ipcRenderer.invoke('ovseer:comments', id),
  startTaskBranch: (key, title) => ipcRenderer.invoke('task:branch', key, title),
  ovseerUpload: (taskId, file, purpose) => ipcRenderer.invoke('ovseer:upload', taskId, file, purpose),
  requestMicrophone: () => ipcRenderer.invoke('media:microphone'),
  onOvseerChange: (cb) => {
    const h = () => cb()
    ipcRenderer.on('ovseer:changed', h)
    return () => ipcRenderer.off('ovseer:changed', h)
  },
  onOvseerLive: (cb) => {
    const h = (_e: unknown, live: boolean) => cb(live)
    ipcRenderer.on('ovseer:liveState', h)
    return () => ipcRenderer.off('ovseer:liveState', h)
  },
  agents: () => ipcRenderer.invoke('agents:list'),
  projectsOverview: (roots) => ipcRenderer.invoke('projects:overview', roots),
  setWatchAgents: (on) => ipcRenderer.invoke('agents:enable', on),
  onAgents: (cb) => {
    const h = (_e: unknown, list: AgentSession[]) => cb(list)
    ipcRenderer.on('agents:update', h)
    return () => ipcRenderer.off('agents:update', h)
  },
  onAgentFinished: (cb) => {
    const h = (_e: unknown, s: AgentSession) => cb(s)
    ipcRenderer.on('agents:finished', h)
    return () => ipcRenderer.off('agents:finished', h)
  },
  setWindowTheme: (background, symbols) => ipcRenderer.send('window:theme', background, symbols),
  windowDrag: (dx, dy, begin) => ipcRenderer.send('window:drag', dx, dy, !!begin),
  agentOpen: (opts) => ipcRenderer.invoke('agent:open', opts),
  agentInfo: (uid) => ipcRenderer.invoke('agent:info', uid),
  agentSend: (uid, text, opts, attachments) => ipcRenderer.invoke('agent:send', uid, text, opts, attachments ?? []),
  agentCancel: (uid) => ipcRenderer.invoke('agent:cancel', uid),
  agentNewChat: (uid) => ipcRenderer.invoke('agent:new', uid),
  agentBack: (uid) => ipcRenderer.invoke('agent:back', uid),
  agentSteer: (uid, text, attachments) => ipcRenderer.invoke('agent:steer', uid, text, attachments ?? []),
  agentPickFiles: (uid) => ipcRenderer.invoke('agent:pick', uid),
  agentHistory: (cwd) => ipcRenderer.invoke('agent:history', cwd),
  agentSaveTranscript: (uid, turns) => ipcRenderer.invoke('agent:saveTranscript', uid, turns),
  agentFileRepos: (uid, paths) => ipcRenderer.invoke('agent:fileRepos', uid, paths),
  agentLoadTranscript: (sessionId) => ipcRenderer.invoke('agent:loadTranscript', sessionId),
  agentForget: (sessionId) => ipcRenderer.invoke('agent:forget', sessionId),
  agentPin: (sessionId, pinned) => ipcRenderer.invoke('agent:pin', sessionId, pinned),
  agentSetTitle: (uid, title) => ipcRenderer.invoke('agent:setTitle', uid, title),
  agentSetCwd: (uid, cwd) => ipcRenderer.invoke('agent:setCwd', uid, cwd),
  agentProjects: () => ipcRenderer.invoke('agent:projects'),
  agentPickCwd: (uid) => ipcRenderer.invoke('agent:pickCwd', uid),
  agentSaveBlob: (uid, file) => ipcRenderer.invoke('agent:blob', uid, file),
  agentKeepFile: (uid, path) => ipcRenderer.invoke('agent:keepFile', uid, path),
  agentImage: (path) => ipcRenderer.invoke('agent:image', path),
  filePath: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  agentFocus: (sessionId) => ipcRenderer.invoke('agent:focus', sessionId),
  agentWindows: () => ipcRenderer.invoke('agent:windows'),
  agentPlace: (uid, p) => ipcRenderer.invoke('agent:place', uid, p),
  agentRegrid: (uid, from, to) => ipcRenderer.invoke('agent:regrid', uid, from, to),
  agentGridCells: (uid, grid) => ipcRenderer.invoke('agent:gridCells', uid, grid),
  knownModels: () => ipcRenderer.invoke('agents:models'),
  usage: (force) => ipcRenderer.invoke('usage:get', !!force),
  cliUpdates: (force) => ipcRenderer.invoke('cli:updates', !!force),
  cliUpdate: (id) => ipcRenderer.invoke('cli:update', id),
  cliInstall: (id) => ipcRenderer.invoke('cli:install', id),
  onAgentEvent: (cb) => {
    const h = (_e: unknown, uid: string, ev: AgentChatEvent) => cb(uid, ev)
    ipcRenderer.on('agent:event', h)
    return () => ipcRenderer.off('agent:event', h)
  },
  onAgentWindows: (cb) => {
    const h = (_e: unknown, ids: string[]) => cb(ids)
    ipcRenderer.on('agents:windows', h)
    return () => ipcRenderer.off('agents:windows', h)
  },
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => {
    const h = (_e: unknown, s: UpdateState) => cb(s)
    ipcRenderer.on('update:changed', h)
    return () => ipcRenderer.off('update:changed', h)
  },
  agentReportStatus: (uid, status) => ipcRenderer.send('agent:status', uid, status),
  agentReportSnapshot: (uid, snap) => ipcRenderer.send('agent:snapshot', uid, snap),
  agentSnapshots: () => ipcRenderer.invoke('agent:snapshots'),
  onAgentSnapshots: (cb) => {
    const h = (_e: unknown, s: AgentSnapshot[]) => cb(s)
    ipcRenderer.on('agents:snapshots', h)
    return () => ipcRenderer.off('agents:snapshots', h)
  },
  agentAct: (uid, action) => ipcRenderer.invoke('agent:act', uid, action),
  onAgentAct: (cb) => {
    const h = (_e: unknown, uid: string, a: AgentAction) => cb(uid, a)
    ipcRenderer.on('agent:act', h)
    return () => ipcRenderer.off('agent:act', h)
  },
  agentShow: (uid) => ipcRenderer.invoke('agent:show', uid),
  agentClose: (uids) => ipcRenderer.invoke('agent:close', uids),
  agentArrange: () => ipcRenderer.invoke('agent:arrange'),
  agentDaySummary: () => ipcRenderer.invoke('agent:daySummary'),
  agentStatuses: () => ipcRenderer.invoke('agent:statuses'),
  onAgentStatuses: (cb) => {
    const h = (_e: unknown, s: Record<string, AgentStatus>) => cb(s)
    ipcRenderer.on('agents:statuses', h)
    return () => ipcRenderer.off('agents:statuses', h)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('ovseer', api)
