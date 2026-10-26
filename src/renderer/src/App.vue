<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import CleanupDialog from './components/CleanupDialog.vue'
import CloneDialog from './components/CloneDialog.vue'
import CommitBar from './components/CommitBar.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import DiffView from './components/DiffView.vue'
import FeatureDialog from './components/FeatureDialog.vue'
import FileList from './components/FileList.vue'
import AgentsView from './components/AgentsView.vue'
import MapView from './components/MapView.vue'
import HistoryView from './components/HistoryView.vue'
import SourceEditor from './components/SourceEditor.vue'
import SourceTree from './components/SourceTree.vue'
import MergeBanner from './components/MergeBanner.vue'
import DeliveryDialog from './components/DeliveryDialog.vue'
import NewAgentDialog from './components/NewAgentDialog.vue'
import NewTaskDialog from './components/NewTaskDialog.vue'
import PaneSwitch from './components/PaneSwitch.vue'
import PlanDialog from './components/PlanDialog.vue'
import ResolveDialog from './components/ResolveDialog.vue'
import ReviewDialog from './components/ReviewDialog.vue'
import PrDialog from './components/PrDialog.vue'
import SshDialog from './components/SshDialog.vue'
import SshImportDialog from './components/SshImportDialog.vue'
import TaskDetailDialog from './components/TaskDetailDialog.vue'
import TasksPanel from './components/TasksPanel.vue'
import PublishDialog from './components/PublishDialog.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import Icon from './components/Icon.vue'
import PullDialog from './components/PullDialog.vue'
import QuickOpen from './components/QuickOpen.vue'
import ResultDialog from './components/ResultDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ServicesDialog from './components/ServicesDialog.vue'
import TopBar from './components/TopBar.vue'
import Welcome from './components/Welcome.vue'
import {
  analyze, api, commit, hasPlan, init, narrowQuery, openNewAgent, openProject, pull, push, refresh, setPane, setShowDiff, setShowTerminal, state
} from './store'

const showFeature = ref(false)
const showPull = ref(false)
const showSwitcher = ref(false)
const showPublish = ref(false)
const updateDismissed = ref(false)
// "Depois" valia para aquela versão: saiu outra mais nova (baixada por cima), a barra volta
watch(() => state.update?.version, () => (updateDismissed.value = false))
// Shift Shift (de qualquer lugar): buscador de arquivos. Duas batidas no Shift em menos de 400 ms, sem outra tecla no meio
let lastShift = 0
function onShiftKey(e: KeyboardEvent) {
  if (e.key !== 'Shift') {
    lastShift = 0
    return
  }
  if (e.repeat) return
  const now = Date.now()
  if (now - lastShift < 400) {
    lastShift = 0
    state.quickOpen = state.quickOpen === null ? '' : null
  } else lastShift = now
}
// terminal maximizado só vale com o painel aberto
const termMaximized = computed(() => state.showTerminal && state.terminalMax)

async function doPull(stash = false) {
  showPull.value = false
  if ((await pull(stash)) === 'dirty') showPull.value = true
}

