import { contextBridge, ipcRenderer } from 'electron'
import type { AgentSession, AuthEvent, OvrGitApi } from '../shared/types'

const api: OvrGitApi = {
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
  platform: process.platform
}

contextBridge.exposeInMainWorld('ovrgit', api)
