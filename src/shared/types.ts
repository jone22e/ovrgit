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

export type AiProvider = 'claude' | 'codex' | 'agy' | 'ollama' | 'none'

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

/** local: shell na pasta do projeto, com um comando inicial opcional (ex.: "agy" para fazer login) */
export type TerminalSpec = { kind: 'local'; command?: string } | { kind: 'ssh'; connectionId: string }

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
  /** Modelo do Antigravity (vazio = padrão da conta) */
  agyModel: string
  /** Instruções personalizadas para os agentes (janela do agente): estilo, regras do time, o que evitar */
  agentInstructions: string
  /** Fonte da janela do agente (vazio = fonte do sistema) e tamanho do texto da conversa */
  agentFont: string
  agentFontSize: number
  /** Grid de posicionamento das janelas de agente (colunas × linhas da área útil da tela) */
  agentGrid: GridSize
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

/** CLIs de agente: Claude Code, Codex (ChatGPT) e Antigravity (Google, comando `agy`) */
export type CliProvider = 'claude' | 'codex' | 'agy'
/** CLIs com login gerenciado nas Configurações */
export type AuthProvider = 'claude' | 'codex'

/** Nível de esforço (raciocínio) do agente; cada CLI aceita um subconjunto (ver shared/models.ts) */
export type AgentEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** Modelo conhecido de um CLI (catálogo do próprio CLI ou visto nas sessões) */
export interface ModelInfo {
  id: string
  label: string
  description?: string
  /** Níveis de esforço aceitos por este modelo (ausente = os padrões do provedor) */
  efforts?: AgentEffort[]
  defaultEffort?: AgentEffort
}

/** plan: só lê e propõe um plano; safe: edita arquivos e roda comandos só dentro do projeto; full: sem perguntas nem sandbox */
export type AgentMode = 'plan' | 'safe' | 'full'

/** Pedido para abrir a janela exclusiva de um agente */
export interface AgentChatOpen {
  provider: CliProvider
  model: string
  effort: AgentEffort
  mode: AgentMode
  cwd: string
  /** Primeira tarefa, enviada assim que a janela abrir */
  firstMessage?: string
  /** Continuar uma conversa já existente (id da sessão do CLI) */
  resumeId?: string
}

export interface AgentWindowInfo extends AgentChatOpen {
  uid: string
  /** Nome da pasta do projeto */
  project: string
  branch: string | null
  /** Id da sessão do CLI (definido depois da primeira resposta) */
  sessionId: string | null
  running: boolean
  /** Título da conversa: dado pela IA depois da primeira resposta, ou pelo usuário */
  title: string
  /** O usuário renomeou: a IA não mexe mais */
  renamed: boolean
  /** Conversa que estava aberta antes de "Nova conversa": dá para voltar a ela até a nova receber a primeira mensagem */
  previousSessionId?: string | null
}

/** Arquivo anexado a uma mensagem: imagens vão em linha; os demais pelo caminho (o agente lê com as ferramentas) */
export interface AgentAttachment {
  name: string
  /** Caminho absoluto no computador (original ou cópia guardada pelo app) */
  path: string
  mime: string
  size: number
  kind: 'image' | 'audio' | 'file'
}

/** Opções de uma mensagem enviada ao agente (podem mudar a cada mensagem) */
export interface AgentSendOptions {
  model: string
  effort: AgentEffort
  mode: AgentMode
  /** Troca de provedor: só vale antes da primeira mensagem (a sessão de um CLI não é legível pelo outro) */
  provider?: CliProvider
}

/** Evento da conversa, já traduzido do formato de cada CLI */
export type AgentChatEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta?: string }
  | { type: 'tool'; id: string; name: string; title: string; detail?: string }
  | { type: 'toolResult'; id: string; ok: boolean; output?: string }
  | { type: 'files'; paths: string[]; stats?: Record<string, FileStat | null>; repos?: Record<string, FileRepo> }
  | { type: 'done'; ok: boolean; error?: string; durationMs?: number; costUsd?: number }
  | { type: 'title'; title: string }