const leftWidth = ref(Number(localStorage.getItem('ovseer.left') ?? 440))
/** Coluna de arquivos oculta: só com o editor aberto (a lista de alterações nunca some) */
const treeHidden = computed(() => state.hideTree && state.pane === 'files' && state.showDiff)
/** Janela estreita: o diff ocupa a área toda e a coluna de arquivos vira um painel flutuante (botão no cabeçalho) */
const narrow = ref(narrowQuery.matches)
const onNarrow = (e: MediaQueryListEvent) => ((narrow.value = e.matches), (state.listOverlay = false))
onMounted(() => narrowQuery.addEventListener('change', onNarrow))
onUnmounted(() => narrowQuery.removeEventListener('change', onNarrow))
const overlayMode = computed(() => narrow.value && state.showDiff)
const gitOverlayQuery = window.matchMedia('(max-width: 1200px)')
const gitNarrow = ref(gitOverlayQuery.matches)
const onGitNarrow = (e: MediaQueryListEvent) => (gitNarrow.value = e.matches)
onMounted(() => gitOverlayQuery.addEventListener('change', onGitNarrow))
onUnmounted(() => gitOverlayQuery.removeEventListener('change', onGitNarrow))
const gitOverlay = computed(() => gitNarrow.value || state.showTasks)
const gitDiffOpened = ref(false)
function closeGit() {
  state.showGit = false
  if (state.tab === 'changes' && gitDiffOpened.value) {
    state.tab = state.gitReturnTab
    gitDiffOpened.value = false
  }
}
function openGitDiff() {
  gitDiffOpened.value = true
  state.tab = 'changes'
  setPane('changes')
  setShowDiff(true)
  if (gitOverlay.value) state.showGit = false
}
watch(() => state.showDiff, (open) => {
  if (!open && gitDiffOpened.value) {
    gitDiffOpened.value = false
    state.tab = state.gitReturnTab
  }
})
watch(() => [state.tab, state.pane], ([tab, pane]) => {
  if (tab !== 'changes' || pane !== 'changes') gitDiffOpened.value = false
})
function startResize(e: MouseEvent) {
  const startX = e.clientX
  const start = leftWidth.value
  const move = (ev: MouseEvent) => {
    leftWidth.value = Math.min(Math.max(start + ev.clientX - startX, 260), window.innerWidth - 300)
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    localStorage.setItem('ovseer.left', String(leftWidth.value))
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// terminal: só é criado na primeira vez que é aberto, e depois fica vivo (escondido) ao fechar
const termMounted = ref(state.showTerminal)
watch(
  () => state.showTerminal,
  (on) => on && (termMounted.value = true)
)
const termHeight = ref(Number(localStorage.getItem('ovseer.termHeight') ?? 240))
function startTermResize(e: MouseEvent) {
  const startY = e.clientY
  const start = termHeight.value
  const move = (ev: MouseEvent) => {
    termHeight.value = Math.min(Math.max(start - (ev.clientY - startY), 100), window.innerHeight - 260)
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    localStorage.setItem('ovseer.termHeight', String(termHeight.value))
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

const onFocus = () => refresh()
let offMenu: (() => void) | undefined

onMounted(() => {
  init()
  window.addEventListener('focus', onFocus)
  window.addEventListener('keydown', onShiftKey)
  offMenu = window.ovseer.onMenu((action) => {
    if (action === 'open') openProject()
    else if (action === 'settings') state.showSettings = true
    else if (action === 'newAgent') openNewAgent()
    else if (action === 'agents') state.tab = 'agents'
    else if (action.startsWith('agent:')) {
      // a conversa aparece na aba Agentes: vai para lá
      state.tab = 'agents'
      state.agentPick = { n: Number(action.slice(6)), at: Date.now() }
    }
    else if (action === 'switch') state.repo ? (showSwitcher.value = true) : openProject()
    else if (!state.repo) return
    else if (action === 'refresh') refresh()
    else if (action === 'toggleDiff') setShowDiff(!state.showDiff)
    else if (action === 'toggleTerminal') setShowTerminal(!state.showTerminal)
    else if (action === 'analyze') analyze(hasPlan.value)
    else if (action === 'commit') commit()
    else if (action === 'feature') showFeature.value = true
    else if (action === 'pull') doPull()
    else if (action === 'push') state.repo.hasRemote ? push() : (showPublish.value = true)
  })
})
onUnmounted(() => {
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('keydown', onShiftKey)
  offMenu?.()
})
</script>

<template>
  <div class="app">
    <TopBar v-model:switcher="showSwitcher" />

    <div v-if="state.error" class="error-bar">
      <Icon name="alert" />
      <span class="msg">{{ state.error }}</span>
      <button class="ghost icon small" title="Fechar" @click="state.error = null"><Icon name="x" :size="14" /></button>
    </div>

    <div v-if="state.update?.status === 'ready' && !updateDismissed" class="update-bar">
      <Icon name="down" />
      <span class="msg">Ovseer {{ state.update.version }} está pronto para instalar.</span>
      <button class="primary small" @click="api.updateInstall()">Reiniciar e atualizar</button>
      <button class="ghost icon small" title="Depois (instala ao fechar o app)" @click="updateDismissed = true"><Icon name="x" :size="14" /></button>
    </div>

    <Welcome v-if="!state.repo" />

    <template v-else>
      <div class="shell">
      <!-- barra lateral com as áreas do projeto, como no Codex; o resto da janela fica à direita dela -->
      <PaneSwitch />
      <div class="main">
      <MergeBanner v-show="!termMaximized" />
      <div v-show="!termMaximized" class="body" :class="{ 'git-overlay': gitOverlay }">
      <div v-if="state.showGit && gitOverlay" class="git-backdrop" @mousedown="closeGit" />
      <aside v-if="state.showGit" class="git-wrap">
        <FileList @pick="openGitDiff" />
        <CommitBar @feature="showFeature = true" @pull="doPull()" @publish="showPublish = true" />
      </aside>
      <div v-if="state.showTasks" class="tasks-wrap"><TasksPanel /></div>
      <div class="workspace">
        <main v-if="state.tab === 'changes'" class="split" :class="{ 'diff-open': state.showDiff }">
          <template v-if="state.showGit && state.pane === 'changes'">
            <section class="right"><DiffView /></section>
          </template>
          <template v-else>
            <div v-if="overlayMode && state.listOverlay" class="overlay-backdrop" @mousedown="state.listOverlay = false" />
            <aside
              v-show="overlayMode ? state.listOverlay : !treeHidden"
              :class="{ full: !state.showDiff, overlay: overlayMode }"
              :style="state.showDiff && !overlayMode ? { width: `${leftWidth}px` } : undefined"
            >
              <SourceTree v-if="state.pane === 'files'" />
              <FileList v-else />
            </aside>
            <template v-if="state.showDiff">
              <div v-show="!treeHidden" class="resizer" @mousedown.prevent="startResize" />
              <section class="right"><SourceEditor v-if="state.pane === 'files'" /><DiffView v-else /></section>
            </template>
          </template>
        </main>
        <AgentsView v-else-if="state.tab === 'agents'" />
        <MapView v-else-if="state.tab === 'map'" />
        <HistoryView v-else />
      </div>
      </div>
      <!-- em Agentes e no modo Arquivos a barra de commit some: o espaço fica para a árvore e o editor -->
      <CommitBar v-if="!state.showGit" v-show="!termMaximized && state.tab !== 'agents' && state.tab !== 'map' && !(state.tab === 'changes' && state.pane === 'files')" @feature="showFeature = true" @pull="doPull()" @publish="showPublish = true" />
      <!-- terminal na base da janela, abaixo da barra de commit -->
      <template v-if="termMounted">
        <div v-show="state.showTerminal && !termMaximized" class="term-resizer" @mousedown.prevent="startTermResize" />
        <div
          v-show="state.showTerminal"
          class="term-wrap"
          :class="{ max: termMaximized }"
          :style="termMaximized ? undefined : { height: `${termHeight}px` }"
        >
          <TerminalPanel />
        </div>
      </template>
      </div>
      </div>
    </template>

    <QuickOpen v-if="state.quickOpen !== null" :start="state.quickOpen" @close="state.quickOpen = null" />
    <SettingsDialog v-if="state.showSettings" @close="state.showSettings = false" />
    <ServicesDialog v-if="state.showServices" @close="state.showServices = false" />
    <FeatureDialog v-if="showFeature" @close="showFeature = false" />
    <PullDialog v-if="showPull" @close="showPull = false" @confirm="doPull(true)" />
    <PlanDialog />
    <NewTaskDialog v-if="state.showNewTask" @close="state.showNewTask = false" />
    <NewAgentDialog v-if="state.showNewAgent" @close="(state.showNewAgent = false), (state.newAgentTask = null), (state.newAgentBrief = null)" />
    <DeliveryDialog v-if="state.deliveryTask" @close="state.deliveryTask = null" />
    <SshDialog v-if="state.sshEdit" @close="state.sshEdit = null" />
    <TaskDetailDialog v-if="state.detailTaskId" @close="state.detailTaskId = null" />
    <ConfirmDialog />
    <SshImportDialog v-if="state.showSshImport" @close="state.showSshImport = false" />
    <CloneDialog v-if="state.showClone" @close="state.showClone = false" />
    <ReviewDialog />
    <ResolveDialog />
    <PrDialog v-if="state.showPrDialog" @close="state.showPrDialog = false" />
    <CleanupDialog v-if="state.showCleanup" @close="state.showCleanup = false" />
    <PublishDialog v-if="showPublish" @close="showPublish = false" />
    <ResultDialog />

    <Transition name="toast">
      <div v-if="state.toast" class="toast">{{ state.toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }
.body { position: relative; flex: 1; display: flex; min-height: 0; }
/* barra lateral à esquerda e, ao lado, a coluna com todo o resto (faixas, área de trabalho, commit, terminal) */
.shell { flex: 1; display: flex; min-height: 0; }
.main { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.tasks-wrap { width: min(360px, 42vw); flex: none; border-right: 1px solid var(--border); min-height: 0; }
.git-wrap { width: 360px; max-width: 42vw; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.git-wrap > :deep(.list) { flex: 1; height: auto; min-height: 0; }
.git-backdrop { position: absolute; inset: 0; z-index: 18; background: rgba(0, 0, 0, 0.25); }
.body.git-overlay .git-wrap { position: absolute; top: 0; bottom: 0; left: 0; z-index: 19; width: min(360px, 85%); max-width: none; box-shadow: 12px 0 40px rgba(0, 0, 0, 0.35); }
.workspace { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.split { flex: 1; display: flex; min-height: 0; }
.term-wrap { flex: none; min-height: 0; }
.term-wrap.max { flex: 1; }
.term-resizer { height: 5px; margin: -2px 0; cursor: row-resize; position: relative; z-index: 2; flex: none; }
.term-resizer::after { content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 1px; background: var(--border); }
.term-resizer:hover::after { background: var(--accent); height: 2px; top: 1.5px; }
aside { flex: none; min-width: 0; background: var(--panel); }
aside.full { flex: 1; }
.right { flex: 1; min-width: 0; }
/* janela estreita: o diff ocupa a área toda; a coluna de arquivos flutua por cima quando aberta pelo botão */
.split { position: relative; }
@media (max-width: 760px) {
  .split.diff-open .resizer { display: none; }
}
aside.overlay {
  position: absolute; top: 0; bottom: 0; left: 0; z-index: 20; width: min(360px, 85%);
  border-right: 1px solid var(--border); box-shadow: 12px 0 40px rgba(0, 0, 0, 0.35); animation: slide 0.14s ease-out;
}
@keyframes slide { from { transform: translateX(-12px); opacity: 0; } }
.overlay-backdrop { position: absolute; inset: 0; z-index: 19; background: rgba(0, 0, 0, 0.25); }
.resizer { width: 5px; margin: 0 -2px; cursor: col-resize; position: relative; z-index: 2; }
.resizer::after { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 1px; background: var(--border); }
.resizer:hover::after { background: var(--accent); width: 2px; left: 1.5px; }
.error-bar {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  background: var(--del-bg); color: var(--del); border-bottom: 1px solid var(--border);
}
.update-bar {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  background: var(--accent-soft); border-bottom: 1px solid var(--border);
}
.update-bar .msg { flex: 1; font-size: 12.5px; }
.error-bar .msg { flex: 1; white-space: pre-wrap; user-select: text; font-size: 12.5px; }
/* centralizado na faixa à esquerda da conversa encaixada do orquestrador (--dock-w, publicada pelo gerenciador):
   se cobrisse a área da conversa, ela se esconderia enquanto o aviso estivesse na tela */
.toast {
  position: fixed; left: 16px; right: calc(var(--dock-w, 0px) + 16px); bottom: 150px; width: fit-content; margin: 0 auto; text-align: center;
  background: var(--text); color: var(--bg); padding: 9px 16px; border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25); z-index: 45; max-width: min(80vw, calc(100vw - var(--dock-w, 0px) - 32px)); font-weight: 500;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.18s, transform 0.18s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
