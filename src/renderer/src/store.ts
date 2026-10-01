import { computed, reactive } from 'vue'
import { heuristicGroups, slugify } from '@shared/parse'
import { applyTheme } from './theme'
import type {
  Analysis, ChangeGroup, CommitInfo, FileChange, OperationResult, OvseerNewTask, OvseerStatus, OvseerTask, RepoStatus,
  AgentSession, AgentSnapshot, AgentStatus, CheckFinding, PullRequestInfo, SavedChanges, Settings, SshConnection, TerminalSpec, UpdateState
} from '@shared/types'

const api = window.ovseer

export type Busy = null | 'load' | 'analyze' | 'message' | 'commit' | 'pull' | 'push' | 'feature' | 'merge'

export type ViewMode = 'tree' | 'list'
/** Lista da esquerda: arquivos alterados (diff à direita) ou todos os arquivos do projeto (editor à direita) */
export type Pane = 'changes' | 'files'

export const state = reactive({
  repo: null as RepoStatus | null,
  settings: null as Settings | null,
  /** Plano de commits sugerido pela IA (só existe depois de "Analisar com IA") */
  groups: [] as ChangeGroup[],
  /** Commits do plano que o usuário desmarcou no modal */
  planExcluded: new Set<string>(),
  planOpen: false,
  /** Os arquivos mudaram desde a análise salva */
  planStale: false,
  viewMode: (readPref('ovseer.view') === 'list' ? 'list' : 'tree') as ViewMode,
  analysis: null as Analysis | null,
  selected: new Set<string>(),
  /** Pastas recolhidas na árvore */
  collapsed: new Set<string>(),
  activeFile: null as FileChange | null,
  diff: '',
  diffLoading: false,
  history: [] as CommitInfo[],
  /** Aba da área principal: o app abre no gerenciador de agentes */
  tab: 'agents' as 'changes' | 'history' | 'agents',
  message: '',
  messageEdited: false,
  busy: null as Busy,
  error: null as string | null,
  result: null as (OperationResult & { title: string }) | null,
  toast: null as string | null,
  showSettings: false,
  /** Atualização do app (versão nova disponível, baixando, pronta para instalar) */
  update: null as UpdateState | null,
  showDiff: readPref('ovseer.diff') === '1' || readPref('ovseer.pane') === 'files',
  /** Árvore de arquivos oculta enquanto o editor está aberto: o editor ocupa a largura toda */
  hideTree: readPref('ovseer.hideTree') === '1',
  /** Janela estreita com o diff/editor aberto: a coluna de arquivos vira um painel flutuante, aberto por este sinal */
  listOverlay: false,
  showTerminal: readPref('ovseer.terminal') === '1',
  /** Terminal ocupando toda a área do app (abaixo da barra superior) */
  terminalMax: readPref('ovseer.terminalMax') === '1',
  analyzeStartedAt: 0,
  /** Integração com o Ovseer */
  ovseer: null as OvseerStatus | null,
  tasks: [] as OvseerTask[],
  tasksLoading: false,
  tasksError: null as string | null,
  /** Tarefa do commit único (fica selecionada entre commits, até o usuário trocar) */
  commitTaskId: null as string | null,
  /** Tarefa de cada commit do plano da IA */
  planTasks: {} as Record<string, string | null>,
  /** Painel de tarefas à esquerda, formulário de nova tarefa e canal em tempo real */
  showTasks: readPref('ovseer.tasks') === '1',
  showNewTask: false,
  deliveryTask: null as OvseerTask | null,
  /** Tarefa aberta nos detalhes */
  detailTaskId: null as string | null,
  /** Conexão SSH em edição (ou 'new' para criar) */
  sshEdit: null as SshConnection | 'new' | null,
  /** Pedido para o terminal abrir uma aba (a UI do terminal consome) */
  terminalRequest: null as TerminalSpec | null,
  /** Confirmação em linguagem simples (substitui o window.confirm) */
  confirm: null as null | {
    title: string
    message: string
    confirmLabel: string
    danger?: boolean
    resolve: (ok: boolean) => void
  },
  saved: [] as SavedChanges[],
  showCleanup: false,
  showClone: false,
  showSshImport: false,
  /** Tarefas de agentes externos (ChatGPT/Codex e Claude) */
  agents: [] as AgentSession[],
  /** Sessões de agentes com janela aberta pelo Ovseer */
  agentWindows: [] as string[],
  /** Situação das conversas com janela aberta, por id de sessão */
  agentStatuses: {} as Record<string, AgentStatus>,
  /** Resumo de cada janela de agente aberta (gerenciador de agentes) */
  agentSnaps: [] as AgentSnapshot[],
  /** Concluídos já vistos no gerenciador (uid:momento em que concluiu): os outros aparecem como "novo" */
  agentSeen: new Set<string>(),
  showNewAgent: false,
  /** Tarefa do Ovseer que o novo agente vai executar (plano aprovado vira a primeira mensagem) */
  newAgentTask: null as OvseerTask | null,
  /** Pedido pronto para o novo agente (ex.: resolver os conflitos do merge), mostrado no diálogo */
  newAgentBrief: null as { label: string; message: string } | null,
  /** Pull Request da linha atual */
  pr: null as PullRequestInfo | null,
  showPrDialog: false,
  /** Pontos de atenção (checagem antes de salvar ou revisão da IA) */
  review: null as null | {
    source: 'check' | 'ai'
    findings: CheckFinding[]
    resolve?: (proceed: boolean) => void
  },
  /** Resolução de conflito proposta pela IA */
  resolution: null as null | { file: string; content: string; explanation: string },
  /** Trechos (hunks) deixados de fora, por arquivo; e quantos trechos cada arquivo tem */
  excludedHunks: {} as Record<string, number[]>,
  hunkCounts: {} as Record<string, number>,
  diffMode: (readPref('ovseer.diffMode') === 'split' ? 'split' : 'unified') as 'unified' | 'split',
  ovseerLive: false,
  pane: (readPref('ovseer.pane') === 'files' ? 'files' : 'changes') as Pane,
  /** Arquivos do projeto (modo "Arquivos") */
  sourceList: [] as string[],
  sourceLoading: false,
  /** Arquivo aberto no editor (a aba ativa) e as abas abertas, na ordem */
  sourcePath: null as string | null,
  sourceTabs: [] as string[],
  /** Aba temporária (clique simples): o próximo arquivo aberto assim a substitui; duplo clique ou editar a fixa */
  sourcePreview: null as string | null,
  /** Quando cada arquivo aberto foi lido/salvo (para não sobrescrever mudanças feitas por outro) */
  sourceMtimes: {} as Record<string, number>,
  /** Arquivos cujo salvamento automático parou porque mudaram no disco enquanto eram editados */
  sourceConflicts: {} as Record<string, boolean>,
  /** Pastas abertas na árvore de arquivos (começam fechadas) */
  sourceOpen: new Set<string>(),
  /** Edições não salvas, por arquivo: sobrevivem à troca de arquivo */
  sourceDrafts: {} as Record<string, string>
})

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* preferência só desta sessão */
  }
}

