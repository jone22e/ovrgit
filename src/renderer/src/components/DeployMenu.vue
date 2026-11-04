<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DeployLock, DeployManifest, DeployPlanResult, DeploySnapshot, DeployStepView } from '@shared/deploy'
import { buildDeploySteps, formatDuration, isLiveRelease, isSuccessfulRelease, lockLine, releaseStatusLabel } from '@shared/deploy'
import { api, state, toast } from '../store'
import Icon from './Icon.vue'

/**
 * Botão "Deploy" ao lado da branch, só nos projetos com `.ovseer/deploy.json`. O menu mostra a release atual
 * como uma lista numerada de etapas (com as suítes de teste como sub-etapas), a trava compartilhada entre
 * computadores e as ações: novo deploy (plano → confirmação), cancelar, retomar, liberar trava abandonada.
 * O estado vem do console local de deploy do repositório, que o app sobe como serviço quando preciso.
 */
const open = ref(false)
const root = ref<HTMLElement>()
const manifest = ref<DeployManifest | null>(null)
const manifestError = ref('')
const snap = ref<DeploySnapshot | null>(null)
const lock = ref<DeployLock | null>(null)
const lockError = ref('')
const lockLoading = ref(false)
const busy = ref<'' | 'console' | 'plan' | 'run' | 'cancel' | 'resume' | 'unlock'>('')
const expanded = ref<string | null>(null)
const logText = ref('')
const logLoading = ref(false)
const planning = ref(false)
const typesenseFirst = ref(false)
const plan = ref<DeployPlanResult | null>(null)
const confirmCancel = ref(false)
const confirmUnlock = ref(false)
const historyOpen = ref(false)
const now = ref(Date.now())

const repoRoot = computed(() => state.repo?.root ?? '')
const current = computed(() => snap.value?.current ?? null)
const steps = computed(() => (manifest.value ? buildDeploySteps(manifest.value, current.value) : []))
const operation = computed(() => snap.value?.operation ?? null)
const live = computed(() => !!operation.value || isLiveRelease(current.value))
/** Trava de outro lugar: a deste computador aparece junto com a operação ativa do console */
const lockedElsewhere = computed(() => lock.value?.status === 'active' && !operation.value)
const dot = computed(() => {
  if (!snap.value) return ''
  if (snap.value.console !== 'ready') return 'off'
  if (live.value) return 'live'
  if (lockedElsewhere.value) return 'locked'
  if (current.value?.status === 'failed') return 'failed'
  if (isSuccessfulRelease(current.value)) return 'ok'
  return ''
})
const history = computed(() => (snap.value?.releases ?? []).slice(0, 8))
const elapsed = computed(() => {
  const c = current.value
  if (!c?.created_at) return ''
  const end = isLiveRelease(c) ? now.value : Date.parse(c.updated_at ?? '') || now.value
  return formatDuration(end - Date.parse(c.created_at))
})
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '')
const date = (iso?: string) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const stepTime = (s: DeployStepView) => {
  if (!s.startedAt) return ''
  const end = s.endedAt ? Date.parse(s.endedAt) : s.status === 'running' ? now.value : NaN
  return Number.isFinite(end) ? formatDuration(end - Date.parse(s.startedAt)) : ''
}
const buildLine = (p: DeployPlanResult) => {
  const b = p.plan.plan?.build ?? {}
  const parts = [b.backend ? 'backend' : '', b.frontend ? 'frontend' : ''].filter(Boolean)
  return parts.length ? parts.join(' e ') : 'nada a reconstruir'
}
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const emptySnap = (): DeploySnapshot => ({ console: 'stopped', origin: '', operation: null, releases: [], current: null, expectedTests: 0 })

async function loadManifest() {
  manifest.value = null
  manifestError.value = ''
  snap.value = null
  lock.value = null
  lockError.value = ''
  open.value = false
  if (!repoRoot.value) return
  const r = repoRoot.value
  const res = await api.deployManifest(r).catch(() => ({ manifest: null, error: 'Não consegui ler o .ovseer/deploy.json.' }))
  if (repoRoot.value !== r) return
  manifest.value = res.manifest
  manifestError.value = res.error ?? ''
  if (manifest.value) void refresh()
}

