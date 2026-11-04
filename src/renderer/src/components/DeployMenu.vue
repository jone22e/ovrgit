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
const planError = ref('')
/** Conta os pedidos de plano, para um resultado atrasado não sobrescrever o atual */
let planRequest = 0
const confirmCancel = ref(false)
const confirmUnlock = ref(false)
const confirmResume = ref(false)
/**
 * Verificação em duas etapas: obrigatória. Iniciar, retomar e liberar a trava pedem o código do autenticador;
 * sem ela ativada (null: ainda não consultada) o app não deixa começar e manda para Configurações → Deploy.
 */
const totp = ref<boolean | null>(null)
const authCode = ref('')
const codeOk = computed(() => totp.value === true && /^\d{6}$/.test(authCode.value.replace(/\s/g, '')))
const codeArg = () => authCode.value.replace(/\s/g, '')
function openDeploySettings() {
  try {
    localStorage.setItem('ovseer.settings.section', 'deploy')
  } catch {
    /* só nesta sessão */
  }
  open.value = false
  state.showSettings = true
}
const historyOpen = ref(false)
const now = ref(Date.now())

const repoRoot = computed(() => state.repo?.root ?? '')
/** Adaptador de script: sem console, sem trava compartilhada, sem retomada */
const isScript = computed(() => manifest.value?.kind === 'script')
/** Alvos do deploy (uma loja, um ambiente…): escolhidos a cada novo deploy, sem lembrar o anterior */
const targets = computed(() => (manifest.value?.kind === 'script' ? manifest.value.targets ?? [] : []))
const target = ref('')
const targetTitle = (id?: string) => targets.value.find((t) => t.id === id)?.title ?? id ?? ''
const lockSupported = computed(() => snap.value?.lockSupported !== false)
const current = computed(() => snap.value?.current ?? null)
const steps = computed(() => (manifest.value ? buildDeploySteps(manifest.value, current.value) : []))
const operation = computed(() => snap.value?.operation ?? null)
const live = computed(() => !!operation.value || isLiveRelease(current.value))
/** Trava de outro lugar: a deste computador aparece junto com a operação ativa do console */
const lockedElsewhere = computed(() => lock.value?.status === 'active' && !operation.value)
/**
 * Ponto do botão, pela etapa: azul pulsando quando algo está rodando (plano, deploy, console subindo);
 * vermelho pulsando quando espera um clique seu (plano pronto para aprovar, release falhada para retomar);
 * amarelo com trava de outro computador; verde quando a última release terminou bem.
 */
const dot = computed(() => {
  if (!snap.value) return ''
  if (snap.value.console === 'starting' || busy.value === 'plan' || busy.value === 'run' || live.value) return 'live'
  if (snap.value.console !== 'ready') return 'off'
  if (planning.value && plan.value) return 'wait'
  if (lockedElsewhere.value) return 'locked'
  if (current.value?.status === 'failed') return 'wait'
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
  const ms = end - Date.parse(s.startedAt)
  return Number.isFinite(ms) && (ms >= 1000 || s.status === 'running') ? formatDuration(ms) : ''
}
const buildLine = (p: DeployPlanResult) => {
  const b = p.plan.plan?.build ?? {}
  const parts = [b.backend ? 'backend' : '', b.frontend ? 'frontend' : ''].filter(Boolean)
  return parts.length ? parts.join(' e ') : 'nada a reconstruir'
}
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const emptySnap = (): DeploySnapshot => ({ console: 'stopped', origin: '', operation: null, releases: [], current: null, expectedTests: 0, lockSupported: true })

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
  if (!manifest.value || snap.value?.console !== 'ready' || !lockSupported.value || lockLoading.value) return
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
  confirmResume.value = false
  authCode.value = ''
  stopPlanning()
  void api.deployAuthStatus().then((s) => (totp.value = s.enabled)).catch(() => (totp.value = false))
  await refresh()
  void refreshLock()
}

async function startConsole() {
  busy.value = 'console'
  try {
    const registered = snap.value?.service?.registered !== false
    await api.deployStartConsole(repoRoot.value)
    if (!registered) toast('Serviço cadastrado em Serviços.')
    snap.value = { ...(snap.value ?? emptySnap()), console: 'starting' }
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = ''
  }
}

/** Abre a tela de novo deploy e já gera o plano; nada é enviado antes da aprovação */
function startPlanning() {
  planning.value = true
  plan.value = null
  planError.value = ''
  target.value = ''
  if (!targets.value.length) void makePlan()
}

