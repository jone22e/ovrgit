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

/** Resumo de um projeto para a lista de projetos */
export interface ProjectOverview {
  root: string
  ok: boolean
  branch: string | null
  changes: number
  ahead: number
  behind: number
  published: boolean
  unpublished: number
  operation: boolean
  conflicts: number
}

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
  /** Ainda não enviado para o servidor (dá para desfazer/editar com segurança) */
  local?: boolean
  /** Versão de junção (merge): juntou outra linha de trabalho */
  merge?: boolean
}

/** Linha de trabalho (branch) */
export interface BranchInfo {
  name: string
  /** local: existe no computador; remote: só no servidor */
  where: 'local' | 'remote'
  current: boolean
  published: boolean
  ahead: number
  behind: number
  date: string
  subject: string
  /** cópia de segurança automática (backup/auto-…) */
  backup: boolean
}

export interface CleanupCandidate {
  name: string
  reason: 'backup' | 'merged'
  date: string
  /** vem marcada por padrão (incorporada, ou backup com mais de 7 dias) */
  suggested: boolean
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  base: string
  /** verificações automáticas (CI) */
  checks: 'none' | 'pending' | 'passing' | 'failing'
  review: 'pending' | 'approved' | 'changes'
  conflicts: boolean
}

/** Ponto de atenção encontrado antes de salvar (checagem local ou revisão da IA) */
export interface CheckFinding {
  file: string
  line?: number
  severity: 'high' | 'medium' | 'low'
  message: string
}

/** Repositório do GitHub para clonar */
export interface RemoteRepo {
  name: string
  description: string | null
  private: boolean
  updatedAt: string
  httpsUrl: string
  sshUrl: string
}

/** Tarefa de um agente externo (Codex do app do ChatGPT) acompanhada pelos registros locais */
export interface AgentSession {
  id: string
  source: 'codex' | 'claude'
  title: string
  cwd: string
  branch: string | null
  running: boolean
  /** "trabalhando" sem movimento há muito tempo: provavelmente fechado no meio */
  stale: boolean
  startedAt: number
  completedAt: number | null
  durationMs: number | null
  lastMessage: string | null
  updatedAt: number
  /** Primeiro pedido do usuário (limpo), usado para achar o código da tarefa (ex.: ROAD-21) */
  request?: string
}

/** Alterações guardadas (stash): Lixeira do app, guardadas antes de baixar, etc. */
export interface SavedChanges {
  ref: string
  kind: 'trash' | 'pull' | 'other'
  label: string
  date: string
  files: string[]
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
  /** Chave da tarefa do Ovseer a que a IA ligou este grupo (ex.: ROAD-20) */
  task?: string | null
}

/** Tarefa em andamento enviada à IA para agrupar as alterações por tarefa */
export interface TaskHint {
  key: string
  title: string
  status: string
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

/** Conexão SSH salva. Senhas nunca são guardadas: se pedir, digita-se no terminal. */
export interface SshConnection {
  id: string
  name: string
  host: string
  user: string
  port: number
  /** Chave privada (opcional); sem ela vale o ~/.ssh/config e o agente */
  identityFile?: string | null
  /** Pasta para entrar ao conectar (opcional) */
  remoteDir?: string | null
  /** Grupo para organizar a lista (opcional) */
  group?: string | null
}

export interface SshImportCandidate {
  name: string
  host: string
  user: string
  port: number
  identityFile: string | null
  group: string | null
}

/** Comando salvo do terminal (geral ou só de uma conexão) */
export interface Snippet {
  id: string
  name: string
  command: string
  connectionId?: string | null
}

export type TerminalSpec = { kind: 'local' } | { kind: 'ssh'; connectionId: string }

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
  sshConnections: SshConnection[]
  /** Acompanhar tarefas do Codex (app do ChatGPT) pelos registros locais */
  watchAgents: boolean
  /** Conversa do ChatGPT (Codex) → tarefa do Ovseer, ligadas pelo usuário */
  agentLinks: Record<string, string>
  snippets: Snippet[]
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
  /** Mensagem original do Git, mostrada só em "Detalhes técnicos" */
  tech?: string
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
  /** Etapa do fluxo, igual à tela de tarefas do Ovseer (plan_pending, execution, paused…) */
  section?: string
  owner?: { name: string; avatarUrl: string | null } | null
}

export interface OvseerTaskDetail {
  id: string
  key: string
  title: string
  status: string
  section: string
  priority: string | null
  plan: string
  dueDate: string | null
  owner: { name: string; avatarUrl: string | null } | null
  isExecutor: boolean
  planReview: { status: string; note: string | null; hasAudio: boolean; rejectionReason: string | null; guidanceNeedsAck: boolean }
  completion: { status: string; rejectionReason: string | null }
  attachments: { index: number; name: string; type: string; size: number | null; audio: boolean }[]
}