/** Linhas acrescentadas e removidas num arquivo alterado pelo agente (null: binário ou fora do git) */
export interface FileStat {
  add: number
  del: number
}

/** Repositório de um arquivo alterado fora do projeto da janela (chave: caminho como veio do agente) */
export interface FileRepo {
  /** Raiz do repositório (pasta com .git) */
  root: string
  /** Nome da pasta do repositório */
  name: string
}

/** Bloco de uma resposta do agente, como fica na janela e na transcrição guardada */
export type AgentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; title: string; detail?: string; ok: boolean | null; output?: string; open: boolean }
  | { kind: 'files'; paths: string[]; stats?: Record<string, FileStat | null>; repos?: Record<string, FileRepo> }

/** Uma vez da conversa: pedido do usuário e a resposta do agente */
export interface AgentTurn {
  id: string
  user: string
  attachments: AgentAttachment[]
  blocks: AgentBlock[]
  running: boolean
  thinking: boolean
  /** Última atividade vista enquanto roda (linha de andamento) */
  activity?: 'thinking' | 'tools' | 'writing'
  startedAt?: number
  /** Enviada no "agora" com o agente trabalhando: início do trabalho que ela continua (o contador segue dele) */
  workSince?: number
  error?: string
  durationMs?: number
  costUsd?: number
  /** Modo em que o pedido foi enviado (em `plan`, ao terminar o app pergunta se deseja implementar) */
  mode?: AgentMode
}

export interface GridSize {
  cols: number
  rows: number
}

/** Área escolhida no grid de posicionamento: a tela dividida em `cols` × `rows`, célula inicial (0-based) e extensão */
export interface GridPlacement extends GridSize {
  col: number
  colSpan: number
  row: number
  rowSpan: number
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Conversa aberta pelo Ovseer, guardada para reabrir depois (a sessão continua no CLI) */
export interface AgentHistoryItem {
  sessionId: string
  provider: CliProvider
  model: string
  effort: AgentEffort
  mode: AgentMode
  cwd: string
  project: string
  /** Título (da IA, do usuário, ou o primeiro pedido resumido) */
  title: string
  renamed?: boolean
  /** Fixada pelo usuário: fica no topo da lista e não é descartada pelo limite do histórico */
  pinned?: boolean
  /** Posição e tamanho da janela quando foi fechada, para reabrir no mesmo lugar */
  bounds?: WindowBounds
  createdAt: number
  updatedAt: number
  turns: number
}

/** Janela de limite de uso da assinatura (5 horas ou semanal): percentual usado e quando zera */
export interface UsageWindow {
  pct: number
  resetsAt: number | null
}

export interface ProviderUsage {
  fiveHour: UsageWindow | null
  week: UsageWindow | null
  plan?: string
  /** Quando o dado foi obtido */
  at: number
  error?: string
}

/** Consumo das assinaturas Claude e ChatGPT (Codex) */
export interface UsageInfo {
  claude: ProviderUsage | null
  codex: ProviderUsage | null
  /** Antigravity não expõe limites localmente: só a conta */
  agy: ProviderUsage | null
}

/** Modelos de cada CLI: vistos nas sessões recentes (ids reais) e o catálogo que o CLI guarda localmente */
export interface KnownModels {
  claude: string[]
  codex: string[]
  /** Catálogo do Codex (~/.codex/models_cache.json), na ordem do app */
  codexCatalog: ModelInfo[]
  /** Catálogo do Antigravity (`agy models`) */
  agyCatalog: ModelInfo[]
  agy: string[]
}

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
  /** id da sugestão (commit vinculado pelo Ovseer), quando o commit veio da lista */
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
  agy: string | null
  ollama: boolean
}