async function makePlan() {
  const request = ++planRequest
  busy.value = 'plan'
  plan.value = null
  planError.value = ''
  try {
    const result = await api.deployPlan(repoRoot.value, typesenseFirst.value, target.value || undefined)
    if (request === planRequest) plan.value = result
  } catch (e) {
    if (request === planRequest) planError.value = cleanErr(e)
  } finally {
    if (request === planRequest) busy.value = ''
  }
}

function stopPlanning() {
  planRequest += 1
  planning.value = false
  plan.value = null
  planError.value = ''
  if (busy.value === 'plan') busy.value = ''
}

/** Trocar a opção ou o alvo durante a tela de novo deploy refaz o plano */
watch(typesenseFirst, () => {
  if (planning.value) void makePlan()
})
watch(target, (t) => {
  if (planning.value && t) void makePlan()
})
const changeReasons = computed(() => (plan.value?.plan.plan?.reasons ?? []).slice(0, 6))

async function runDeploy() {
  if (!plan.value) return
  busy.value = 'run'
  try {
    const tag = plan.value.plan.tag
    await api.deployRun(repoRoot.value, plan.value.plan_id, codeArg())
    authCode.value = ''
    stopPlanning()
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
    await api.deployResume(repoRoot.value, c.tag, codeArg())
    authCode.value = ''
    confirmResume.value = false
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
    lock.value = await api.deployReleaseLock(repoRoot.value, codeArg())
    authCode.value = ''
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
      <span v-if="dot === 'ok'" class="done" title="Última release concluída"><Icon name="check" :size="12" /></span>
      <span v-else-if="dot" class="dot" :class="dot" />
      <Icon name="chevron" :size="11" class="chev" />
    </button>
    <div v-if="open" class="pop" @keydown.esc="open = false">
      <p v-if="manifestError" class="msg err">{{ manifestError }}</p>
      <template v-else>
        <p v-if="!snap" class="msg faint"><span class="spinner" /> Consultando o console de deploy…</p>
        <div v-else-if="snap.console === 'stopped'" class="console-off">
          <template v-if="snap.service && !snap.service.registered">
            <p class="muted">O console de deploy ainda não está nos seus Serviços. Cadastrar e ligar?</p>
            <p class="proposal"><strong>{{ snap.service.name }}</strong><span class="mono">{{ snap.service.command }}</span><span class="faint ellipsis">{{ snap.service.cwd }}</span></p>
            <button class="small primary" :disabled="busy === 'console'" @click="startConsole"><Icon name="plus" :size="13" /> Cadastrar e ligar</button>
          </template>
          <template v-else>
            <p class="muted">O console de deploy deste projeto está parado.</p>
            <button class="small primary" :disabled="busy === 'console'" @click="startConsole"><Icon name="play" :size="13" /> Ligar console</button>
          </template>
        </div>
        <p v-else-if="snap.console === 'starting'" class="msg faint"><span class="spinner" /> Subindo o console (<span class="mono">{{ manifest?.kind === 'console' ? manifest.start : '' }}</span>)… pode levar um minuto.</p>
        <p v-else-if="snap.console === 'error'" class="msg err">{{ snap.error }}</p>
        <template v-else>
          <div v-if="lockSupported && lockError" class="lockbar broken">
            <Icon name="alert" :size="14" />
            <span class="txt">Não consegui consultar a trava compartilhada: {{ lockError }}</span>
          </div>
          <div v-else-if="lockSupported && lockedElsewhere && lock" class="lockbar" :class="{ stale: lock.stale }">
            <Icon name="lock" :size="14" />
            <span class="txt">{{ lockLine(lock, now) }}</span>
            <template v-if="lock.stale">
              <button v-if="!confirmUnlock" class="ghost small" title="Só depois de confirmar com o outro operador que o deploy foi abandonado" @click="confirmUnlock = true; authCode = ''">Liberar trava</button>
              <template v-else>
                <input v-if="totp" v-model="authCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="mono code" placeholder="código" spellcheck="false" />
                <button v-if="totp" class="small danger" :disabled="busy === 'unlock' || !codeOk" @click="unlock">Confirmar liberação</button>
                <button v-else class="small" @click="openDeploySettings">Ativar verificação</button>
              </template>
            </template>
          </div>

          <div v-if="planning" class="newdeploy">
            <h5><Icon name="cloudUp" :size="15" /> Novo deploy</h5>
            <label v-if="!isScript" class="check"><input v-model="typesenseFirst" type="checkbox" :disabled="busy === 'plan' || busy === 'run'" /> Typesense primeiro (loja virtual antes de Sistemas)</label>
            <div v-if="targets.length" class="targets">
              <button v-for="t in targets" :key="t.id" class="small" :class="{ primary: target === t.id }" :disabled="busy === 'run'" @click="target = t.id">{{ t.title }}</button>
            </div>

            <p v-if="targets.length && !target" class="msg faint">Escolha o alvo para gerar o plano.</p>
            <div v-else-if="busy === 'plan'" class="planning">
              <span class="spinner" />
              <div>
                <strong>Preparando o plano…</strong>
                <small v-if="isScript">Conferindo a branch e as alterações locais. Nada é enviado nesta etapa.</small>
                <small v-else>Conferindo main e origin, acesso à AWS, a trava compartilhada e o que mudou desde a última release. Pode levar alguns minutos. Nada é enviado nesta etapa.</small>
              </div>
            </div>

            <div v-else-if="plan" class="approve">
              <div class="planbox">
                <div class="tagline">
                  <span class="tag mono">{{ plan.plan.tag }}</span>
                  <span v-if="plan.plan.target" class="status target">{{ targetTitle(plan.plan.target) }}</span>
                  <span class="status">aguardando aprovação</span>
                </div>
                <div class="meta faint">
                  commit <span class="mono">{{ plan.plan.commit.slice(0, 8) }}</span>
                  · anterior <span class="mono">{{ plan.plan.previous_tag || '—' }}</span>
                  <template v-if="!isScript"> · build: {{ buildLine(plan) }}</template>
                </div>
                <div v-if="isScript" class="meta faint">Comando: <span class="mono">{{ plan.plan.order }}</span></div>
                <div v-else class="meta faint">Ordem: {{ plan.plan.order }}</div>
                <ul v-if="changeReasons.length" class="reasons">
                  <li v-for="r in changeReasons" :key="r">{{ r }}</li>
                </ul>
                <ul v-if="plan.plan.plan?.warnings?.length" class="warnings">
                  <li v-for="w in plan.plan.plan.warnings" :key="w">{{ w }}</li>
                </ul>
              </div>
              <p class="note"><Icon name="shield" :size="13" /> Nada foi enviado ainda. O deploy só começa depois da sua aprovação.</p>
              <div v-if="totp === false" class="auth-off">
                <p><Icon name="lock" :size="13" /> O deploy exige a verificação em duas etapas com o autenticador do telefone, ainda não ativada neste computador.</p>
                <button class="small primary" @click="openDeploySettings"><Icon name="shield" :size="13" /> Ativar em Configurações → Deploy</button>
              </div>
              <template v-else>
                <label class="auth">
                  <span>Código do aplicativo autenticador</span>
                  <input v-model="authCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="mono code" placeholder="000 000" spellcheck="false" @keydown.enter.prevent="codeOk && runDeploy()" />
                </label>
                <button class="primary approve-btn" :disabled="busy === 'run' || !codeOk" @click="runDeploy">
                  <Icon name="check" :size="15" /> {{ busy === 'run' ? 'Iniciando…' : `Aprovar e iniciar o deploy${plan.plan.target ? ` de ${targetTitle(plan.plan.target)}` : ''} (${plan.plan.tag})` }}
                </button>
              </template>
              <button class="ghost small" :disabled="busy === 'run'" @click="stopPlanning">Cancelar</button>
            </div>

            <div v-else class="planfail">
              <p class="err">{{ planError || 'Não foi possível gerar o plano.' }}</p>
              <div class="actions">
                <button class="small" @click="makePlan">Tentar de novo</button>
                <button class="ghost small" @click="stopPlanning">Voltar</button>
              </div>
            </div>
          </div>
          <template v-else>
          <div v-if="current" class="head">
            <div class="tagline">
              <span class="tag mono">{{ current.tag }}</span>
              <span v-if="current.target" class="status target">{{ targetTitle(current.target) }}</span>
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
                  <Icon v-else-if="s.status === 'completed'" name="check" :size="13" />
                  <Icon v-else-if="s.status === 'failed'" name="x" :size="13" />
                  <span v-else-if="s.status === 'skipped'" class="skip">–</span>
                </span>
                <span class="num">{{ s.index }}.</span>
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
                  <span class="num">{{ s.index }}.{{ i + 1 }}</span>
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

          <div class="foot">
            <template v-if="operation">
              <button v-if="operation.cancellable && !confirmCancel" class="ghost small" :disabled="!!operation.cancel_requested_at" @click="confirmCancel = true">
                <Icon name="stop" :size="13" /> {{ operation.cancel_requested_at ? 'Cancelando…' : 'Cancelar' }}
              </button>
              <button v-else-if="operation.cancellable" class="small danger" :disabled="busy === 'cancel'" @click="cancelDeploy">Confirmar cancelamento</button>
            </template>
            <template v-else>
              <button class="small primary" :disabled="lockedElsewhere || busy !== ''" :title="lockedElsewhere ? 'Outro computador está com a trava' : 'Gera o plano e pede sua aprovação antes de iniciar'" @click="startPlanning">
                <Icon name="cloudUp" :size="13" /> Novo deploy
              </button>
              <template v-if="!isScript && current?.status === 'failed'">
                <button v-if="!confirmResume" class="ghost small" :disabled="lockedElsewhere || busy !== ''" :title="`Retoma ${current.tag} de onde parou`" @click="totp ? (confirmResume = true, authCode = '') : openDeploySettings()">
                  <Icon name="forward" :size="13" /> Retomar
                </button>
                <template v-else>
                  <input v-model="authCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="mono code" placeholder="código" spellcheck="false" @keydown.enter.prevent="codeOk && resumeDeploy()" />
                  <button class="small primary" :disabled="busy === 'resume' || !codeOk" @click="resumeDeploy">Retomar {{ current.tag }}</button>
                  <button class="ghost small" @click="confirmResume = false">Voltar</button>
                </template>
              </template>
            </template>
            <span class="spacer" />
            <button class="ghost small icon" :class="{ on: historyOpen }" title="Releases anteriores" @click="historyOpen = !historyOpen"><Icon name="history" :size="13" /></button>
            <button v-if="!isScript" class="ghost small icon" title="Abrir o console no navegador" @click="api.deployOpenConsole(repoRoot)"><Icon name="external" :size="13" /></button>
            <button class="ghost small icon" title="Atualizar" @click="refresh(); refreshLock()"><Icon name="refresh" :size="13" /></button>
          </div>
          </template>
          <div v-if="historyOpen && !planning" class="history">
            <h6>Releases anteriores</h6>
            <div v-for="r in history" :key="r.tag" class="hrow">
              <span class="mono">{{ r.tag }}</span>
              <span v-if="r.target" class="status target">{{ targetTitle(r.target) }}</span>
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
.dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.done { display: inline-flex; align-items: center; color: var(--add); flex: none; }
.done svg { stroke-width: 3; }
.dot.locked { background: var(--mod); }
.dot.off { background: var(--faint); opacity: 0.5; }
/* rodando (azul) e esperando você (vermelho): a bolinha pisca e solta um anel que se expande */
.dot.live { background: var(--accent); animation: blink 1s ease-in-out infinite; }
.dot.wait { background: var(--del); animation: blink 1s ease-in-out infinite; }
.dot.live::after, .dot.wait::after { content: ''; position: absolute; inset: -1px; border-radius: 50%; border: 2px solid currentColor; color: var(--accent); animation: ring 1.4s ease-out infinite; }
.dot.wait::after { color: var(--del); }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
@keyframes ring { 0% { transform: scale(1); opacity: 0.8; } 100% { transform: scale(2.6); opacity: 0; } }
.pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; width: min(440px, calc(100vw - 24px)); padding: 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  max-height: calc(100vh - 80px); overflow: auto; font-size: 12.5px;
}
.msg { margin: 8px; display: flex; gap: 8px; align-items: center; }
.err { color: var(--del); white-space: pre-wrap; word-break: break-word; }
.console-off { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 8px; }
.console-off p { margin: 0; }
.proposal { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); max-width: 100%; }
.proposal .mono { font-size: 12px; }
.proposal .faint { font-size: 11px; }
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
.status.target { color: var(--text); background: var(--panel-2); border: 1px solid var(--border); }
.targets { display: flex; gap: 6px; flex-wrap: wrap; }
.meta { margin-top: 3px; font-size: 11.5px; }
.steps { list-style: none; margin: 2px 0 0; padding: 2px 0 0; position: relative; }
/* trilho vertical discreto, passando pelo centro dos marcadores (6px de padding + metade dos 22px) */
.steps > li { position: relative; }
.steps > li::before { content: ''; position: absolute; left: 16px; top: 0; bottom: 0; width: 2px; background: var(--border); opacity: 0.8; }
.steps > li:first-child::before { top: 16px; }
.steps > li:last-child::before { bottom: calc(100% - 16px); }
.row { position: relative; width: 100%; height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; border: 0; background: transparent; text-align: left; font-weight: 400; border-radius: 8px; }
.row:hover { background: var(--hover); }
.mark { position: relative; z-index: 1; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; border: 2px solid var(--border); background: var(--panel); color: var(--faint); }
li.completed > .row .mark { border-color: var(--add); background: var(--add); color: #fff; }
li.failed > .row .mark { border-color: var(--del); background: var(--del); color: #fff; }
li.running > .row .mark { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
li.skipped > .row .mark { border-style: dashed; }
li.pending > .row .mark { background: var(--panel-2); }
li.pending > .row { color: var(--muted); }
.mark .spinner { width: 11px; height: 11px; border-width: 2px; }
.skip { font-size: 12px; line-height: 1; }
.num { color: var(--muted); flex: none; min-width: 22px; text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.title { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; margin-left: -2px; }
li.pending .title { font-weight: 500; }
.detail { font-size: 11.5px; max-width: 46%; }
.time { font-size: 11px; min-width: 40px; text-align: right; flex: none; }
/* sub-etapas penduradas no trilho: ramificação horizontal até um marcador menor */
.subs { list-style: none; margin: 0 0 2px; padding: 0 0 0 40px; }
.subs li { position: relative; display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 8px 0 0; font-size: 12px; }
.subs li::before { content: ''; position: absolute; left: -23px; top: 50%; width: 18px; height: 2px; background: var(--border); opacity: 0.8; }
.subs .mark { width: 16px; height: 16px; border-width: 1.5px; }
.subs li.completed .mark { border-color: var(--add); background: var(--add); color: #fff; }
.subs li.failed .mark { border-color: var(--del); background: var(--del); color: #fff; }
.subs li.running .mark { border-color: var(--accent); color: var(--accent); }
.subs .mark .spinner { width: 8px; height: 8px; }
.subs .num { min-width: 26px; font-size: 12px; }
.subs .title { font-size: 12px; font-weight: 500; }
.more { padding: 2px 8px 8px 40px; }
.more p { margin: 4px 0; }
.log { margin: 4px 0 0; padding: 8px; max-height: 220px; overflow: auto; font-size: 11px; line-height: 1.4; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.newdeploy { display: flex; flex-direction: column; gap: 10px; padding: 4px 4px 2px; }
.newdeploy h5 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; }
.planning { display: flex; align-items: flex-start; gap: 12px; padding: 14px 12px; border: 1px dashed var(--border); border-radius: 10px; }
.planning .spinner { width: 18px; height: 18px; margin-top: 2px; color: var(--accent); }
.planning div { display: flex; flex-direction: column; gap: 3px; }
.planning small { color: var(--muted); font-size: 11.5px; line-height: 1.4; }
.approve { display: flex; flex-direction: column; gap: 8px; }
.planbox { padding: 10px 12px; border: 1px solid var(--accent); border-radius: 10px; background: var(--accent-soft); display: flex; flex-direction: column; gap: 3px; }
.planbox .status { color: var(--accent); background: var(--panel); }
.reasons { margin: 6px 0 0; padding-left: 18px; font-size: 11.5px; color: var(--text); }
.note { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
.approve-btn { height: 36px; font-size: 13px; justify-content: center; }
.auth { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; }
.auth-off { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--mod); border-radius: 8px; background: color-mix(in srgb, var(--mod) 10%, var(--panel)); }
.auth-off p { margin: 0; display: flex; align-items: flex-start; gap: 6px; font-size: 12.5px; line-height: 1.4; }
.auth-off p svg { flex: none; margin-top: 2px; color: var(--mod); }
.auth-off button { align-self: flex-start; }
.code { width: 96px; height: 28px; font-size: 14px; letter-spacing: 0.12em; text-align: center; }
.approve .ghost { align-self: center; }
.planfail { display: flex; flex-direction: column; gap: 8px; }
.planfail p { margin: 0; }
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