export function setShowDiff(v: boolean) {
  state.showDiff = v
  writePref('ovseer.diff', v ? '1' : '0')
}

export function setHideTree(v: boolean) {
  state.hideTree = v
  writePref('ovseer.hideTree', v ? '1' : '0')
}
/** Janela estreita (o diff ocupa a área toda): a coluna de arquivos abre e fecha como painel flutuante */
export const narrowQuery = window.matchMedia('(max-width: 760px)')
export function toggleListOverlay() {
  state.listOverlay = !state.listOverlay
}

export function setShowTerminal(v: boolean) {
  state.showTerminal = v
  writePref('ovseer.terminal', v ? '1' : '0')
}

export function setShowTasks(v: boolean) {
  state.showTasks = v
  writePref('ovseer.tasks', v ? '1' : '0')
  if (v) loadTasks()
}

export function setTerminalMax(v: boolean) {
  state.terminalMax = v
  writePref('ovseer.terminalMax', v ? '1' : '0')
}

export function setDiffMode(v: 'unified' | 'split') {
  state.diffMode = v
  writePref('ovseer.diffMode', v)
}

/** Inclui/exclui um trecho do arquivo na próxima versão. Excluir todos = desmarcar o arquivo. */
export function toggleHunk(path: string, index: number) {
  const total = state.hunkCounts[path] ?? 0
  const cur = new Set(state.excludedHunks[path] ?? [])
  if (cur.has(index)) cur.delete(index)
  else cur.add(index)
  const sel = new Set(state.selected)
  if (cur.size >= total && total > 0) {
    delete state.excludedHunks[path]
    sel.delete(path)
  } else {
    state.excludedHunks[path] = [...cur].sort((a, b) => a - b)
    sel.add(path)
  }
  state.selected = sel
}

export function isPartial(path: string) {
  return (state.excludedHunks[path]?.length ?? 0) > 0 && state.selected.has(path)
}

export function setPane(v: Pane) {
  const from = state.pane
  state.pane = v
  writePref('ovseer.pane', v)
  // no modo Arquivos a coluna da direita (o editor) já abre junto; saindo dele para Alterações, ela fecha
  if (v === 'files' && !state.showDiff) setShowDiff(true)
  else if (from === 'files' && v !== 'files' && state.showDiff) setShowDiff(false)
  if (v === 'files') loadSourceFiles()
}

export async function loadSourceFiles() {
  if (!state.repo) return
  state.sourceLoading = !state.sourceList.length
  try {
    state.sourceList = await api.sourceFiles()
    // arquivo apagado (e sem edição pendente): a aba fecha, como no JetBrains
    const gone = state.sourceTabs.filter((p) => !state.sourceList.includes(p) && !(p in state.sourceDrafts))
    for (const p of gone) closeSource(p)
  } catch (e) {
    state.error = cleanError(e)
  } finally {
    state.sourceLoading = false
  }
}

/**
 * Abre no editor, como no JetBrains: clique simples abre numa aba temporária, que o próximo arquivo aberto assim
 * substitui; `pin` (duplo clique) abre numa aba fixa, ou fixa a temporária.
 */
export function openSource(path: string, pin = false) {
  state.listOverlay = false
  if (state.sourceTabs.includes(path)) {
    if (pin && state.sourcePreview === path) state.sourcePreview = null
  } else {
    const prev = state.sourcePreview
    const at = prev ? state.sourceTabs.indexOf(prev) : state.sourcePath ? state.sourceTabs.indexOf(state.sourcePath) + 1 : state.sourceTabs.length
    if (prev) {
      // a temporária dá lugar ao novo arquivo (salvando antes o que estiver pendente nela)
      if (prev in state.sourceDrafts && !state.sourceConflicts[prev]) void saveSource(prev)
      state.sourceTabs.splice(at, 1, path)
    } else state.sourceTabs.splice(at || state.sourceTabs.length, 0, path)
    state.sourcePreview = pin ? null : path
  }
  state.sourcePath = path
  setShowDiff(true)
  revealSource(path)
  saveTabs()
}

/** Abre na árvore as pastas até o caminho (`dir`: o próprio caminho é uma pasta e também abre) */
export function revealSource(path: string, dir = false) {
  const parts = path.split('/')
  const open = new Set(state.sourceOpen)
  for (let i = 1; i < parts.length + (dir ? 1 : 0); i++) open.add(parts.slice(0, i).join('/'))
  state.sourceOpen = open
}

/** Fecha a aba (salvando antes o que estiver pendente); a ativa passa para a vizinha */
export async function closeSource(path: string) {
  if (path in state.sourceDrafts && !state.sourceConflicts[path]) await saveSource(path)
  const i = state.sourceTabs.indexOf(path)
  if (i < 0) return
  state.sourceTabs.splice(i, 1)
  delete state.sourceDrafts[path]
  delete state.sourceMtimes[path]
  delete state.sourceConflicts[path]
  if (state.sourcePreview === path) state.sourcePreview = null
  if (state.sourcePath === path) state.sourcePath = state.sourceTabs[Math.min(i, state.sourceTabs.length - 1)] ?? null
  saveTabs()
}

/** Torna fixa a aba temporária (duplo clique nela, ou quando o arquivo é editado) */
export function pinSource(path: string) {
  if (state.sourcePreview !== path) return
  state.sourcePreview = null
  saveTabs()
}

export function closeOtherSources(keep: string) {
  for (const p of [...state.sourceTabs]) if (p !== keep) closeSource(p)
}

/**
 * Salva a edição pendente do arquivo (o editor chama sozinho, logo depois de parar de digitar).
 * Se o arquivo mudou no disco desde a leitura, não sobrescreve: marca conflito e o editor pergunta o que fazer.
 * `force` sobrescreve mesmo assim.
 */
export async function saveSource(path: string, force = false): Promise<boolean> {
  const text = state.sourceDrafts[path]
  if (text === undefined) return true
  try {
    state.sourceMtimes[path] = await api.writeSource(path, text, force ? undefined : state.sourceMtimes[path])
    if (state.sourceDrafts[path] === text) delete state.sourceDrafts[path]
    delete state.sourceConflicts[path]
    refreshSoon()
    return true
  } catch (e) {
    const msg = cleanError(e)
    if (/mudou no disco/.test(msg)) state.sourceConflicts[path] = true
    else state.error = msg
    return false
  }
}

/** Atualiza a lista de alterações depois de salvar, sem disparar a cada tecla */
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function refreshSoon() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => refresh(), 1500)
}

/** Abas abertas de cada projeto ficam lembradas */
function saveTabs() {
  if (state.repo) writePref(`ovseer.tabs:${state.repo.root}`, JSON.stringify({ tabs: state.sourceTabs, active: state.sourcePath, preview: state.sourcePreview }))
}
function restoreTabs(root: string) {
  try {
    const v = JSON.parse(readPref(`ovseer.tabs:${root}`) ?? 'null') as { tabs?: string[]; active?: string | null; preview?: string | null } | null
    state.sourceTabs = Array.isArray(v?.tabs) ? v.tabs.filter((p) => typeof p === 'string') : []
    state.sourcePath = v?.active && state.sourceTabs.includes(v.active) ? v.active : (state.sourceTabs[0] ?? null)
    state.sourcePreview = v?.preview && state.sourceTabs.includes(v.preview) ? v.preview : null
  } catch {
    state.sourceTabs = []
    state.sourcePreview = null
    state.sourcePath = null
  }
}

