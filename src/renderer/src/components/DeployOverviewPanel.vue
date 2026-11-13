<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { buildDeploySteps, formatDuration, isLiveRelease, isSuccessfulRelease, releaseFailure, releaseStatusLabel } from '@shared/deploy'
import type { DeployStepView } from '@shared/deploy'
import { api, loadProject, refreshDeployOverview, setShowDeploys, state } from '../store'
import Icon from './Icon.vue'

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => (now.value = Date.now()), 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

const rows = computed(() => state.deployOverview.map(({ root, manifest, snapshot }) => {
  const release = snapshot.current
  const steps = buildDeploySteps(manifest, release)
  const active = !!snapshot.operation
  const failed = !active && release?.status === 'failed'
  const stage = steps.find((step) => step.status === 'running')
  const done = steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length
  const failure = releaseFailure(release, steps)
  const target = manifest.kind === 'script' ? manifest.targets?.find((item) => item.id === release?.target)?.title ?? release?.target : release?.target
  const label = active ? 'Em execução'
    : snapshot.console === 'error' ? 'Erro na consulta'
    : snapshot.console === 'starting' ? 'Console iniciando'
    : snapshot.console === 'stopped' ? 'Console parado'
    : failed ? 'Falhou'
    : isSuccessfulRelease(release) ? 'Concluído'
    : isLiveRelease(release) ? 'Sem operação ativa'
    : release ? releaseStatusLabel(release.status) : 'Nenhum deploy'
  const tone = active ? 'running' : failed ? 'failed' : isSuccessfulRelease(release) ? 'done' : 'idle'
  return { root, manifest, snapshot, release, steps, active, failed, stage, done, failure, target, label, tone }
}).sort((a, b) => {
  const priority = (row: { active: boolean; failed: boolean }) => row.active ? 0 : row.failed ? 1 : 2
  const updated = (row: { release: { updated_at?: string; created_at?: string } | null }) => Date.parse(row.release?.updated_at ?? row.release?.created_at ?? '') || 0
  return priority(a) - priority(b) || updated(b) - updated(a) || a.root.localeCompare(b.root)
}))
const activeCount = computed(() => rows.value.filter((row) => row.active).length)
const failedCount = computed(() => rows.value.filter((row) => row.failed).length)
const filter = ref<'all' | 'active' | 'failed'>('all')
const visibleRows = computed(() => rows.value.filter((row) => filter.value === 'all' || (filter.value === 'active' ? row.active : row.failed)))
const selected = ref<string | null>(null)
watch(visibleRows, (list) => {
  if (!list.some((row) => row.root === selected.value)) selected.value = list[0]?.root ?? null
}, { immediate: true })
const selectedRow = computed(() => visibleRows.value.find((row) => row.root === selected.value) ?? null)
const recentRows = computed(() => visibleRows.value.filter((row) => row.root !== selected.value))
const nameOf = (root: string) => root.split(/[/\\]/).filter(Boolean).pop() ?? root
const initialOf = (root: string) => nameOf(root).charAt(0).toUpperCase()
const since = (date?: string) => date ? new Date(date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
const elapsed = (start?: string, end?: string, active = false) => {
  if (!start) return ''
  const from = Date.parse(start)
  const to = active ? now.value : Date.parse(end ?? '')
  return Number.isFinite(from) && Number.isFinite(to) ? formatDuration(to - from) : ''
}

const expandedStep = ref<string | null>(null)
const logText = ref('')
const logLoading = ref(false)
let logRequest = 0
function select(root: string) {
  selected.value = root
  expandedStep.value = null
}
async function toggleStep(root: string, tag: string, step: DeployStepView) {
  const key = `${root}\0${tag}\0${step.id}`
  expandedStep.value = expandedStep.value === key ? null : key
  logText.value = ''
  if (expandedStep.value !== key || !step.phases.length) return
  const request = ++logRequest
  logLoading.value = true
  try {
    const parts = await Promise.all(step.phases.map((phase) => api.deployLog(root, tag, phase).catch(() => '')))
    if (expandedStep.value === key && request === logRequest) logText.value = parts.filter(Boolean).join('\n\n').slice(-40_000)
  } finally {
    if (request === logRequest) logLoading.value = false
  }
}
async function openProject(root: string) {
  await loadProject(root)
  setShowDeploys(false)
}
</script>

<template>
  <aside class="deploy-overview" aria-label="Deploys dos projetos">
    <header class="panel-head">
      <div class="heading"><strong>Deploys</strong><span v-if="activeCount" class="heading-status"><i />{{ activeCount }} em execução</span><span v-else-if="failedCount" class="heading-status failed"><i />{{ failedCount }} com falha</span></div>
      <span class="spacer" />
      <button class="ghost icon small" title="Atualizar deploys" aria-label="Atualizar deploys" @click="refreshDeployOverview()"><Icon name="refresh" :size="14" /></button>
      <button class="ghost icon small" title="Fechar" aria-label="Fechar deploys" @click="setShowDeploys(false)"><Icon name="x" :size="14" /></button>
    </header>
    <div class="filters" role="group" aria-label="Filtrar deploys">
      <button :class="{ on: filter === 'all' }" @click="filter = 'all'">Todos <b>{{ rows.length }}</b></button>
      <button :class="{ on: filter === 'active' }" @click="filter = 'active'">Ativos <b>{{ activeCount }}</b></button>
      <button :class="{ on: filter === 'failed' }" @click="filter = 'failed'">Falhas <b>{{ failedCount }}</b></button>
    </div>
    <p v-if="state.deployOverviewError" class="panel-error">{{ state.deployOverviewError }}</p>
    <div class="scroll">
      <p v-if="!rows.length && !state.deployOverviewAt" class="empty faint">Consultando os deploys dos projetos…</p>
      <p v-else-if="!rows.length" class="empty faint">Nenhum projeto recente tem deploy configurado.</p>
      <p v-else-if="!selectedRow" class="empty faint">Nenhum deploy nesta categoria.</p>
      <template v-if="selectedRow">
        <article class="current-card" :class="selectedRow.tone">
          <div class="project-head">
            <span class="avatar">{{ initialOf(selectedRow.root) }}</span>
            <div class="project-info"><strong class="ellipsis" :title="selectedRow.root">{{ nameOf(selectedRow.root) }}</strong><span class="mono ellipsis" :title="selectedRow.release?.tag">{{ selectedRow.release?.tag ?? selectedRow.manifest.name }}</span></div>
            <span class="badge" :class="selectedRow.tone">{{ selectedRow.label }}</span>
          </div>
          <div v-if="selectedRow.release" class="metadata">
            <span v-if="selectedRow.release.commit" class="mono">{{ selectedRow.release.commit.slice(0, 8) }}</span>
            <span v-if="selectedRow.release.created_at">Início {{ since(selectedRow.release.created_at) }}</span>
            <span v-if="selectedRow.target" class="ellipsis" :title="selectedRow.target">{{ selectedRow.target }}</span>
            <span v-if="selectedRow.active && selectedRow.release.created_at" class="mono duration">{{ elapsed(selectedRow.release.created_at, undefined, true) }}</span>
          </div>
          <div v-if="selectedRow.release" class="progress-block">
            <div class="progress-label"><strong v-if="selectedRow.active">Etapa {{ selectedRow.stage?.index ?? Math.min(selectedRow.done + 1, selectedRow.steps.length) }} de {{ selectedRow.steps.length }} · {{ selectedRow.stage?.title ?? 'Em andamento' }}</strong><strong v-else-if="selectedRow.failed">Falhou em {{ selectedRow.failure?.title ?? 'etapa não identificada' }}</strong><strong v-else>{{ selectedRow.label }}</strong><span>{{ selectedRow.done }}/{{ selectedRow.steps.length }} concluídas</span></div>
            <div class="progress-track" aria-label="Progresso das etapas"><span v-for="step in selectedRow.steps" :key="step.id" :class="step.status" /></div>
          </div>
          <p v-if="selectedRow.snapshot.error" class="panel-error">{{ selectedRow.snapshot.error }}</p>
          <p v-if="selectedRow.snapshot.console === 'stopped'" class="note">Abra o projeto para iniciar o console e consultar as releases.</p>
          <p v-if="selectedRow.release && isLiveRelease(selectedRow.release) && !selectedRow.active" class="note">Nenhuma operação ativa registrada neste computador.</p>
          <ol v-if="selectedRow.release" class="steps">
            <li v-for="step in selectedRow.steps" :key="step.id" :class="step.status">
              <button class="step" :disabled="!step.phases.length" :aria-expanded="expandedStep === `${selectedRow.root}\0${selectedRow.release.tag}\0${step.id}`" @click="toggleStep(selectedRow.root, selectedRow.release.tag, step)">
                <span class="mark"><span v-if="step.status === 'running' && selectedRow.active" class="spinner" /><Icon v-else-if="step.status === 'completed'" name="check" :size="12" /><Icon v-else-if="step.status === 'failed'" name="x" :size="12" /><span v-else-if="step.status === 'skipped'">–</span><span v-else class="pending-dot" /></span>
                <span class="step-title">{{ step.title }}</span>
                <span class="step-detail ellipsis">{{ step.detail || (step.status === 'completed' ? 'Concluída' : step.status === 'failed' ? 'Falhou' : step.status === 'running' ? 'Em andamento' : step.status === 'skipped' ? 'Pulada' : 'Pendente') }}</span>
              </button>
              <ul v-if="step.subs.length && (step.status === 'running' || step.status === 'failed')" class="subs"><li v-for="sub in step.subs" :key="sub.id" :class="sub.status">{{ sub.title }} · {{ sub.detail }}</li></ul>
              <div v-if="expandedStep === `${selectedRow.root}\0${selectedRow.release.tag}\0${step.id}`" class="step-log"><p v-if="step.error" class="failed-text">{{ step.error }}</p><p v-if="logLoading" class="faint">Carregando log…</p><pre v-else-if="logText">{{ logText }}</pre><p v-else class="faint">Sem log para esta etapa.</p></div>
            </li>
          </ol>
          <p v-if="selectedRow.failed && selectedRow.failure" class="failure">{{ selectedRow.failure.detail }}</p>
          <div class="actions"><button class="ghost small" @click="openProject(selectedRow.root)">Abrir projeto para ações</button></div>
        </article>
        <section v-if="recentRows.length" class="recent"><h3>OUTROS PROJETOS</h3><div class="recent-list"><button v-for="row in recentRows" :key="row.root" class="recent-row" @click="select(row.root)"><span class="avatar mini">{{ initialOf(row.root) }}</span><span class="recent-info"><strong class="ellipsis">{{ nameOf(row.root) }}</strong><small class="mono ellipsis">{{ row.release?.tag ?? row.manifest.name }}</small></span><span class="recent-status" :class="row.tone">{{ row.label }}<small v-if="row.release?.created_at">{{ since(row.release.created_at) }}</small></span><Icon name="chevron" :size="13" /></button></div></section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.deploy-overview { height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
.panel-head { min-height: 48px; padding: 0 14px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); flex: none; }
.heading { display: flex; align-items: center; gap: 8px; min-width: 0; }.heading strong { font-size: 13px; }.heading-status { display: inline-flex; align-items: center; gap: 5px; border-radius: 20px; padding: 3px 7px; background: var(--accent-soft); color: var(--accent); font-size: 10px; white-space: nowrap; }.heading-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }.heading-status.failed { background: color-mix(in srgb, var(--del) 14%, transparent); color: var(--del); }.spacer { flex: 1; }
.filters { display: flex; margin: 10px 12px 0; padding: 3px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); gap: 2px; }.filters button { flex: 1; border: 0; border-radius: 5px; padding: 6px 4px; color: var(--muted); background: transparent; font-size: 11px; cursor: pointer; }.filters button.on { background: var(--hover); color: var(--text); }.filters b { font-weight: 600; color: inherit; }
.scroll { min-height: 0; overflow: auto; padding: 12px; }.empty { margin: 18px 4px; font-size: 12px; }.panel-error { margin: 8px 12px; color: var(--del); font-size: 11px; overflow-wrap: anywhere; }
.current-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg); overflow: hidden; }.current-card.running { border-color: color-mix(in srgb, var(--accent) 25%, var(--border)); }.current-card.failed { border-color: color-mix(in srgb, var(--del) 25%, var(--border)); }
.project-head { display: flex; align-items: center; gap: 9px; padding: 13px 12px 8px; }.avatar { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; flex: none; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 700; }.avatar.mini { width: 25px; height: 25px; font-size: 11px; }.project-info { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }.project-info strong { font-size: 12px; }.project-info .mono { font-size: 10px; color: var(--muted); }.badge { padding: 4px 7px; border-radius: 20px; color: var(--muted); background: var(--hover); font-size: 10px; font-weight: 600; white-space: nowrap; }.badge.running { background: var(--accent-soft); color: var(--accent); }.badge.failed { background: color-mix(in srgb, var(--del) 14%, transparent); color: var(--del); }.badge.done { background: color-mix(in srgb, #39b86d 14%, transparent); color: #39b86d; }
.metadata { display: flex; flex-wrap: wrap; gap: 5px 11px; align-items: center; padding: 0 12px 11px 49px; font-size: 10px; color: var(--muted); }.metadata .duration { margin-left: auto; color: var(--text); }.progress-block { padding: 10px 12px 12px; border-top: 1px solid var(--border); }.progress-label { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; }.progress-label strong { font-weight: 600; }.progress-label span { flex: none; color: var(--muted); }.progress-track { display: flex; gap: 3px; margin-top: 8px; }.progress-track span { height: 3px; flex: 1; border-radius: 3px; background: var(--border); }.progress-track .completed { background: #39b86d; }.progress-track .running { background: var(--accent); }.progress-track .failed { background: var(--del); }
.note { margin: 0 12px 10px; font-size: 10px; color: var(--muted); }.steps { list-style: none; padding: 4px 8px; margin: 0; border-top: 1px solid var(--border); }.steps > li { border-radius: 6px; }.steps > li.running { background: var(--accent-soft); }.steps > li.failed { background: color-mix(in srgb, var(--del) 9%, transparent); }.step { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 5px; border: 0; background: transparent; text-align: left; color: var(--text); font-size: 11px; }.step:not(:disabled) { cursor: pointer; }.step:not(:disabled):hover { background: var(--hover); border-radius: 6px; }.mark { width: 17px; height: 17px; border-radius: 50%; flex: none; display: grid; place-items: center; color: var(--muted); border: 1px solid var(--border); }.completed .mark { background: color-mix(in srgb, #39b86d 20%, transparent); border-color: transparent; color: #39b86d; }.running .mark { color: var(--accent); border-color: var(--accent); }.failed .mark { background: var(--del); border-color: var(--del); color: #fff; }.pending-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--muted); opacity: .5; }.step-title { flex: 1; min-width: 0; }.step-detail { color: var(--muted); text-align: right; font-size: 10px; max-width: 38%; }.failed .step-detail { color: var(--del); }.running .step-detail { color: var(--accent); }.subs { margin: 0 0 6px 31px; padding: 0; list-style: none; color: var(--muted); font-size: 10px; }.subs li { padding: 2px 0; }.subs .failed { color: var(--del); }.step-log { padding: 2px 7px 8px 31px; font-size: 10px; }.step-log p { margin: 3px 0; overflow-wrap: anywhere; }.step-log pre { max-height: 160px; overflow: auto; margin: 5px 0; padding: 7px; border-radius: 5px; background: var(--panel); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.4 var(--mono); user-select: text; }.failed-text { color: var(--del); }
.failure { margin: 4px 12px 10px; padding: 8px; border-radius: 6px; background: color-mix(in srgb, var(--del) 9%, transparent); color: var(--text); font-size: 10px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }.actions { display: flex; padding: 10px 12px 12px; border-top: 1px solid var(--border); }.actions button { flex: 1; justify-content: center; }
.recent { margin-top: 18px; }.recent h3 { margin: 0 2px 7px; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .04em; }.recent-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }.recent-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 0; border-bottom: 1px solid var(--border); background: var(--bg); color: var(--text); text-align: left; cursor: pointer; }.recent-row:last-child { border-bottom: 0; }.recent-row:hover { background: var(--hover); }.recent-info { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }.recent-info strong { font-size: 11px; }.recent-info small { color: var(--muted); font-size: 9px; }.recent-status { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; color: var(--muted); font-size: 10px; }.recent-status.running { color: var(--accent); }.recent-status.failed { color: var(--del); }.recent-status.done { color: #39b86d; }.recent-status small { color: var(--muted); font-size: 9px; }
</style>