let refreshing = false
async function refresh() {
  if (!manifest.value || refreshing) return
  refreshing = true
  const r = repoRoot.value
  try {
    const s = await api.deploySnapshot(r)
    if (repoRoot.value === r) snap.value = s
  } catch (e) {
    if (repoRoot.value === r) snap.value = { ...emptySnap(), console: 'error', error: cleanErr(e) }
  } finally {
    refreshing = false
  }
}

/** A trava passa pelo console e pelo S3: um ou dois segundos por consulta */
async function refreshLock() {
  if (!manifest.value || snap.value?.console !== 'ready' || lockLoading.value) return
  lockLoading.value = true
  const r = repoRoot.value
  try {
    const l = await api.deployLock(r)
    if (repoRoot.value === r) {
      lock.value = l
      lockError.value = ''
    }
  } catch (e) {
    if (repoRoot.value === r) lockError.value = cleanErr(e)
  } finally {
    lockLoading.value = false
  }
}

// ritmo: fechado, só o ponto do botão a cada 20 s; aberto, 2 s com operação ou console subindo, 6 s parado; trava a cada 20 s
let timer: ReturnType<typeof setInterval> | null = null
let tick = 0
function onTick() {
  now.value = Date.now()
  tick += 1
  if (!manifest.value) return
  const fast = open.value && (live.value || snap.value?.console === 'starting')
  const every = open.value ? (fast ? 2 : 6) : 20
  if (tick % every === 0) void refresh()
  if (open.value && tick % 20 === 0) void refreshLock()
}

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  confirmCancel.value = false
  confirmUnlock.value = false
  planning.value = false
  plan.value = null
  await refresh()
  void refreshLock()
}

