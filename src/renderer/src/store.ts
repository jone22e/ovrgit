import { computed, reactive } from 'vue'
import { heuristicGroups, slugify } from '@shared/parse'
import { applyTheme } from './theme'
import type {
  Analysis, ChangeGroup, CommitInfo, FileChange, OperationResult, OvseerNewTask, OvseerStatus, OvseerTask, RepoStatus,
  Settings
} from '@shared/types'

const api = window.ovrgit

export type Busy = null | 'load' | 'analyze' | 'message' | 'commit' | 'pull' | 'push' | 'feature' | 'merge'

export type ViewMode = 'tree' | 'list'

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
  viewMode: (readPref('ovrgit.view') === 'list' ? 'list' : 'tree') as ViewMode,
  analysis: null as Analysis | null,
  selected: new Set<string>(),
  /** Pastas recolhidas na árvore */
  collapsed: new Set<string>(),
  activeFile: null as FileChange | null,
  diff: '',
  diffLoading: false,
  history: [] as CommitInfo[],
  tab: 'changes' as 'changes' | 'history',
  message: '',
  messageEdited: false,
  busy: null as Busy,
  error: null as string | null,
  result: null as (OperationResult & { title: string }) | null,
  toast: null as string | null,
  showSettings: false,
  showDiff: readPref('ovrgit.diff') === '1',
  showTerminal: readPref('ovrgit.terminal') === '1',
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
  showTasks: readPref('ovrgit.tasks') === '1',
  showNewTask: false,
  deliveryTask: null as OvseerTask | null,
  ovseerLive: false
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
  writePref('ovrgit.diff', v ? '1' : '0')
}

export function setShowTerminal(v: boolean) {
  state.showTerminal = v
  writePref('ovrgit.terminal', v ? '1' : '0')
}

export function setShowTasks(v: boolean) {
  state.showTasks = v
  writePref('ovrgit.tasks', v ? '1' : '0')
  if (v) loadTasks()
}

export function setViewMode(v: ViewMode) {
  state.viewMode = v
  writePref('ovrgit.view', v)
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
  listenOvseer()
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
    state.collapsed = new Set()
    state.selected = new Set(repo.files.map((f) => f.path))
    state.activeFile = null
    state.diff = ''
    state.message = ''
    state.messageEdited = false
  }
  const prevFiles = changedRepo ? repo.files : (state.repo?.files ?? [])
  state.repo = repo
  reconcile(repo.files, prevFiles)
  if (!state.messageEdited) state.message = suggestedMessage.value
  if (state.tab === 'history' || changedRepo) loadHistory()
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
  } catch (e) {
    state.error = cleanError(e)
  }
}

export async function loadHistory() {
  if (!state.repo) return
  try {
    state.history = await api.log(100)
  } catch (e) {
    state.error = cleanError(e)
  }
}

export async function selectFile(file: FileChange | null, silent = false) {
  state.activeFile = file
  if (file && !silent) setShowDiff(true)
  if (!file) {
    state.diff = ''
    return
  }
  if (!silent) state.diffLoading = true
  try {
    const text = await api.diff({ ...file })
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
      a = await api.analyze(force)
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
    state.planTasks = Object.fromEntries(a.groups.map((g) => [g.id, state.commitTaskId]))
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
  for (const g of state.groups) if (!(g.id in state.planTasks)) state.planTasks[g.id] = state.commitTaskId
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
    await afterOperation(`${groups.length} commit${groups.length === 1 ? '' : 's'}`, r)
  })
}

/** Descarta o plano e usa a mensagem geral da IA num commit único. */
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

export async function commit() {
  const files = [...state.selected]
  if (!files.length) return toast('Selecione ao menos um arquivo.')
  if (!state.message.trim()) return toast('Escreva a mensagem do commit.')
  await guard('commit', async () => {
    const r = await api.commit(files, state.message.trim())
    state.messageEdited = false
    if (r.ok) await linkToTasks(r, () => state.commitTaskId)
    await afterOperation('Commit', r, true)
    if (r.ok && !state.commitTaskId) toast('Commit criado.')
  })
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
    if (r.ok) toast(r.steps.at(-1)?.label ?? 'Enviado.')
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
  const ok = window.confirm(
    `Abortar o ${op}?\n\nO repositório volta ao estado de antes do ${op}. As resoluções de conflito feitas até agora serão descartadas.`
  )
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
    await loadTasks(true)
    // token revogado no Ovseer: reflete na interface
    if (state.tasksError && /Conecte/i.test(state.tasksError)) refreshOvseer()
  })
}

/** Tarefas em execução atribuídas a mim (ponto no botão de tarefas). */
export const myDoingCount = computed(() => state.tasks.filter((t) => t.status === 'doing' && t.assignedToMe).length)

export function ovseerTaskUrl(key: string) {
  return `${(state.ovseer?.url ?? state.settings?.ovseerUrl ?? '').replace(/\/+$/, '')}/roadmap?task=${encodeURIComponent(key)}`
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
    toast(`Commit vinculado a ${keys.join(', ')} no Ovseer.`)
  } catch (e) {
    const msg = cleanError(e)
    r.steps.push({ label: 'Vincular no Ovseer', ok: false, detail: msg })
    state.error = `Commit criado, mas não foi possível vincular no Ovseer: ${msg}`
  }
}

export async function saveSettings(patch: Partial<Settings>) {
  state.settings = await api.saveSettings(patch)
}

export { api }
