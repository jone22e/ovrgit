export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'typechange'

export interface FileChange {
  path: string
  /** Caminho anterior quando o arquivo foi renomeado */
  origPath?: string
  kind: ChangeKind
  staged: boolean
  unstaged: boolean
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface RepoStatus {
  root: string
  name: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
  hasCommits: boolean
  /** A branch existe no remoto (upstream configurado e presente) */
  published: boolean
  /** Commits que ainda não estão em nenhum remoto (útil antes de publicar) */
  unpublished: number
  /** Operação interrompida (normalmente por conflito) */
  operation: RepoOperation
  conflicts: number
  files: FileChange[]
}

export interface CommitInfo {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export type CommitType = 'feat' | 'fix' | 'refactor' | 'test' | 'chore' | 'docs' | 'style' | 'perf'

export interface ChangeGroup {
  id: string
  title: string
  type: CommitType
  summary: string
  bullets: string[]
  commit: string
  files: string[]
}

export interface Analysis {
  groups: ChangeGroup[]
  commit: string
  branch: string
  source: 'ai' | 'heuristic'
  /** Nome do provedor que gerou a análise (Claude, Codex, Ollama) */
  provider?: string
  warning?: string
}

export type AiProvider = 'claude' | 'codex' | 'ollama' | 'none'

export interface Settings {
  /** Id do tema (ver shared/themes.ts) */
  theme: string
  /** Endereço do Ovseer e workspace usado para as tarefas */
  ovseerUrl: string
  ovseerWorkspaceId: string | null
  /** Último prefixo usado em "Criar Feature" (feature, fix, hotfix…) */
  branchPrefix: string
  /** Fonte e tamanho do terminal integrado */
  terminalFont: string
  terminalFontSize: number
  /** 400 normal, 500 médio, 600 semi-negrito */
  terminalFontWeight: number
  provider: AiProvider
  ollamaUrl: string
  /** Modelo do Ollama */
  model: string
  /** Modelo do Claude Code (vazio = padrão da conta). Ex.: sonnet, haiku, opus */
  claudeModel: string
  /** Modelo do Codex (vazio = padrão da conta) */
  codexModel: string
  recentProjects: string[]
  lastProject: string | null
}

export interface StepResult {
  label: string
  ok: boolean
  detail?: string
}

export interface CreatedCommit {
  sha: string
  message: string
}

export interface OperationResult {
  ok: boolean
  steps: StepResult[]
  /** Commits criados pela operação, na ordem */
  commits?: CreatedCommit[]
  error?: string
  prUrl?: string | null
}

export interface FeaturePreview {
  branch: string | null
  baseRef: string | null
  localCommits: number
  /** Commits no remoto que ainda não estão no trabalho local */
  remoteNew: number
  changedFiles: number
  hasRemote: boolean
  dirty: boolean
}

export type CliProvider = 'claude' | 'codex'

export interface AuthStatus {
  installed: boolean
  loggedIn: boolean
  /** Ex.: e-mail e plano da conta */
  detail?: string
  error?: string
}

export type AuthEvent =
  | { type: 'url'; url: string }
  | { type: 'needsCode' }
  | { type: 'done'; ok: boolean; error?: string; status?: AuthStatus }

export interface OvseerUser {
  id: string
  name: string
  email: string
  avatarUrl?: string | null
}

export interface OvseerWorkspace {
  id: string
  name: string
}

export interface OvseerStatus {
  connected: boolean
  url: string
  user?: OvseerUser
  workspaces?: OvseerWorkspace[]
  error?: string
}

export interface OvseerTask {
  id: string
  /** Chave legível, ex.: ROAD-2 */
  key: string
  title: string
  /** Status técnico e o rótulo exibido (ex.: "paused" / "Pausado") */
  status: string
  statusLabel: string
  priority?: string | null
  assignedToMe?: boolean
  /** Posso enviar a entrega (sou o executor, plano aprovado, nada em validação) */
  canDeliver?: boolean
}

export interface OvseerDeliveryInput {
  adherence: 'as_planned' | 'changed'
  summary?: string
  commitUrl?: string
  /** id da sugestão (commit vinculado pelo OvrGit), quando o commit veio da lista */
  commitEventId?: string
  pullRequestUrl?: string
}

export interface OvseerDeliveryCommit {
  id: string
  title: string
  url: string
  repository: string | null
  occurred_at: string | null
}

export interface OvseerMember {
  id: string
  name: string
  avatarUrl: string | null
  me: boolean
}

export interface OvseerNewTask {
  workspaceId: string
  title: string
  plan: string
  ownerId: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  /** AAAA-MM-DD */
  dueDate?: string | null
}

export interface OvseerLinkInput {
  workspaceId: string
  repo: { name: string; url?: string | null }
  branch: string | null
  commits: { taskId: string; sha: string; message: string; url?: string | null; committedAt: string }[]
}

export interface PublishInfo {
  /** Usuário do GitHub CLI (gh) logado, se houver */
  ghUser: string | null
  suggestedName: string
}

export interface ProviderStatus {
  claude: string | null
  codex: string | null
  ollama: boolean
}

export interface OvrGitApi {
  openProject(): Promise<RepoStatus | null>
  loadProject(path: string): Promise<RepoStatus>
  projectIcon(path: string): Promise<string | null>
  status(): Promise<RepoStatus | null>
  diff(file: FileChange): Promise<string>
  log(limit?: number): Promise<CommitInfo[]>
  analyze(force?: boolean): Promise<Analysis>
  cancelAnalysis(): Promise<void>
  commitMessage(files: string[]): Promise<string>
  savedAnalysis(): Promise<{ analysis: Analysis; stale: boolean } | null>
  clearAnalysis(): Promise<void>
  saveAnalysis(a: Analysis): Promise<void>
  resolveConflict(file: string, choice: 'mine' | 'theirs' | 'resolved'): Promise<OperationResult>
  abortOperation(): Promise<OperationResult>
  continueOperation(): Promise<OperationResult>
  openInEditor(): Promise<string>
  commit(files: string[], message: string): Promise<OperationResult>
  commitGroups(groups: { files: string[]; message: string }[]): Promise<OperationResult>
  pull(stash: boolean): Promise<OperationResult>
  push(): Promise<OperationResult>
  publishInfo(): Promise<PublishInfo>
  publishToUrl(url: string): Promise<OperationResult>
  publishToGitHub(name: string, isPrivate: boolean): Promise<OperationResult>
  featurePreview(): Promise<FeaturePreview>
  createFeature(name: string, prefix: string): Promise<OperationResult>
  openExternal(url: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  listModels(): Promise<string[]>
  detectProviders(): Promise<ProviderStatus>
  authStatus(provider: CliProvider): Promise<AuthStatus>
  authLogin(provider: CliProvider): Promise<void>
  authSendCode(code: string): Promise<void>
  authCancel(): Promise<void>
  authLogout(provider: CliProvider): Promise<AuthStatus>
  onAuthEvent(cb: (e: AuthEvent) => void): () => void
  ovseerStatus(): Promise<OvseerStatus>
  ovseerLogin(): Promise<OvseerStatus>
  ovseerCancelLogin(): Promise<void>
  ovseerLogout(): Promise<OvseerStatus>
  ovseerTasks(workspaceId: string): Promise<OvseerTask[]>
  ovseerLink(workspaceId: string, links: { taskId: string; sha: string; message: string }[]): Promise<number>
  ovseerMembers(workspaceId: string): Promise<OvseerMember[]>
  ovseerCreateTask(input: OvseerNewTask): Promise<{ id: string; code: string }>
  /** Liga/desliga o canal em tempo real (a interface chama quando conecta/desconecta) */
  ovseerLive(on: boolean): Promise<void>
  ovseerDelivery(taskId: string): Promise<{ commits: OvseerDeliveryCommit[]; pullRequestUrl: string | null }>
  ovseerSubmitDelivery(taskId: string, input: OvseerDeliveryInput): Promise<void>
  ovseerUpload(taskId: string, file: { name: string; type: string; data: ArrayBuffer }, purpose?: 'plan_audio'): Promise<void>
  /** Pede acesso ao microfone ao sistema (macOS); true se liberado */
  requestMicrophone(): Promise<boolean>
  onOvseerChange(cb: () => void): () => void
  onOvseerLive(cb: (live: boolean) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  setWindowTheme(background: string, symbols: string): void
  termCreate(cols: number, rows: number): Promise<number>
  termWrite(id: number, data: string): void
  termResize(id: number, cols: number, rows: number): void
  termKill(id: number): Promise<void>
  onTermData(cb: (id: number, data: string) => void): () => void
  onTermExit(cb: (id: number, code: number) => void): () => void
  platform: string
}
