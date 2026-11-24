<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { buildDeploySteps, formatDuration } from '@shared/deploy'
import type { DeployOverviewEntry } from '@shared/deploy'
import Icon from './Icon.vue'

const props = defineProps<{ deploy: DeployOverviewEntry; dropdown?: boolean; open?: boolean }>()
const emit = defineEmits<{ click: [] }>()

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => (now.value = Date.now()), 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

const activity = computed(() => {
  const { root, manifest, snapshot } = props.deploy
  const operation = snapshot.operation
  if (!operation) return null
  const release = snapshot.current?.tag === operation.release_tag ? snapshot.current : snapshot.releases.find((r) => r.tag === operation.release_tag) ?? null
  const steps = buildDeploySteps(manifest, release)
  const stage = steps.find((step) => step.status === 'running')
  const progress = stage ? `Etapa ${stage.index} de ${steps.length} · ${stage.title}` : 'Em execução'
  const started = Date.parse(operation.started_at || release?.created_at || '')
  const elapsed = Number.isFinite(started) ? formatDuration(now.value - started) : ''
  const project = root.split(/[/\\]/).filter(Boolean).pop() ?? root
  return { root, project, steps, progress, elapsed }
})
</script>

<template>
  <button
    v-if="activity"
    type="button"
    class="activity"
    :class="{ on: open }"
    :aria-expanded="dropdown ? !!open : undefined"
    :title="`Deploy ${activity.project} · ${activity.progress}${activity.elapsed ? ` · ${activity.elapsed}` : ''} — ${dropdown ? (open ? 'Fechar menu de deploy' : 'Abrir menu de deploy') : 'Abrir deploys'}`"
    @click="emit('click')"
  >
    <span class="live-dot" aria-hidden="true" />
    <strong class="project">Deploy {{ activity.project }}</strong>
    <span class="stage">{{ activity.progress }}</span>
    <span class="progress" aria-hidden="true"><span v-for="step in activity.steps" :key="step.id" :class="step.status" /></span>
    <span v-if="activity.elapsed" class="elapsed mono">{{ activity.elapsed }}</span>
    <Icon v-if="dropdown" name="chevron" :size="11" class="chev" />
  </button>
</template>

<style scoped>
.activity { display: flex; align-items: center; gap: 9px; flex: none; min-width: 0; max-width: 100%; height: 28px; padding: 0 11px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 999px; background: var(--accent-soft); font-size: 10px; white-space: nowrap; -webkit-app-region: no-drag; }
.activity:hover, .activity.on { background: color-mix(in srgb, var(--accent) 18%, var(--panel)); }
.chev { transform: rotate(90deg); opacity: 0.7; flex: none; }
.live-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--accent); }
.project { max-width: 140px; overflow: hidden; text-overflow: ellipsis; font-size: 11px; font-weight: 650; }
.stage { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.progress { display: flex; gap: 3px; width: 116px; flex: none; }
.progress > span { height: 3px; flex: 1; border-radius: 3px; background: var(--border); }
.progress > .completed { background: var(--add); }
.progress > .running { background: var(--accent); }
.progress > .failed { background: var(--del); }
.elapsed { flex: none; color: var(--text); font-size: 10px; font-variant-numeric: tabular-nums; }
@media (max-width: 1100px) { .progress { width: 70px; } .activity { gap: 6px; } }
@media (max-width: 900px) { .progress { display: none; } .project { max-width: 100px; } }
@media (max-width: 720px) { .stage { display: none; } }
</style>