export function toggleSourceDir(dir: string) {
  const open = new Set(state.sourceOpen)
  if (open.has(dir)) open.delete(dir)
  else open.add(dir)
  state.sourceOpen = open
}

export function setViewMode(v: ViewMode) {
  state.viewMode = v
  writePref('ovseer.view', v)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string) {
  state.toast = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (state.toast = null), 3500)
}

export const fileMap = computed(() => new Map((state.repo?.files ?? []).map((f) => [f.path, f])))

/** Commits do plano da IA que serão criados (os não desmarcados). */
export const planGroups = computed(() => state.groups.filter((g) => !state.planExcluded.has(g.id)))

/** Arquivos alterados que não entraram na análise (apareceram depois dela). */
export const outsidePlan = computed(() => {
  const inPlan = new Set(state.groups.flatMap((g) => g.files))
  return (state.repo?.files ?? []).filter((f) => !inPlan.has(f.path))
})

export const hasPlan = computed(() => state.analysis?.source === 'ai' && state.groups.length > 0)

/** Mensagem sugerida para o commit único: a mensagem geral da IA, se houver análise. */
export const suggestedMessage = computed(() =>
  hasPlan.value && !state.planStale ? (state.analysis?.commit ?? '') : ''
)

/** Nome sugerido para a feature: o da IA, ou as pastas com mais alterações. */
export const suggestedBranch = computed(
  () =>
    state.analysis?.branch ||
    slugify(
      heuristicGroups(state.repo?.files ?? [])
        .slice(0, 2)
        .map((g) => g.title)
        .join('-')
    )
)

/** Mantém o plano da última análise só com os arquivos que ainda estão alterados. */
function reconcile(files: FileChange[], prevFiles: FileChange[]) {
  const present = new Set(files.map((f) => f.path))
  const hadPlan = state.groups.length > 0
  state.groups = state.groups
    .map((g) => ({ ...g, files: g.files.filter((p) => present.has(p)) }))
    .filter((g) => g.files.length)
  if (!state.groups.length) {
    state.analysis = null
    state.planStale = false
    // plano todo usado (ou arquivos descartados): não restaura mais ao reabrir
    if (hadPlan) api.clearAnalysis()
  }

  const known = new Set(prevFiles.map((f) => f.path))
  const nextSelected = new Set<string>()
  for (const p of present) {
    // arquivos que acabaram de aparecer entram marcados; os demais mantêm a escolha do usuário
    if (state.selected.has(p) || !known.has(p)) nextSelected.add(p)
  }
  state.selected = nextSelected
  // seleção de trechos de arquivos que sumiram da lista não vale mais
  for (const p of Object.keys(state.excludedHunks)) if (!present.has(p)) delete state.excludedHunks[p]
  if (state.activeFile && !present.has(state.activeFile.path)) {
    state.activeFile = null
    state.diff = ''
  }
}

async function guard<T>(busy: Busy, fn: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) return
  state.busy = busy
  state.error = null
  try {
    return await fn()
  } catch (e) {
    state.error = cleanError(e)
  } finally {
    state.busy = null
  }
}

