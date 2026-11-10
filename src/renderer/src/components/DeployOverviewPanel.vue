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
const selected = ref<string | null>(null)
let chosen = false
watch(rows, (list) => {
  if (!chosen && !selected.value) selected.value = list.find((row) => row.active)?.root ?? null
})
const nameOf = (root: string) => root.split(/[/\\]/).filter(Boolean).pop() ?? root
const since = (date?: string) => date ? new Date(date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
const elapsed = (start?: string, end?: string, active = false) => {
  if (!start) return ''
  const from = Date.parse(start)
  const to = active ? now.value : Date.parse(end ?? '')
  return Number.isFinite(from) && Number.isFinite(to) ? formatDuration(to - from) : ''
}
function toggle(root: string) {
  chosen = true
  selected.value = selected.value === root ? null : root
  expandedStep.value = null
}

const expandedStep = ref<string | null>(null)
const logText = ref('')
const logLoading = ref(false)
let logRequest = 0
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
</script>

<template>
  <aside class="deploy-overview">
    <header>
      <strong>Deploys</strong>
      <span class="faint count">{{ activeCount ? `${activeCount} em execução` : 'Nenhum em execução' }}</span>
      <span class="spacer" />
      <button class="ghost icon small" title="Atualizar deploys" @click="refreshDeployOverview()"><Icon name="refresh" :size="13" /></button>
      <button class="ghost icon small" title="Fechar" @click="setShowDeploys(false)"><Icon name="x" :size="14" /></button>
    </header>
    <p v-if="state.deployOverviewError" class="panel-error">{{ state.deployOverviewError }}</p>
    <div class="scroll">
      <p v-if="!rows.length && !state.deployOverviewAt" class="empty faint">Consultando os deploys dos projetos…</p>
      <p v-else-if="!rows.length" class="empty faint">Nenhum projeto recente tem deploy configurado.</p>
      <article v-for="row in rows" :key="row.root" class="card" :class="{ selected: selected === row.root }">
        <button class="card-head" :aria-expanded="selected === row.root" @click="toggle(row.root)">
          <span class="project ellipsis" :title="row.root">{{ nameOf(row.root) }}</span>
          <span class="badge" :class="row.tone">{{ row.label }}</span>
          <Icon name="chevron" :size="13" class="fold" :class="{ open: selected === row.root }" />
        </button>
        <div class="card-summary">
          <span v-if="row.release" class="mono ellipsis" :title="row.release.tag">{{ row.release.tag }}</span>
          <span v-else class="faint">{{ row.manifest.name }}</span>
          <span v-if="row.target" class="faint ellipsis" :title="row.target">{{ row.target }}</span>
          <span v-if="row.active && row.release?.created_at" class="mono duration">{{ elapsed(row.release.created_at, undefined, true) }}</span>
        </div>
        <p v-if="row.active" class="state-line">{{ row.stage ? `Etapa ${row.stage.index}/${row.steps.length}: ${row.stage.title}` : `Operação ${row.snapshot.operation?.name ?? 'deploy'} ativa` }} · {{ row.done }}/{{ row.steps.length }} concluídas</p>
        <p v-else-if="row.failed" class="state-line failed-text">Falhou em {{ row.failure?.title ?? 'etapa não identificada' }}</p>
        <p v-else-if="row.release && isLiveRelease(row.release)" class="state-line">Nenhuma operação ativa registrada neste computador.</p>

        <div v-if="selected === row.root" class="details">
          <p v-if="row.snapshot.error" class="panel-error">{{ row.snapshot.error }}</p>
          <p v-if="row.snapshot.console === 'stopped'" class="faint note">Abra o projeto para iniciar o console e consultar as releases.</p>
          <template v-if="row.release">
            <p class="meta faint">Início {{ since(row.release.created_at) }}<template v-if="row.release.commit"> · commit <span class="mono">{{ row.release.commit.slice(0, 8) }}</span></template></p>
            <p v-if="row.failed && row.failure" class="failure">{{ row.failure.detail }}</p>
            <ol class="steps">
              <li v-for="step in row.steps" :key="step.id" :class="step.status">
                <button class="step" :disabled="!step.phases.length" @click="toggleStep(row.root, row.release.tag, step)">
                  <span class="mark">
                    <span v-if="step.status === 'running' && row.active" class="spinner" />
                    <Icon v-else-if="step.status === 'completed'" name="check" :size="12" />
                    <Icon v-else-if="step.status === 'failed'" name="x" :size="12" />
                    <span v-else-if="step.status === 'skipped'">–</span>
                  </span>
                  <span class="step-title">{{ step.index }}. {{ step.title }}</span>
                  <span class="faint detail ellipsis">{{ step.detail }}</span>
                </button>
                <ul v-if="step.subs.length && (step.status === 'running' || step.status === 'failed')" class="subs">
                  <li v-for="sub in step.subs" :key="sub.id" :class="sub.status">{{ sub.title }} · {{ sub.detail }}</li>
                </ul>
                <div v-if="expandedStep === `${row.root}\0${row.release.tag}\0${step.id}`" class="step-log">
                  <p v-if="step.error" class="failed-text">{{ step.error }}</p>
                  <p v-if="logLoading" class="faint">Carregando log…</p>
                  <pre v-else-if="logText">{{ logText }}</pre>
                  <p v-else class="faint">Sem log para esta etapa.</p>
                </div>
              </li>
            </ol>
          </template>
          <button class="ghost small open-project" @click="loadProject(row.root)">Abrir projeto para ações</button>
        </div>
      </article>
    </div>
  </aside>
</template>

<style scoped>
.deploy-overview { height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
header { height: 48px; padding: 0 14px; display: flex; align-items: center; gap: 9px; border-bottom: 1px solid var(--border); flex: none; }
header strong { font-size: 13px; }
.count { font-size: 11px; }
.spacer { flex: 1; }
.scroll { min-height: 0; overflow: auto; padding: 12px; }
.empty { margin: 18px 4px; font-size: 12px; }
.panel-error { margin: 8px 12px; color: var(--del); font-size: 11px; overflow-wrap: anywhere; }
.card { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 9px; background: var(--bg); overflow: hidden; }
.card.selected { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.card-head { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: var(--text); padding: 11px 11px 3px; text-align: left; cursor: pointer; }
.fold.open { transform: rotate(90deg); }
.project { flex: 1; font-weight: 650; font-size: 12px; }
.badge { padding: 2px 6px; border-radius: 5px; background: var(--hover); color: var(--muted); font-size: 10px; white-space: nowrap; }
.badge.running { background: var(--accent-soft); color: var(--accent); }
.badge.failed { background: color-mix(in srgb, var(--del) 15%, transparent); color: var(--del); }
.badge.done { background: color-mix(in srgb, #39b86d 14%, transparent); color: #39b86d; }
.card-summary { display: flex; gap: 8px; padding: 2px 11px 8px; font-size: 10px; }
.card-summary > :first-child { flex: 1; min-width: 0; }
.duration { color: var(--accent); }
.state-line { margin: 0; padding: 0 11px 10px; font-size: 11px; color: var(--text); }
.failed-text { color: var(--del); }
.details { border-top: 1px solid var(--border); padding: 10px 11px 12px; }
.note, .meta { margin: 0 0 9px; font-size: 10px; }
.failure { margin: 0 0 10px; padding: 8px; border: 1px solid color-mix(in srgb, var(--del) 35%, var(--border)); border-radius: 5px; color: var(--text); background: color-mix(in srgb, var(--del) 7%, transparent); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.steps { list-style: none; padding: 0; margin: 0 0 10px; }
.steps > li { border-top: 1px solid var(--border); }
.step { width: 100%; display: flex; align-items: center; gap: 7px; padding: 7px 2px; border: 0; background: transparent; text-align: left; color: var(--text); font-size: 11px; }
.step:not(:disabled) { cursor: pointer; }
.step:not(:disabled):hover { background: var(--hover); }
.mark { width: 16px; flex: none; display: grid; place-items: center; color: var(--muted); }
.completed .mark { color: #39b86d; }
.running .mark { color: var(--accent); }
.failed .mark { color: var(--del); }
.step-title { flex: none; }
.detail { flex: 1; text-align: right; }
.subs { margin: 0 0 6px 31px; padding: 0; list-style: none; color: var(--muted); font-size: 10px; }
.subs li { padding: 2px 0; }
.subs .failed { color: var(--del); }
.step-log { padding: 2px 7px 8px 31px; font-size: 10px; }
.step-log p { margin: 3px 0; overflow-wrap: anywhere; }
.step-log pre { max-height: 160px; overflow: auto; margin: 5px 0; padding: 7px; border-radius: 5px; background: var(--panel); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.4 var(--mono); user-select: text; }
.open-project { width: 100%; justify-content: center; }
</style>