export interface OvseerApi {
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
  /** Configurações salvas por outra janela */
  onSettingsChanged(cb: (s: Settings) => void): () => void
  listModels(): Promise<string[]>
  detectProviders(): Promise<ProviderStatus>
  /** Situação do login de um CLI (o Antigravity só informa; o login é pelo próprio comando) */
  authStatus(provider: CliProvider): Promise<AuthStatus>
  authLogin(provider: AuthProvider): Promise<void>
  authSendCode(code: string): Promise<void>
  authCancel(): Promise<void>
  authLogout(provider: AuthProvider): Promise<AuthStatus>
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
  /** Arrasto manual da janela: `begin` marca a posição inicial; depois, deslocamentos em pixels desde o clique */
  windowDrag(dx: number, dy: number, begin?: boolean): void
  /** Janela exclusiva de um agente de IA (Claude Code ou Codex) */
  agentOpen(opts: AgentChatOpen): Promise<AgentWindowInfo>
  agentInfo(uid: string): Promise<AgentWindowInfo | null>
  agentSend(uid: string, text: string, opts: AgentSendOptions, attachments?: AgentAttachment[]): Promise<void>
  agentCancel(uid: string): Promise<void>
  /** Conversa nova na mesma janela, com o mesmo agente (interrompe a resposta em curso) */
  agentNewChat(uid: string): Promise<void>
  /** Volta à conversa anterior a "Nova conversa"; false se a nova já começou */
  agentBack(uid: string): Promise<boolean>
  /** Entrega a mensagem ao agente no meio da resposta, sem interromper (só Claude). false: não havia resposta em andamento */
  agentSteer(uid: string, text: string, attachments?: AgentAttachment[]): Promise<boolean>
  /** Escolher arquivos para anexar (diálogo do sistema) */
  agentPickFiles(uid: string): Promise<AgentAttachment[]>
  /** Guarda um arquivo sem caminho (imagem colada, gravação) e devolve o anexo */
  agentSaveBlob(uid: string, file: { name: string; type: string; data: ArrayBuffer }): Promise<AgentAttachment>
  /** Caminho real de um arquivo arrastado para a janela (vazio se não houver) */
  filePath(file: File): string
  /** Histórico de conversas abertas pelo Ovseer (todas, ou só de um projeto) */
  agentHistory(cwd?: string): Promise<AgentHistoryItem[]>
  /** Guarda a transcrição da janela (só depois que a sessão do CLI existe) */
  agentSaveTranscript(uid: string, turns: AgentTurn[]): Promise<void>
  /** Repositório de cada arquivo fora do projeto da janela (para cards de transcrições antigas, sem essa informação) */
  agentFileRepos(uid: string, paths: string[]): Promise<Record<string, FileRepo>>
  agentLoadTranscript(sessionId: string): Promise<AgentTurn[] | null>
  agentForget(sessionId: string): Promise<void>
  /** Fixa (ou solta) a conversa no topo da lista */
  agentPin(sessionId: string, pinned: boolean): Promise<void>
  /** Renomeia a conversa (vazio volta ao título automático) */
  agentSetTitle(uid: string, title: string): Promise<string>
  /** Traz para frente a janela da conversa; false se ela não foi aberta pelo Ovseer */
  agentFocus(sessionId: string): Promise<boolean>
  /** Ids das sessões com janela aberta no Ovseer */
  agentWindows(): Promise<string[]>
  /** Move e redimensiona a janela do agente para a área do grid, na tela onde ela está */
  agentPlace(uid: string, p: GridPlacement): Promise<WindowBounds>
  knownModels(): Promise<KnownModels>
  /** Consumo das assinaturas (Claude pelo endpoint da conta; Codex pelos registros locais). `force` ignora o cache. */
  usage(force?: boolean): Promise<UsageInfo>
  onAgentEvent(cb: (uid: string, ev: AgentChatEvent) => void): () => void
  onAgentWindows(cb: (sessionIds: string[]) => void): () => void
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