function cleanError(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export async function init() {
  state.settings = await api.getSettings()
  applyTheme(state.settings.theme)
  listenAgents()
  listenOvseer()
  api.onUpdate((s) => (state.update = s))
  api.onAwsAlert((a) => toast(`${a.title}: ${a.body}`))
  api.updateState().then((s) => (state.update = s))
  refreshOvseer()
  if (state.settings.lastProject) {
    try {
      await openRepo(await api.loadProject(state.settings.lastProject))
    } catch {
      /* projeto removido ou movido: mostra a tela inicial */
    }
  }
}

/** Abre um projeto restaurando a última análise salva dele. */
async function openRepo(repo: RepoStatus | null) {
  if (!repo) return
  if (state.repo?.root === repo.root) return applyRepo(repo)
  const saved = await api.savedAnalysis().catch(() => null)
  applyRepo(repo, saved?.analysis ?? null)
  state.planStale = saved?.stale ?? false
}

function applyRepo(repo: RepoStatus | null, saved: Analysis | null = null) {
  if (!repo) return
  const changedRepo = state.repo?.root !== repo.root
  if (changedRepo) {
    state.groups = saved?.source === 'ai' ? saved.groups.map((g) => ({ ...g, files: [...g.files] })) : []
    state.analysis = saved?.source === 'ai' ? saved : null
    state.planExcluded = new Set()
    state.planOpen = false
    state.excludedHunks = {}
    state.hunkCounts = {}
    state.collapsed = new Set()
    state.selected = new Set(repo.files.map((f) => f.path))
    state.activeFile = null
    state.diff = ''
    state.sourceList = []
    state.sourceOpen = new Set()
    state.sourceDrafts = {}
    state.sourceMtimes = {}
    state.sourceConflicts = {}
    restoreTabs(repo.root)
    if (state.sourcePath) revealSource(state.sourcePath)
    state.message = ''
    state.messageEdited = false
  }
  const prevFiles = changedRepo ? repo.files : (state.repo?.files ?? [])
  state.repo = repo
  // depois de state.repo: a lista de arquivos é do projeto que acabou de abrir
  if (changedRepo && state.pane === 'files') loadSourceFiles()
  reconcile(repo.files, prevFiles)
  if (!state.messageEdited) state.message = suggestedMessage.value
  if (state.tab === 'history' || changedRepo) loadHistory()
  loadPr(changedRepo)
}

export async function openProject() {
  await guard('load', async () => {
    const repo = await api.openProject()
    if (repo) {
      await openRepo(repo)
      state.settings = await api.getSettings()
    }
  })
}

/** Depois de clonar: abre o projeto novo. */
export async function openCloned(repo: RepoStatus) {
  await openRepo(repo)
  state.settings = await api.getSettings()
  toast(`${repo.name} copiado e aberto.`)
}

export async function loadProject(path: string) {
  await guard('load', async () => {
    await openRepo(await api.loadProject(path))
    state.settings = await api.getSettings()
  })
}

export async function refresh() {
  if (!state.repo || state.busy) return
  try {
    applyRepo(await api.status())
    if (state.activeFile) await selectFile(fileMap.value.get(state.activeFile.path) ?? null, true)
    if (state.pane === 'files') loadSourceFiles()
  } catch (e) {
    state.error = cleanError(e)
  }
}

export async function loadHistory() {
  if (!state.repo) return
  loadSaved()
  try {
    state.history = await api.log(100)
  } catch (e) {
    state.error = cleanError(e)
  }
}

export async function selectFile(file: FileChange | null, silent = false) {
  state.activeFile = file
  if (file && !silent) state.listOverlay = false
  if (file && !silent) setShowDiff(true)
  if (!file) {
    state.diff = ''
    return
  }
  if (!silent) state.diffLoading = true
  try {
    // cópia sem os objetos reativos do Vue (a contagem de linhas é um objeto dentro do arquivo): a IPC não os copia
    const text = await api.diff({ ...file, stats: file.stats && { ...file.stats } })
    if (state.activeFile?.path === file.path) state.diff = text
  } catch (e) {
    state.diff = ''
    state.error = cleanError(e)
  } finally {
    state.diffLoading = false
  }
}

export async function analyze(force = false) {
  if (!state.repo?.files.length) return
  if (state.repo.operation) return toast('Conclua ou aborte o merge antes de analisar.')
  if (state.settings?.provider === 'none') {
    toast('Escolha uma IA nas Configurações.')
    state.showSettings = true
    return
  }
  state.analyzeStartedAt = Date.now()
  await guard('analyze', async () => {
    let a: Analysis
    try {
      // tarefas em andamento no Ovseer: a IA agrupa as alterações por tarefa e já liga cada versão à sua
      const hints = state.tasks
        .filter((t) => t.section === 'execution' || t.section === 'paused' || t.status === 'doing' || t.status === 'paused')
        .map((t) => ({ key: t.key, title: t.title, status: t.statusLabel || t.status }))
      a = await api.analyze(force, hints)
    } catch (e) {
      if (/CANCELADO/.test(String((e as Error).message))) return toast('Análise cancelada.')
      throw e
    }
    if (a.source !== 'ai') {
      // a IA falhou: não inventa um plano, só avisa
      state.error = a.warning?.replace(/ — agrupado por pasta\.$/, '') ?? 'A IA não respondeu.'
      if (/sem login|não encontrado/i.test(a.warning ?? '')) state.showSettings = true
      return
    }
    state.analysis = a
    state.groups = a.groups
    // por padrão, todos os commits do plano vão para a tarefa já escolhida (se houver)
    // tarefa de cada versão: a que a IA indicou; senão, a já escolhida na caixa de mensagem
    const byKey = new Map(state.tasks.map((t) => [t.key.toUpperCase(), t.id]))
    state.planTasks = Object.fromEntries(
      a.groups.map((g) => [g.id, (g.task && byKey.get(g.task.toUpperCase())) || state.commitTaskId])
    )
    state.planStale = false
    state.planExcluded = new Set()
    state.messageEdited = false
    state.message = suggestedMessage.value
    state.planOpen = true
  })
}

export function openPlan() {
  if (!hasPlan.value) return
  // commits do plano sem tarefa definida herdam a tarefa escolhida na barra (se houver)
  const byKey = new Map(state.tasks.map((t) => [t.key.toUpperCase(), t.id]))
  for (const g of state.groups)
    if (!(g.id in state.planTasks)) state.planTasks[g.id] = (g.task && byKey.get(g.task.toUpperCase())) || state.commitTaskId
  state.planOpen = true
}

export function togglePlanGroup(id: string) {
  const s = new Set(state.planExcluded)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  state.planExcluded = s
}

/** Cria os commits do plano da IA, um por grupo (cada arquivo entra em um único commit). */
export async function commitPlan() {
  const groups = planGroups.value.map((g) => ({ files: [...g.files], message: g.commit.trim() }))
  if (!groups.length) return toast('Marque ao menos um commit.')
  if (groups.some((g) => !g.message)) return toast('Todos os commits precisam de mensagem.')
  state.planOpen = false
  await guard('commit', async () => {
    const taskIds = planGroups.value.map((g) => state.planTasks[g.id] ?? null)
    const r = await api.commitGroups(groups)
    state.messageEdited = false
    await linkToTasks(r, (i) => taskIds[i] ?? null)
    // deu certo: só um aviso curto (a lista de versões já mostra cada commit); a caixa fica para erros
    await afterOperation(`${groups.length} commit${groups.length === 1 ? '' : 's'}`, r, true)
    if (r.ok) toast(`${groups.length} ${groups.length === 1 ? 'versão salva' : 'versões salvas'} no seu computador. Use Enviar para mandar ao servidor.`)
  })
}

/** Descarta o plano e usa a mensagem geral da IA num commit único. */
/** Há versões do plano que dividem a mesma tarefa (dá para juntar em uma por tarefa). */
export const canJoinByTask = computed(() => {
  const seen = new Set<string>()
  for (const g of state.groups) {
    const t = state.planTasks[g.id]
    if (!t || state.planExcluded.has(g.id)) continue
    if (seen.has(t)) return true
    seen.add(t)
  }
  return false
})

/** Junta as versões do plano que são da mesma tarefa: fica uma versão por tarefa. */
export function joinByTask() {
  const out: ChangeGroup[] = []
  const byTask = new Map<string, ChangeGroup>()
  const tasks: Record<string, string | null> = {}
  for (const g of state.groups) {
    const t = state.planExcluded.has(g.id) ? null : state.planTasks[g.id]
    const into = t ? byTask.get(t) : undefined
    if (!into) {
      const copy = { ...g, files: [...g.files], bullets: [...g.bullets] }
      out.push(copy)
      tasks[copy.id] = state.planTasks[g.id] ?? null
      if (t) byTask.set(t, copy)
      continue
    }
    const task = state.tasks.find((x) => x.id === t)
    into.files.push(...g.files)
    into.bullets = [...into.bullets, ...g.bullets].slice(0, 6)
    if (g.type === 'feat' || (g.type === 'fix' && into.type !== 'feat')) into.type = g.type
    if (task) into.title = task.title.length > 48 ? `${task.title.slice(0, 47)}…` : task.title
    into.summary = [into.summary, g.summary].filter(Boolean).join(' ')
    // a descrição da primeira vira a principal; as outras entram como detalhes
    const [head, , ...details] = into.commit.split('\n')
    into.commit = `${head}\n\n${[...details.filter(Boolean), `- ${g.commit.split('\n')[0]}`].join('\n')}`
  }
  state.groups = out
  state.planTasks = tasks
}

export function useSingleCommit() {
  state.planOpen = false
  state.planStale = false
  if (state.analysis?.commit) {
    state.message = state.analysis.commit
    state.messageEdited = true
  }
}

/** Gera com IA uma mensagem de commit única para os arquivos selecionados. Clicar de novo cancela. */
export async function generateMessage() {
  if (state.busy === 'message') return api.cancelAnalysis()
  const files = [...state.selected]
  if (!files.length) return toast('Selecione ao menos um arquivo.')
  if (state.settings?.provider === 'none') {
    toast('Escolha uma IA nas Configurações.')
    state.showSettings = true
    return
  }
  await guard('message', async () => {
    try {
      const msg = await api.commitMessage(files)
      state.message = msg
      state.messageEdited = true
    } catch (e) {
      const text = cleanError(e)
      if (/CANCELADO/.test(text)) return toast('Geração cancelada.')
      if (/sem login|não encontrado/i.test(text)) state.showSettings = true
      throw new Error(text)
    }
  })
}

export function cancelAnalysis() {
  api.cancelAnalysis()
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Grava as edições do usuário nas mensagens dos grupos, para sobreviverem ao reinício do app. */
function persistAnalysis() {
  if (!state.analysis) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!state.analysis) return
    const groups = state.groups.map((g) => ({ ...g, files: [...g.files] }))
    api.saveAnalysis({ ...JSON.parse(JSON.stringify(state.analysis)), groups })
  }, 500)
}