export interface OvseerComment {
  id: string
  author: string
  text: string
  date: string | null
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
  githubRepos(): Promise<RemoteRepo[] | null>
  cloneDefaults(): Promise<{ parent: string }>
  pickFolder(defaultPath: string): Promise<string | null>
  cloneRepo(url: string, parent: string, name: string): Promise<RepoStatus>
  cancelClone(): Promise<void>
  onCloneProgress(cb: (p: { phase: string; percent: number | null }) => void): () => void
  projectIcon(path: string): Promise<string | null>
  status(): Promise<RepoStatus | null>
  diff(file: FileChange): Promise<string>
  log(limit?: number): Promise<CommitInfo[]>
  discard(files: string[]): Promise<OperationResult>
  undoLastCommit(): Promise<OperationResult>
  editLastMessage(message: string): Promise<OperationResult>
  savedChanges(): Promise<SavedChanges[]>
  branches(): Promise<BranchInfo[]>
  switchBranch(name: string, mode: 'carry' | 'stash'): Promise<OperationResult>
  createBranch(name: string): Promise<OperationResult>
  cleanupCandidates(): Promise<CleanupCandidate[]>
  deleteBranches(names: string[]): Promise<OperationResult>
  pullRequest(): Promise<PullRequestInfo | null>
  quickCheck(files: string[]): Promise<CheckFinding[]>
  aiReview(files: string[]): Promise<CheckFinding[]>
  explainCommit(hash: string): Promise<string>
  proposeResolution(file: string): Promise<{ content: string; explanation: string }>
  applyResolution(file: string, content: string): Promise<OperationResult>
  deliveryReport(plan: string, commits: string[]): Promise<{ adherence: 'as_planned' | 'changed'; summary: string }>
  draftPullRequest(taskInfo: string | null): Promise<{ title: string; body: string; base: string }>
  createPullRequest(input: { title: string; body: string; base: string; draft: boolean }): Promise<OperationResult>
  mergePullRequest(method: 'merge' | 'squash'): Promise<OperationResult>
  restoreSaved(ref: string): Promise<OperationResult>
  dropSaved(ref: string): Promise<OperationResult>
  analyze(force?: boolean, tasks?: TaskHint[]): Promise<Analysis>
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
  /** Salvar versão com só alguns trechos de arquivos (índices dos trechos incluídos) */
  commitPartial(fullFiles: string[], partial: { path: string; hunks: number[] }[], message: string): Promise<OperationResult>
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
  ovseerDelivery(taskId: string): Promise<{ commits: OvseerDeliveryCommit[]; pullRequestUrl: string | null; plan: string }>
  ovseerSubmitDelivery(taskId: string, input: OvseerDeliveryInput): Promise<void>
  ovseerTaskDetail(taskId: string): Promise<OvseerTaskDetail>
  ovseerSetStatus(taskId: string, status: 'doing' | 'paused' | 'blocked', acknowledged: boolean): Promise<void>
  ovseerAttachmentUrl(taskId: string, index: number): Promise<string>
  ovseerApprovalAudioUrl(taskId: string): Promise<string>
  ovseerComments(taskId: string): Promise<OvseerComment[]>
  /** Cria (ou troca para) a linha de trabalho da tarefa */
  startTaskBranch(key: string, title: string): Promise<OperationResult>
  ovseerUpload(taskId: string, file: { name: string; type: string; data: ArrayBuffer }, purpose?: 'plan_audio'): Promise<void>
  /** Pede acesso ao microfone ao sistema (macOS); true se liberado */
  requestMicrophone(): Promise<boolean>
  onOvseerChange(cb: () => void): () => void
  onOvseerLive(cb: (live: boolean) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  agents(): Promise<AgentSession[]>
  /** Situação de vários projetos de uma vez (sem acessar o servidor) */
  projectsOverview(roots: string[]): Promise<ProjectOverview[]>
  setWatchAgents(on: boolean): Promise<void>
  onAgents(cb: (list: AgentSession[]) => void): () => void
  onAgentFinished(cb: (s: AgentSession) => void): () => void
  setWindowTheme(background: string, symbols: string): void
  termCreate(cols: number, rows: number, spec: TerminalSpec): Promise<number>
  pickSshKey(): Promise<string | null>
  /** Chaves privadas encontradas em ~/.ssh (só os caminhos) */
  listSshKeys(): Promise<string[]>
  sshImportConfig(): Promise<SshImportCandidate[]>
  sshImportCsv(text: string): Promise<SshImportCandidate[]>
  pickTextFile(): Promise<string | null>
  termWrite(id: number, data: string): void
  termResize(id: number, cols: number, rows: number): void
  termKill(id: number): Promise<void>
  onTermData(cb: (id: number, data: string) => void): () => void
  onTermExit(cb: (id: number, code: number) => void): () => void
  platform: string
}