async function startConsole() {
  busy.value = 'console'
  try {
    await api.deployStartConsole(repoRoot.value)
    snap.value = { ...(snap.value ?? emptySnap()), console: 'starting' }
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

async function makePlan() {
  busy.value = 'plan'
  plan.value = null
  try {
    plan.value = await api.deployPlan(repoRoot.value, typesenseFirst.value)
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

async function runDeploy() {
  if (!plan.value) return
  busy.value = 'run'
  try {
    const tag = plan.value.plan.tag
    await api.deployRun(repoRoot.value, plan.value.plan_id)
    planning.value = false
    plan.value = null
    toast(`Deploy ${tag} iniciado.`)
    await refresh()
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

async function cancelDeploy() {
  const op = operation.value
  if (!op) return
  busy.value = 'cancel'
  try {
    await api.deployCancel(repoRoot.value, op.operation_id, op.release_tag)
    confirmCancel.value = false
    toast('Cancelamento solicitado.')
    await refresh()
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

async function resumeDeploy() {
  const c = current.value
  if (!c) return
  busy.value = 'resume'
  try {
    await api.deployResume(repoRoot.value, c.tag)
    toast(`Retomando ${c.tag}…`)
    await refresh()
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

async function unlock() {
  busy.value = 'unlock'
  try {
    lock.value = await api.deployReleaseLock(repoRoot.value)
    confirmUnlock.value = false
    toast('Trava liberada.')
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

async function toggleStep(s: DeployStepView) {
  if (expanded.value === s.id) {
    expanded.value = null
    return
  }
  expanded.value = s.id
  logText.value = ''
  const c = current.value
  if (!c || !s.phases.length) return
  logLoading.value = true
  try {
    const parts = await Promise.all(s.phases.map((p) => api.deployLog(repoRoot.value, c.tag, p).catch(() => '')))
    if (expanded.value === s.id) logText.value = parts.filter(Boolean).join('\n').trim().slice(-6000)
  } finally {
    logLoading.value = false
  }
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  timer = setInterval(onTick, 1000)
  void loadManifest()
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  if (timer) clearInterval(timer)
})
watch(repoRoot, () => void loadManifest())
</script>

<template>
  <div v-if="manifest || manifestError" ref="root" class="deploy-menu">
    <button
      class="badge accent deploy"
      :class="{ on: open, broken: !!manifestError }"
      :title="manifestError || `${manifest?.name}: deploy deste projeto pelo Ovseer`"
      @click="toggle"
    >
      <Icon name="cloudUp" :size="13" />
      <span>{{ manifest?.name ?? 'Deploy' }}</span>
      <span v-if="dot" class="dot" :class="dot" />
      <Icon name="chevron" :size="11" class="chev" />
    </button>
    <div v-if="open" class="pop" @keydown.esc="open = false">
      <p v-if="manifestError" class="msg err">{{ manifestError }}</p>
      <template v-else>
        <p v-if="!snap" class="msg faint"><span class="spinner" /> Consultando o console de deploy…</p>
        <div v-else-if="snap.console === 'stopped'" class="console-off">
          <p class="muted">O console de deploy deste projeto está parado.</p>
          <button class="small primary" :disabled="busy === 'console'" @click="startConsole"><Icon name="play" :size="13" /> Ligar console</button>
        </div>
        <p v-else-if="snap.console === 'starting'" class="msg faint"><span class="spinner" /> Subindo o console (<span class="mono">{{ manifest?.start }}</span>)… pode levar um minuto.</p>
        <p v-else-if="snap.console === 'error'" class="msg err">{{ snap.error }}</p>
        <template v-else>
          <div v-if="lockError" class="lockbar broken">
            <Icon name="alert" :size="14" />
            <span class="txt">Não consegui consultar a trava compartilhada: {{ lockError }}</span>
          </div>
          <div v-else-if="lockedElsewhere && lock" class="lockbar" :class="{ stale: lock.stale }">
            <Icon name="lock" :size="14" />
            <span class="txt">{{ lockLine(lock, now) }}</span>
            <template v-if="lock.stale">
              <button v-if="!confirmUnlock" class="ghost small" title="Só depois de confirmar com o outro operador que o deploy foi abandonado" @click="confirmUnlock = true">Liberar trava</button>
              <button v-else class="small danger" :disabled="busy === 'unlock'" @click="unlock">Confirmar liberação</button>
            </template>
          </div>

          <div v-if="current" class="head">
            <div class="tagline">
              <span class="tag mono">{{ current.tag }}</span>
              <span class="status" :class="current.status">{{ releaseStatusLabel(current.status) }}</span>
            </div>
            <div class="meta faint">
              commit <span class="mono">{{ (current.commit ?? '').slice(0, 8) }}</span>
              · início {{ time(current.created_at) }}
              · {{ live ? 'decorrido' : 'duração' }} <span class="mono">{{ elapsed }}</span>
              <template v-if="operation"> · operação: {{ operation.name }}</template>
            </div>
          </div>
          <p v-else class="msg faint">Nenhuma release registrada neste computador.</p>

          <ol class="steps">
            <li v-for="s in steps" :key="s.id" :class="[s.status, { open: expanded === s.id }]">
              <button class="row" @click="toggleStep(s)">
                <span class="mark">
                  <span v-if="s.status === 'running'" class="spinner" />
                  <Icon v-else-if="s.status === 'completed'" name="check" :size="12" />
                  <Icon v-else-if="s.status === 'failed'" name="x" :size="12" />
                  <span v-else-if="s.status === 'skipped'" class="skip">–</span>
                </span>
                <span class="num mono">{{ s.index }}.</span>
                <span class="title ellipsis">{{ s.title }}</span>
                <span class="detail faint ellipsis">{{ s.detail }}</span>
                <span class="time mono faint">{{ stepTime(s) }}</span>
              </button>
              <ul v-if="s.subs.length && (expanded === s.id || s.status === 'running')" class="subs">
                <li v-for="(sub, i) in s.subs" :key="sub.id" :class="sub.status">
                  <span class="mark">
                    <span v-if="sub.status === 'running'" class="spinner" />
                    <Icon v-else-if="sub.status === 'completed'" name="check" :size="11" />
                    <Icon v-else name="x" :size="11" />
                  </span>
                  <span class="num mono">{{ s.index }}.{{ i + 1 }}</span>
                  <span class="title ellipsis">{{ sub.title }}</span>
                  <span class="detail faint mono">{{ sub.detail }}</span>
                </li>
              </ul>
              <div v-if="expanded === s.id" class="more">
                <p v-if="s.error" class="err">{{ s.error }}</p>
                <p v-if="logLoading" class="faint"><span class="spinner" /> Carregando log…</p>
                <pre v-else-if="logText" class="log mono">{{ logText }}</pre>
                <p v-else-if="s.phases.length" class="faint">Sem log para esta etapa.</p>
                <p v-else class="faint">Etapa ainda não começou.</p>
              </div>
            </li>
          </ol>

          <div v-if="planning" class="plan">
            <template v-if="!plan">
              <label class="check"><input v-model="typesenseFirst" type="checkbox" :disabled="busy === 'plan'" /> Typesense primeiro (loja virtual antes de Sistemas)</label>
              <p v-if="busy === 'plan'" class="faint"><span class="spinner" /> Gerando o plano: git, AWS e trava… pode levar alguns minutos.</p>
              <div class="actions">
                <button class="small primary" :disabled="busy === 'plan'" @click="makePlan">Gerar plano</button>
                <button class="ghost small" :disabled="busy === 'plan'" @click="planning = false">Voltar</button>
              </div>
            </template>
            <template v-else>
              <p><strong class="mono">{{ plan.plan.tag }}</strong> · commit <span class="mono">{{ plan.plan.commit.slice(0, 8) }}</span> · anterior <span class="mono">{{ plan.plan.previous_tag || '—' }}</span></p>
              <p class="muted">Ordem: {{ plan.plan.order }} · build: {{ buildLine(plan) }}</p>
              <ul v-if="plan.plan.plan?.warnings?.length" class="warnings">
                <li v-for="w in plan.plan.plan.warnings" :key="w">{{ w }}</li>
              </ul>
              <div class="actions">
                <button class="small primary" :disabled="busy === 'run'" @click="runDeploy"><Icon name="cloudUp" :size="13" /> Confirmar deploy</button>
                <button class="ghost small" :disabled="busy === 'run'" @click="plan = null">Voltar</button>
              </div>
            </template>
          </div>

          <div class="foot">
            <template v-if="operation">
              <button v-if="operation.cancellable && !confirmCancel" class="ghost small" :disabled="!!operation.cancel_requested_at" @click="confirmCancel = true">
                <Icon name="stop" :size="13" /> {{ operation.cancel_requested_at ? 'Cancelando…' : 'Cancelar' }}
              </button>
              <button v-else-if="operation.cancellable" class="small danger" :disabled="busy === 'cancel'" @click="cancelDeploy">Confirmar cancelamento</button>
            </template>
            <template v-else-if="!planning">
              <button class="small primary" :disabled="lockedElsewhere || busy !== ''" :title="lockedElsewhere ? 'Outro computador está com a trava' : 'Gera o plano e pede confirmação antes de iniciar'" @click="planning = true">
                <Icon name="cloudUp" :size="13" /> Novo deploy
              </button>
              <button v-if="current?.status === 'failed'" class="ghost small" :disabled="lockedElsewhere || busy !== ''" :title="`Retoma ${current.tag} de onde parou`" @click="resumeDeploy">
                <Icon name="forward" :size="13" /> Retomar
              </button>
            </template>
            <span class="spacer" />
            <button class="ghost small icon" :class="{ on: historyOpen }" title="Releases anteriores" @click="historyOpen = !historyOpen"><Icon name="history" :size="13" /></button>
            <button class="ghost small icon" title="Abrir o console no navegador" @click="api.deployOpenConsole(repoRoot)"><Icon name="external" :size="13" /></button>
            <button class="ghost small icon" title="Atualizar" @click="refresh(); refreshLock()"><Icon name="refresh" :size="13" /></button>
          </div>
          <div v-if="historyOpen" class="history">
            <h6>Releases anteriores</h6>
            <div v-for="r in history" :key="r.tag" class="hrow">
              <span class="mono">{{ r.tag }}</span>
              <span class="status" :class="r.status">{{ releaseStatusLabel(r.status) }}</span>
              <span class="faint">{{ date(r.created_at) }}</span>
            </div>
            <p v-if="!history.length" class="faint msg">Nenhuma release neste computador.</p>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.deploy-menu { position: relative; -webkit-app-region: no-drag; min-width: 0; }
.deploy { border: 0; height: 24px; gap: 5px; cursor: pointer; }
.deploy:hover, .deploy.on { filter: brightness(1.15); }
.deploy.broken { color: var(--mod); }
.chev { transform: rotate(90deg); opacity: 0.7; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.dot.ok { background: var(--add); }
.dot.live { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
.dot.failed { background: var(--del); }
.dot.locked { background: var(--mod); }
.dot.off { background: var(--faint); opacity: 0.5; }
@keyframes pulse { 50% { opacity: 0.35; } }
.pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; width: min(480px, calc(100vw - 24px)); padding: 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  max-height: calc(100vh - 80px); overflow: auto; font-size: 12.5px;
}
.msg { margin: 8px; display: flex; gap: 8px; align-items: center; }
.err { color: var(--del); white-space: pre-wrap; word-break: break-word; }
.console-off { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 8px; }
.console-off p { margin: 0; }
.lockbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; background: var(--accent-soft); color: var(--text); }
.lockbar > svg { color: var(--mod); flex: none; }
.lockbar.stale { outline: 1px solid var(--mod); }
.lockbar.broken > svg { color: var(--del); }
.lockbar .txt { flex: 1; min-width: 0; }
.head { padding: 6px 8px 8px; }
.tagline { display: flex; align-items: center; gap: 10px; }
.tag { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.status { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
.status.running, .status.validating { color: var(--accent); background: var(--accent-soft); }
.status.failed { color: var(--del); }
.status.completed, .status.critical_passed { color: var(--add); }
.meta { margin-top: 3px; font-size: 11.5px; }
.steps { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.steps > li { border-bottom: 1px solid var(--border); }
.row { width: 100%; height: auto; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 0; background: transparent; text-align: left; font-weight: 400; border-radius: 0; }
.row:hover { background: var(--hover); }
.mark { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; border: 1.5px solid var(--border); color: var(--faint); }
li.completed > .row .mark { border-color: var(--add); color: var(--add); }
li.failed > .row .mark { border-color: var(--del); color: var(--del); }
li.running > .row .mark { border-color: var(--accent); color: var(--accent); }
li.skipped > .row .mark { border-style: dashed; }
li.pending > .row { color: var(--muted); }
.mark .spinner { width: 10px; height: 10px; }
.skip { font-size: 11px; line-height: 1; }
.num { color: var(--muted); flex: none; width: 24px; text-align: right; }
.title { font-weight: 600; flex: 1; min-width: 0; }
li.pending .title { font-weight: 500; }
.detail { font-size: 11.5px; max-width: 46%; }
.time { font-size: 11px; width: 54px; text-align: right; flex: none; }
.subs { list-style: none; margin: 0 0 4px; padding: 0 0 0 30px; }
.subs li { display: flex; align-items: center; gap: 8px; padding: 2px 8px; font-size: 11.5px; }
.subs .mark { width: 14px; height: 14px; border-width: 1px; }
.subs li.completed .mark { border-color: var(--add); color: var(--add); }
.subs li.failed .mark { border-color: var(--del); color: var(--del); }
.subs li.running .mark { border-color: var(--accent); color: var(--accent); }
.subs .mark .spinner { width: 8px; height: 8px; }
.subs .num { width: 30px; }
.more { padding: 2px 8px 8px 38px; }
.more p { margin: 4px 0; }
.log { margin: 4px 0 0; padding: 8px; max-height: 220px; overflow: auto; font-size: 11px; line-height: 1.4; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.plan { margin-top: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); display: flex; flex-direction: column; gap: 8px; }
.plan p { margin: 0; }
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.check input { margin: 0; }
.warnings { margin: 0; padding-left: 18px; color: var(--mod); }
.actions { display: flex; gap: 6px; }
button.danger { background: var(--del); border-color: var(--del); color: var(--on-accent); }
.foot { display: flex; align-items: center; gap: 4px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.foot .icon { width: 28px; padding: 0; }
.foot .icon.on { color: var(--accent); background: var(--accent-soft); }
.spacer { flex: 1; }
.history { margin-top: 6px; }
h6 { margin: 8px 8px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.hrow { display: flex; align-items: center; gap: 10px; padding: 4px 8px; font-size: 12px; }
.hrow .mono:first-child { flex: 1; }
</style>