export function setMessage(msg: string) {
  state.message = msg
  state.messageEdited = msg.trim() !== '' && msg !== suggestedMessage.value
}

function syncMessage() {
  if (!state.messageEdited) state.message = suggestedMessage.value
}

export function toggleFile(path: string) {
  const s = new Set(state.selected)
  delete state.excludedHunks[path] // marcar/desmarcar o arquivo todo zera a escolha de trechos
  if (s.has(path)) s.delete(path)
  else s.add(path)
  state.selected = s
  syncMessage()
}

/** Marca/desmarca todos os arquivos de uma pasta. */
export function toggleFiles(paths: string[]) {
  const s = new Set(state.selected)
  const all = paths.every((p) => s.has(p))
  paths.forEach((p) => (all ? s.delete(p) : s.add(p)))
  state.selected = s
}

export function toggleAll() {
  const files = state.repo?.files ?? []
  state.selected = state.selected.size === files.length ? new Set() : new Set(files.map((f) => f.path))
  syncMessage()
}

export function toggleCollapsed(id: string) {
  const s = new Set(state.collapsed)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  state.collapsed = s
}

export function updateGroupCommit(id: string, commit: string) {
  const g = state.groups.find((x) => x.id === id)
  if (g) g.commit = commit
  persistAnalysis()
}

async function afterOperation(title: string, r: OperationResult, quiet = false) {
  applyRepo(await api.status())
  await loadHistory()
  if (!r.ok || !quiet) state.result = { ...r, title }
}

/** Salva a versão; com `andPush`, envia ao servidor logo em seguida (se salvou). */
export async function commit(andPush = false) {
  const files = [...state.selected]
  if (!files.length) return toast('Marque ao menos um arquivo.')
  if (!state.message.trim()) return toast('Escreva o que você fez.')
  const partial = files
    .filter((p) => isPartial(p))
    .map((p) => ({
      path: p,
      hunks: Array.from({ length: state.hunkCounts[p] ?? 0 }, (_, i) => i).filter((i) => !state.excludedHunks[p].includes(i))
    }))
  const full = files.filter((p) => !isPartial(p))
  // checagem rápida (sem IA): segredos, .env, depuração esquecida, marcas de conflito…
  const findings = await api.quickCheck(files).catch(() => [] as CheckFinding[])
  if (findings.length) {
    const proceed = await new Promise<boolean>((resolve) => (state.review = { source: 'check', findings, resolve }))
    if (!proceed) return
  }
  const saved = await guard('commit', async () => {
    const r = partial.length
      ? await api.commitPartial(full, partial, state.message.trim())
      : await api.commit(files, state.message.trim())
    if (r.ok) state.excludedHunks = {}
    state.messageEdited = false
    if (r.ok) await linkToTasks(r, () => state.commitTaskId)
    await afterOperation('Salvar versão', r, true)
    if (r.ok && !state.commitTaskId && !andPush) toast('Versão salva no seu computador. Use Enviar para mandar ao servidor.')
    return r.ok
  })
  if (saved && andPush) await push()
}

export async function pull(stash: boolean): Promise<'dirty' | void> {
  let dirty = false
  await guard('pull', async () => {
    const r = await api.pull(stash)
    if (r.error === 'DIRTY') {
      dirty = true
      return
    }
    await afterOperation('Baixar', r, true)
    if (r.ok) toast(r.steps.find((s) => s.label === 'Baixar')?.detail || 'Alterações baixadas.')
  })
  if (dirty) return 'dirty'
}

export async function push() {
  await guard('push', async () => {
    const r = await api.push()
    await afterOperation('Enviar', r, true)
    if (r.ok)
      toast(
        r.steps.some((s) => s.label.startsWith('O servidor tinha versões novas'))
          ? 'O servidor tinha versões novas: baixamos, juntamos às suas e enviamos tudo.'
          : (r.steps.at(-1)?.label ?? 'Enviado.')
      )
  })
}

export async function publishToUrl(url: string) {
  await guard('push', async () => afterOperation('Publicar', await api.publishToUrl(url)))
}

export async function publishToGitHub(name: string, isPrivate: boolean) {
  await guard('push', async () => afterOperation('Publicar no GitHub', await api.publishToGitHub(name, isPrivate)))
}

/**
 * Cria a feature. Com `commitPlanFirst`, antes cria os commits do plano da IA,
 * para a feature já nascer com o histórico organizado.
 */
export async function createFeature(name: string, prefix: string, commitPlanFirst = false) {
  await guard('feature', async () => {
    const steps: OperationResult['steps'] = []
    if (commitPlanFirst) {
      const groups = planGroups.value.map((g) => ({ files: [...g.files], message: g.commit.trim() }))
      if (groups.length) {
        const taskIds = planGroups.value.map((g) => state.planTasks[g.id] ?? null)
        const c = await api.commitGroups(groups)
        await linkToTasks(c, (i) => taskIds[i] ?? null)
        steps.push(...c.steps)
        if (!c.ok) return afterOperation('Criar Feature', { ...c, steps })
        state.messageEdited = false
      }
    }
    const r = await api.createFeature(name, prefix)
    await afterOperation('Criar Feature', { ...r, steps: [...steps, ...r.steps] })
  })
}

export async function forgetProject(path: string) {
  const recent = (state.settings?.recentProjects ?? []).filter((p) => p !== path)
  await saveSettings({ recentProjects: recent })
}

export async function resolveConflict(file: string, choice: 'mine' | 'theirs' | 'resolved') {
  await guard('merge', async () => {
    const r = await api.resolveConflict(file, choice)
    await afterOperation('Resolver conflito', r, true)
    if (r.ok) toast(r.steps[0]?.label ?? 'Resolvido.')
  })
}

export async function abortOperation() {
  const op = state.repo?.operation
  if (!op) return
  const ok = await ask({
    title: 'Cancelar a junção das versões?',
    message:
      'O projeto volta a ficar exatamente como estava antes de baixar as atualizações. As escolhas feitas nos arquivos com conflito até agora serão perdidas; suas alterações guardadas voltam para a lista.',
    confirmLabel: 'Cancelar junção',
    danger: true
  })
  if (!ok) return
  await guard('merge', async () => afterOperation(`Abortar ${op}`, await api.abortOperation()))
}

export async function continueOperation() {
  const op = state.repo?.operation
  if (!op) return
  await guard('merge', async () => afterOperation(`Concluir ${op}`, await api.continueOperation()))
}

export async function openInEditor() {
  try {
    toast(`Abrindo no ${await api.openInEditor()}…`)
  } catch (e) {
    state.error = cleanError(e)
  }
}

/** Favicons dos projetos (data URL), carregados sob demanda. */
export const projectIcons = reactive(new Map<string, string | null>())
export function loadProjectIcon(path: string) {
  if (projectIcons.has(path)) return
  projectIcons.set(path, null)
  api
    .projectIcon(path)
    .then((icon) => projectIcons.set(path, icon))
    .catch(() => undefined)
}

