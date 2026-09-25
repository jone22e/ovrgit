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

export interface OperationResult {
  ok: boolean
  steps: StepResult[]
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
  featurePreview(): Promise<FeaturePreview>
  createFeature(name: string): Promise<OperationResult>
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
  onMenu(cb: (action: string) => void): () => void
  termCreate(cols: number, rows: number): Promise<number>
  termWrite(id: number, data: string): void
  termResize(id: number, cols: number, rows: number): void
  termKill(id: number): Promise<void>
  onTermData(cb: (id: number, data: string) => void): () => void
  onTermExit(cb: (id: number, code: number) => void): () => void
  platform: string
}