/** Workspace do Ovseer em uso: o escolhido nas Configurações, ou o primeiro disponível. */
export const ovseerWorkspace = computed(() => {
  const list = state.ovseer?.workspaces ?? []
  return list.find((w) => w.id === state.settings?.ovseerWorkspaceId) ?? list[0] ?? null
})

export const ovseerReady = computed(() => !!state.ovseer?.connected && !!ovseerWorkspace.value)

export async function refreshOvseer() {
  try {
    state.ovseer = await api.ovseerStatus()
  } catch {
    state.ovseer = null
  }
  // canal em tempo real: aberto enquanto estiver conectado
  api.ovseerLive(!!state.ovseer?.connected)
  if (ovseerReady.value) loadTasks(true)
  else state.tasks = []
}

let liveListening = false
/** Escuta o canal do Ovseer: mudanças em tarefas atualizam a lista na hora. */
function listenOvseer() {
  if (liveListening) return
  liveListening = true
  api.onOvseerLive((live) => (state.ovseerLive = live))
  api.onOvseerChange(async () => {
    const before = new Map(state.tasks.map((t) => [t.id, t]))
    await loadTasks(true)
    notifyTaskChanges(before)
    // token revogado no Ovseer: reflete na interface
    if (state.tasksError && /Conecte/i.test(state.tasksError)) refreshOvseer()
  })
}

/**
 * Avisos quando algo importante acontece com as minhas tarefas no Ovseer
 * (plano aprovado/recusado, entrega validada/devolvida).
 */
function notifyTaskChanges(before: Map<string, OvseerTask>) {
  const notify = (title: string, body: string) => {
    toast(`${title}: ${body}`)
    if (!document.hasFocus() && 'Notification' in window) {
      try {
        new Notification(title, { body, silent: false })
      } catch {
        /* notificações desativadas no sistema */
      }
    }
  }
  const now = new Map(state.tasks.map((t) => [t.id, t]))
  for (const [id, prev] of before) {
    if (!prev.assignedToMe) continue
    const cur = now.get(id)
    const label = `${prev.key} · ${prev.title}`
    if (!cur) {
      if (prev.section === 'completion_pending') notify('Entrega validada', label)
      continue
    }
    if (prev.section === cur.section) continue
    if (prev.section === 'plan_pending' && cur.section === 'waiting_execution') notify('Plano aprovado', label)
    else if (prev.section === 'plan_pending' && cur.section === 'plan_rejected') notify('Plano recusado', label)
    else if (prev.section === 'completion_pending' && (cur.section === 'execution' || cur.section === 'paused')) notify('Entrega devolvida', label)
  }
  for (const [id, cur] of now) {
    if (!before.has(id) && cur.assignedToMe && before.size) notify('Nova tarefa para você', `${cur.key} · ${cur.title}`)
  }
}

// ---------- agentes externos (Codex do app do ChatGPT) ----------
let agentsListening = false
function listenAgents() {
  if (agentsListening) return
  agentsListening = true
  api.agents().then((l) => (state.agents = l)).catch(() => undefined)
  api.onAgents((l) => (state.agents = l))
  api.agentWindows().then((l) => (state.agentWindows = l)).catch(() => undefined)
  api.onAgentWindows((l) => (state.agentWindows = l))
  api.agentStatuses().then((s) => (state.agentStatuses = s)).catch(() => undefined)
  api.onAgentStatuses((s) => (state.agentStatuses = s))
  api.agentSnapshots().then((s) => (state.agentSnaps = s)).catch(() => undefined)
  api.onAgentSnapshots((s) => (state.agentSnaps = s))
  api.onAgentFinished((s) => {
    const where = s.cwd.split(/[\\/]/).pop()
    const title = `${agentName(s)} terminou${where ? ` em ${where}` : ''}`
    // o aviso do Acelerar é um pedido do app, não do usuário: não serve de título
    const asked = /^(Interrompi sua resposta porque temos pressa|Aviso do usuário: temos pressa)/.test(s.title ?? '') ? '' : s.title
    const body = asked || s.lastMessage?.slice(0, 120) || 'Tarefa concluída'
    toast(`${title}: ${body}`)
    if (!document.hasFocus() && 'Notification' in window) {
      try {
        new Notification(title, { body: s.lastMessage ? s.lastMessage.slice(0, 180) : body })
      } catch {
        /* notificações desativadas */
      }
    }
    // o agente mexeu no projeto aberto: atualiza a lista de alterações
    if (state.repo && isInside(s.cwd, state.repo.root)) refresh()
  })
}

export function isInside(dir: string, root: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(dir) === norm(root) || norm(dir).startsWith(norm(root) + '/')
}

export const agentName = (a: AgentSession) => (a.source === 'claude' ? 'Claude' : 'ChatGPT')

/** Tarefa ligada a uma conversa de agente: a escolhida pelo usuário, ou a que tem o código citado na linha/pedido. */
export function taskOfAgent(a: AgentSession): OvseerTask | null {
  const linked = state.settings?.agentLinks?.[a.id]
  if (linked) return state.tasks.find((t) => t.id === linked) ?? null
  const text = `${a.branch ?? ''} ${a.title} ${a.request ?? ''}`.toLowerCase()
  return (
    state.tasks.find((t) => {
      const k = t.key.toLowerCase().replace(/[^a-z0-9-]/g, '')
      return k && new RegExp(`(^|[^a-z0-9])${k}($|[^0-9])`).test(text)
    }) ?? null
  )
}

/** Conversa de agente mais relevante de cada tarefa (a que está trabalhando ganha da que terminou). */
export const agentByTask = computed(() => {
  const map = new Map<string, AgentSession>()
  for (const a of state.agents) {
    const t = taskOfAgent(a)
    if (!t) continue
    const cur = map.get(t.id)
    if (!cur || (a.running && !cur.running)) map.set(t.id, a)
  }
  return map
})

export async function linkAgent(agentId: string, taskId: string | null) {
  const links = { ...(state.settings?.agentLinks ?? {}) }
  if (taskId) links[agentId] = taskId
  else delete links[agentId]
  // guarda só as ligações mais recentes
  const trimmed = Object.fromEntries(Object.entries(links).slice(-200))
  await saveSettings({ agentLinks: trimmed })
}

const WORD = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
/** Tarefas ordenadas pela semelhança com a conversa (palavras em comum no título e no pedido). */
export function suggestTasks(a: AgentSession): { task: OvseerTask; score: number }[] {
  const words = new Set(WORD(`${a.title} ${a.request ?? ''} ${a.branch ?? ''}`).map((w) => w.slice(0, 6)))
  return state.tasks
    .map((task) => ({ task, score: WORD(task.title).filter((w) => words.has(w.slice(0, 6))).length }))
    .sort((x, y) => y.score - x.score || Number(y.task.section === 'execution') - Number(x.task.section === 'execution'))
}

export function openTaskDetail(id: string) {
  state.detailTaskId = id
}

/** Inicia/retoma a tarefa. Se houver orientação da aprovação, mostra antes e pede confirmação. */
export async function setTaskStatus(task: { id: string; key: string }, status: 'doing' | 'paused', guidance?: string | null) {
  let ack = false
  if (status === 'doing' && guidance) {
    ack = await ask({
      title: 'Orientação de quem aprovou',
      message: guidance,
      confirmLabel: 'Li e vou seguir'
    })
    if (!ack) return false
  }
  try {
    await api.ovseerSetStatus(task.id, status, ack)
    toast(status === 'paused' ? `${task.key} pausada.` : `${task.key} em execução.`)
    await loadTasks(true)
    return true
  } catch (e) {
    const code = cleanError(e)
    const msg: Record<string, string> = {
      'plan-not-approved': 'O plano ainda não foi aprovado.',
      'approval-guidance-acknowledgement-required': 'Leia e confirme a orientação da aprovação antes de iniciar.',
      forbidden: 'Só quem executa a tarefa pode mudar o andamento dela.',
      'invalid-task-status-transition': 'Não dá para mudar para esse andamento agora.'
    }
    state.error = msg[code] ?? code
    return false
  }
}

/**
 * "Começar" a tarefa: cria (ou abre) a linha de trabalho dela, usa a tarefa nos próximos commits
 * e, se for o caso, marca como em execução no Ovseer.
 */
export async function beginTask(task: OvseerTask, detail?: { planReview: { status: string; note: string | null; guidanceNeedsAck: boolean } }) {
  await guard('load', async () => {
    const r = await api.startTaskBranch(task.key, task.title)
    await afterOperation('Começar tarefa', r, true)
    if (!r.ok) {
      state.result = { ...r, title: 'Começar tarefa' }
      return
    }
    state.commitTaskId = task.id
  })
  if (state.commitTaskId !== task.id) return
  const approved = detail ? detail.planReview.status === 'approved' : task.section !== 'plan_pending' && task.section !== 'plan_rejected'
  if (task.assignedToMe && approved && (task.status === 'todo' || task.status === 'paused')) {
    await setTaskStatus(task, 'doing', detail?.planReview.guidanceNeedsAck ? detail.planReview.note : null)
  } else toast(`Linha de trabalho de ${task.key} pronta. Seus próximos commits vão para esta tarefa.`)
}

/** Tarefas em execução atribuídas a mim (ponto no botão de tarefas). */
export const myDoingCount = computed(() => state.tasks.filter((t) => t.status === 'doing' && t.assignedToMe).length)

export function ovseerTaskUrl(key: string) {
  return `${(state.ovseer?.url ?? state.settings?.ovseerUrl ?? '').replace(/\/+$/, '')}/roadmap?task=${encodeURIComponent(key)}`
}

/** Abre o diálogo "Novo agente" (precisa de um projeto aberto: o agente trabalha na pasta dele). */
export function openNewAgent(task: OvseerTask | null = null, brief: { label: string; message: string } | null = null) {
  if (!state.repo) return toast('Abra um projeto para iniciar um agente nele.')
  state.newAgentTask = task
  state.newAgentBrief = brief
  state.showNewAgent = true
}

/** Abre um agente para resolver os conflitos da operação em andamento (merge, rebase…). */
export function resolveWithAgent() {
  const repo = state.repo
  if (!repo?.operation) return
  const files = repo.files.filter((f) => f.kind === 'conflict').map((f) => f.path)
  const NAME: Record<string, string> = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }
  const op = NAME[repo.operation] ?? repo.operation
  const message =
    `Há um ${op} em andamento neste repositório com ${files.length} arquivo${files.length === 1 ? '' : 's'} em conflito:\n` +
    files.map((f) => `- ${f}`).join('\n') +
    `\n\nResolva os conflitos editando esses arquivos: remova as marcações <<<<<<<, ======= e >>>>>>> e mantenha a intenção das duas versões (use git log e git diff para entender o que cada lado mudou). ` +
    `Depois rode os testes ou o typecheck dos arquivos afetados para garantir que ficou coerente.\n\n` +
    `Quando um arquivo estiver resolvido e validado, marque-o como resolvido com "git add <arquivo>" (só os arquivos desta lista): sem isso o Git continua mostrando o conflito. ` +
    `Não faça commit nem rode "git ${op} --continue": eu concluo o ${op} pelo app. Ao terminar, resuma como resolveu cada arquivo.`
  openNewAgent(null, { label: `Resolver ${files.length} conflito${files.length === 1 ? '' : 's'} do ${op}`, message })
}

/** Texto que o agente recebe para executar uma tarefa do Ovseer: chave, título e plano aprovado. */
export function taskBrief(task: { key: string; title: string }, plan: string): string {
  const body = plan.trim() ? `Plano aprovado:\n\n${plan.trim()}` : 'Não há plano escrito; siga o título e pergunte se algo não estiver claro.'
  return `Tarefa ${task.key}: ${task.title}\n\n${body}\n\nExecute esta tarefa seguindo o plano. Ao terminar, resuma o que foi feito, os arquivos alterados e como validar. Não faça commit: eu salvo a versão pelo app.`
}

export function openNewTask() {
  if (!ovseerReady.value) {
    toast('Conecte o Ovseer para criar tarefas.')
    state.showSettings = true
    return
  }
  state.showNewTask = true
}

export async function createTask(input: Omit<OvseerNewTask, 'workspaceId'>) {
  const ws = ovseerWorkspace.value
  if (!ws) throw new Error('Conecte o Ovseer primeiro.')
  const created = await api.ovseerCreateTask({ ...input, workspaceId: ws.id })
  await loadTasks(true)
  return created
}

let tasksAt = 0
export async function loadTasks(force = false) {
  const ws = ovseerWorkspace.value
  if (!state.ovseer?.connected || !ws) return
  if (!force && Date.now() - tasksAt < 30_000 && state.tasks.length) return
  state.tasksLoading = true
  state.tasksError = null
  try {
    state.tasks = await api.ovseerTasks(ws.id)
    tasksAt = Date.now()
    // tarefa escolhida que deixou de estar ativa: desmarca
    if (state.commitTaskId && !state.tasks.some((t) => t.id === state.commitTaskId)) state.commitTaskId = null
  } catch (e) {
    state.tasksError = cleanError(e)
  } finally {
    state.tasksLoading = false
  }
}

/** Vincula commits recém-criados às tarefas (não bloqueia: se falhar, o commit continua feito). */
async function linkToTasks(r: OperationResult, taskFor: (index: number) => string | null) {
  const ws = ovseerWorkspace.value
  if (!r.commits?.length || !ws || !state.ovseer?.connected) return
  const links = r.commits
    .map((c, i) => ({ taskId: taskFor(i), sha: c.sha, message: c.message }))
    .filter((l): l is { taskId: string; sha: string; message: string } => !!l.taskId)
  if (!links.length) return
  try {
    await api.ovseerLink(ws.id, links)
    const keys = [...new Set(links.map((l) => state.tasks.find((t) => t.id === l.taskId)?.key ?? 'tarefa'))]
    r.steps.push({ label: `Vinculado no Ovseer: ${keys.join(', ')}`, ok: true })
    toast(`Versão vinculada a ${keys.join(', ')} no Ovseer.`)
  } catch (e) {
    const msg = cleanError(e)
    r.steps.push({ label: 'Vincular no Ovseer', ok: false, detail: msg })
    state.error = `Versão salva, mas não foi possível vincular no Ovseer: ${msg}`
  }
}

/** Pergunta ao usuário, com texto simples. Resolve true se ele confirmar. */
export function ask(opts: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    state.confirm?.resolve(false)
    state.confirm = { ...opts, resolve }
  })
}

export function answer(ok: boolean) {
  const c = state.confirm
  state.confirm = null
  c?.resolve(ok)
}

// ---------- voltar atrás: descartar, desfazer, editar, guardadas ----------
export async function discardFiles(files: string[]) {
  if (!files.length) return
  const one = files.length === 1
  const ok = await ask({
    title: one ? 'Descartar alterações?' : `Descartar alterações em ${files.length} arquivos?`,
    message: `${one ? `O arquivo ${files[0].split('/').pop()} volta` : 'Os arquivos voltam'} a ficar como na última versão salva. As alterações vão para a Lixeira: dá para recuperar depois em Histórico → Guardadas.`,
    confirmLabel: 'Descartar',
    danger: true
  })
  if (!ok) return
  await guard('commit', async () => {
    const r = await api.discard(files)
    await afterOperation('Descartar', r, true)
    if (r.ok) toast(one ? 'Alterações descartadas (estão na Lixeira).' : `${files.length} arquivos descartados (estão na Lixeira).`)
    loadSaved()
  })
}

export async function undoLastCommit(subject: string) {
  const ok = await ask({
    title: 'Desfazer a última versão?',
    message: `"${subject}" deixa de ser uma versão salva. Nada é apagado: as alterações voltam para a lista, prontas para salvar de novo.`,
    confirmLabel: 'Desfazer'
  })
  if (!ok) return
  await guard('commit', async () => {
    const r = await api.undoLastCommit()
    await afterOperation('Desfazer', r, true)
    if (r.ok) toast('Versão desfeita. As alterações voltaram para a lista.')
  })
}

export async function editLastMessage(message: string) {
  await guard('commit', async () => {
    const r = await api.editLastMessage(message)
    await afterOperation('Editar mensagem', r, true)
    if (r.ok) toast('Mensagem atualizada.')
  })
}

export async function loadSaved() {
  if (!state.repo) return
  try {
    state.saved = await api.savedChanges()
  } catch {
    state.saved = []
  }
}

export async function restoreSaved(item: SavedChanges) {
  await guard('commit', async () => {
    const r = await api.restoreSaved(item.ref)
    await afterOperation('Recuperar', r, true)
    if (r.ok) toast('Alterações recuperadas: estão de volta na lista.')
    loadSaved()
  })
}

export async function dropSaved(item: SavedChanges) {
  const ok = await ask({
    title: 'Apagar de vez?',
    message: `"${item.label}" (${item.files.length} arquivo(s)) será apagado definitivamente. Isso não pode ser desfeito.`,
    confirmLabel: 'Apagar de vez',
    danger: true
  })
  if (!ok) return
  await guard('commit', async () => {
    const r = await api.dropSaved(item.ref)
    if (!r.ok) state.result = { ...r, title: 'Apagar' }
    loadSaved()
  })
}

// ---------- ajudas da IA ----------
export function closeReview(proceed: boolean) {
  const r = state.review
  state.review = null
  r?.resolve?.(proceed)
}

export async function reviewWithAi() {
  const files = [...state.selected]
  if (!files.length) return toast('Marque os arquivos que quer revisar.')
  if (state.settings?.provider === 'none') {
    toast('Escolha uma IA nas Configurações.')
    state.showSettings = true
    return
  }
  await guard('message', async () => {
    try {
      const [local, ai] = await Promise.all([api.quickCheck(files), api.aiReview(files)])
      state.review = { source: 'ai', findings: [...local, ...ai] }
    } catch (e) {
      const msg = cleanError(e)
      if (/CANCELADO/.test(msg)) return
      throw new Error(msg)
    }
  })
}

export async function resolveWithAi(file: string) {
  await guard('merge', async () => {
    const r = await api.proposeResolution(file)
    state.resolution = { file, ...r }
  })
}

export async function acceptResolution() {
  const r = state.resolution
  if (!r) return
  state.resolution = null
  await guard('merge', async () => {
    const res = await api.applyResolution(r.file, r.content)
    await afterOperation('Resolver conflito', res, true)
    if (res.ok) toast('Conflito resolvido com a proposta da IA.')
  })
}

// ---------- Pull Request ----------
let prAt = 0
let prFor = ''
/** Atualiza o PR da linha atual (no máximo a cada 30s, a não ser que force). */
export async function loadPr(force = false) {
  const key = `${state.repo?.root}|${state.repo?.branch}`
  if (!state.repo?.branch || !state.repo.published) {
    state.pr = null
    return
  }
  if (!force && key === prFor && Date.now() - prAt < 30_000) return
  prFor = key
  prAt = Date.now()
  state.pr = await api.pullRequest().catch(() => null)
}

export async function mergePr() {
  const pr = state.pr
  if (!pr) return
  const warn = pr.checks === 'failing' ? ' Atenção: as verificações automáticas estão falhando.' : pr.review !== 'approved' ? ' Ainda não há aprovação de revisão.' : ''
  const ok = await ask({
    title: `Juntar o PR #${pr.number} na ${pr.base}?`,
    message: `O trabalho desta linha passa a fazer parte da ${pr.base} no servidor, e você volta para a ${pr.base} já atualizada.${warn}`,
    confirmLabel: 'Juntar',
    danger: pr.checks === 'failing'
  })
  if (!ok) return
  await guard('push', async () => {
    const r = await api.mergePullRequest('merge')
    await afterOperation('Juntar na principal', r)
    loadPr(true)
  })
}

// ---------- linhas de trabalho (branches) ----------
export async function switchTo(name: string, mode: 'carry' | 'stash') {
  await guard('load', async () => {
    const r = await api.switchBranch(name, mode)
    await afterOperation('Trocar de linha', r, true)
    if (r.ok) toast(r.steps.map((s) => s.label).join(' · '))
    loadSaved()
  })
}

export async function createBranchNamed(name: string) {
  await guard('load', async () => {
    const r = await api.createBranch(name)
    await afterOperation('Nova linha de trabalho', r, true)
    if (r.ok) toast(`Linha "${name}" criada. Você já está nela.`)
  })
}

export async function saveSshConnection(conn: SshConnection) {
  const list = [...(state.settings?.sshConnections ?? [])]
  const i = list.findIndex((c) => c.id === conn.id)
  if (i >= 0) list[i] = conn
  else list.push(conn)
  await saveSettings({ sshConnections: list.map((c) => ({ ...c })) })
}

export async function deleteSshConnection(id: string) {
  await saveSettings({ sshConnections: (state.settings?.sshConnections ?? []).filter((c) => c.id !== id).map((c) => ({ ...c })) })
}

/** Abre uma aba no terminal (abrindo o painel, se preciso). */
export function openTerminalTab(spec: TerminalSpec) {
  setShowTerminal(true)
  state.terminalRequest = { ...spec }
}

export async function saveSettings(patch: Partial<Settings>) {
  state.settings = await api.saveSettings(patch)
}

export { api }
