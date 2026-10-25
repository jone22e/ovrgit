<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { KnownModels, QueueTask } from '@shared/types'
import { groupOf } from '@shared/repoGroups'
import { MODES, PROVIDER_LABEL } from '@shared/models'
import { api, ask, saveSettings, state, toast } from '../store'
import { readAgentPrefs } from '../agentPrefs'
import Icon from './Icon.vue'
import MiniComposer from './MiniComposer.vue'
import RepoSelect from './RepoSelect.vue'
import VoiceSetupDialog from './VoiceSetupDialog.vue'

const cwd = ref('')
const extraDirs = ref<string[]>([])
const known = ref<KnownModels | null>(null)
const feed = ref<HTMLElement>()
const archived = ref<QueueTask[]>([])
const archiveCursor = ref<string>()
const archiveReady = ref(false)
const visibleCount = ref(50)
const loadingOlder = ref(false)
const voiceSession = ref(false)
const voiceSessionId = ref<string | null>(null)
const showEarlier = ref(false)
let historyGeneration = 0
const allTasks = computed(() => {
  const seen = new Set<string>()
  return [...state.queue, ...archived.value]
    .filter((task) => {
      if (seen.has(task.id)) return false
      seen.add(task.id)
      return true
    })
    .sort((a, b) => a.createdAt - b.createdAt)
})
const sessionTasks = computed(() => voiceSession.value && !showEarlier.value
  ? allTasks.value.filter((task) => task.managerSessionId === voiceSessionId.value)
  : allTasks.value)
const tasks = computed(() => {
  const all = sessionTasks.value
  return all.filter((task, index) => index >= all.length - visibleCount.value || task.status === 'queued' || task.status === 'running')
})
const hasEarlier = computed(() => voiceSession.value && allTasks.value.some((task) => task.managerSessionId !== voiceSessionId.value))
const hasOlder = computed(() => archiveReady.value && (!voiceSession.value || showEarlier.value) && (visibleCount.value < allTasks.value.length || !!archiveCursor.value))
const canClear = computed(() => allTasks.value.some((task) => (task.status === 'done' || task.status === 'failed') && !task.projectChoices?.length))
async function loadOlder() {
  if (loadingOlder.value) return
  const el = feed.value
  const before = el?.scrollHeight ?? 0
  if (visibleCount.value < allTasks.value.length) visibleCount.value += 50
  else if (archiveCursor.value) {
    loadingOlder.value = true
    const generation = historyGeneration
    try {
      const page = await api.queueHistory(archiveCursor.value)
      if (generation !== historyGeneration) return
      archived.value = [...page.tasks, ...archived.value]
      archiveCursor.value = page.nextCursor
      visibleCount.value += 50
    } catch (e) { toast(String((e as Error).message)) }
    finally { loadingOlder.value = false }
  }
  await nextTick()
  if (el) el.scrollTop += el.scrollHeight - before
}
async function clearConversation() {
  const ok = await ask({ title: 'Limpar histórico do gerenciador?', message: 'Remove os pedidos concluídos e com erro. Pedidos em andamento e escolhas pendentes continuam.', confirmLabel: 'Limpar histórico', danger: true })
  if (!ok) return
  historyGeneration++
  try {
    const remaining = new Set((await api.queueClearFinished()).map((task) => task.id))
    archived.value = []
    archiveCursor.value = undefined
    visibleCount.value = 50
    for (const id of spokenTasks.keys()) if (!remaining.has(id)) spokenTasks.delete(id)
  } catch (e) { toast(String((e as Error).message)) }
}
const voiceSetup = ref(false)
const voicePending = ref(0)
const voicePhase = ref<'idle' | 'generating' | 'playing'>('idle')
let enableVoiceAfterSetup = false
const managerVoiceId = '__manager__'
const voicePlatform = api.platform === 'darwin' || api.platform === 'linux'
const conversation = computed(() => voicePlatform && voiceSession.value)
/** Nomes que o reconhecimento de fala deve favorecer: agentes abertos e projetos recentes */
const dictationTerms = computed(() => [
  ...state.agentSnaps.flatMap((snap) => [snap.project, snap.title]),
  ...(state.settings?.recentProjects ?? []).map((p) => p.split('/').filter(Boolean).pop() ?? '')
])
const scopeLabel = computed(() => {
  const count = state.agentSnaps.length
  return `Todos os projetos · ${count} ${count === 1 ? 'agente' : 'agentes'}`
})
async function toggleConversation() {
  if (conversation.value) {
    voiceSession.value = false
    voiceSessionId.value = null
    showEarlier.value = false
    await api.voiceCancel(managerVoiceId).catch(() => undefined)
    try { await saveSettings({ managerConversationVoice: false }) } catch (e) { toast(String((e as Error).message)) }
    return
  }
  try {
    if (!(await api.voiceStatus()).ready) {
      enableVoiceAfterSetup = true
      voiceSetup.value = true
      return
    }
    await saveSettings({ managerConversationVoice: true })
    voiceSessionId.value = crypto.randomUUID()
    showEarlier.value = false
    voiceSession.value = true
  } catch (e) { toast(String((e as Error).message)) }
}
async function closeVoiceSetup() {
  voiceSetup.value = false
  try {
    if (enableVoiceAfterSetup && (await api.voiceStatus().catch(() => null))?.ready) {
      await saveSettings({ managerConversationVoice: true })
      voiceSessionId.value = crypto.randomUUID()
      showEarlier.value = false
      voiceSession.value = true
    }
  } catch (e) { toast(String((e as Error).message)) }
  enableVoiceAfterSetup = false
}
function speakManagerReply(reply: string) {
  if (!conversation.value) return
  const lines = reply.split('\n')
  const first = lines[0].trim().replace(/:$/, '.')
  const speech = lines.length > 1
    ? reply.startsWith('Encontrei vários projetos')
      ? `Encontrei ${lines.length - 1} projetos com esse nome. Coloquei a situação de cada um no chat.`
      : `${first} Os nomes e detalhes estão no chat.`
    : first
  void api.voiceSpeak(managerVoiceId, speech).catch((e) => toast(String((e as Error).message)))
}
const spokenTasks = new Map<string, { status: QueueTask['status']; announced: boolean }>()
function announceTask(task: QueueTask) {
  if (task.reply) speakManagerReply(task.spokenReply ?? task.reply)
  else if (task.status === 'done') speakManagerReply(`${agentName(task)} concluiu o pedido. A resposta completa está na conversa dele.`)
  else if (task.status === 'failed') speakManagerReply(task.managerBrainFailed ? 'Não consegui consultar o modelo. Mostrei o erro no chat.' : `${agentName(task)} não conseguiu concluir o pedido. Mostrei o motivo no chat.`)
  else speakManagerReply(`Recebi seu pedido para ${where(task)}. Vou acompanhar o agente e avisar quando terminar.`)
}
/**
 * Ação de interface decidida pelo gerenciador, executada uma vez por pedido. Conversa nova: o chat é criado direto
 * na lista de agentes, com o modelo e o modo escolhidos no compositor, e a chamada de voz continua.
 */
const uiActionsRun = new Set<string>()
async function runUiAction(task: QueueTask) {
  const action = task.managerUiAction
  if (!action || uiActionsRun.has(task.id)) return
  uiActionsRun.add(task.id)
  try {
    if (action.type === 'newAgent') {
      const prefs = readAgentPrefs()
      const config = task.config ?? { provider: prefs.provider, model: prefs.model[prefs.provider], effort: prefs.effort[prefs.provider], mode: prefs.mode }
      await api.agentOpen({ ...config, cwd: action.cwd, extraDirs: task.extraDirs ? [...task.extraDirs] : undefined })
    } else {
      if (conversation.value) await toggleConversation()
      await api.agentShow(action.uid)
    }
  } catch (e) { toast(String((e as Error).message)) }
}
function managerTaskSent(task: QueueTask) {
  if (task.managerUiAction) {
    void runUiAction(task)
    if (task.managerUiAction.type !== 'newAgent') return
  }
  if (!conversation.value) return
  if (task.resumedTaskId) {
    const resumed = state.queue.find((item) => item.id === task.resumedTaskId)
    if (resumed) spokenTasks.set(resumed.id, { status: resumed.status, announced: true })
  }
  spokenTasks.set(task.id, { status: task.status, announced: !task.managerThinking })
  if (!task.managerThinking) announceTask(task)
}
watch(() => state.queue.map((t) => `${t.id}:${t.status}:${!!t.managerThinking}`).join('|'), () => {
  const current = new Set(state.queue.map((task) => task.id))
  for (const id of spokenTasks.keys()) if (!current.has(id)) spokenTasks.delete(id)
  for (const task of state.queue) {
    const previous = spokenTasks.get(task.id)
    if (!previous || task.managerThinking) continue
    if (!previous.announced) announceTask(task)
    else if (previous.status !== task.status && (task.status === 'done' || task.status === 'failed')) announceTask(task)
    if (task.status === 'done' && task.managerUiAction) void runUiAction(task)
    spokenTasks.set(task.id, { status: task.status, announced: true })
  }
})
const offVoiceQueue = api.onVoiceQueue((q) => { if (q.uid === managerVoiceId) voicePending.value = q.pending })
const offVoicePhase = api.onVoicePhase((q) => { if (q.uid === managerVoiceId) voicePhase.value = q.phase })
onUnmounted(() => {
  offVoiceQueue()
  offVoicePhase()
  if (voiceSession.value) void api.voiceCancel(managerVoiceId).catch(() => undefined)
})
const name = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const where = (t: QueueTask) => t.cwd ? (groupOf(state.settings?.repoGroups ?? [], t.cwd, t.extraDirs)?.name ?? name(t.cwd)) : 'Todos os projetos'
const agentOf = (t: QueueTask) => state.agentSnaps.find((a) => a.uid === t.uid)
const agentName = (t: QueueTask) => agentOf(t)?.title || t.agentTitle || 'agente'
const configLabel = (t: QueueTask) => t.config ? [PROVIDER_LABEL[t.config.provider], t.config.model || 'modelo padrão', MODES.find((m) => m.id === t.config?.mode)?.label].filter(Boolean).join(' · ') : ''
const liveAgent = (t: QueueTask) => !!t.uid && state.agentSnaps.some((a) => a.uid === t.uid)
const chosenChoice = reactive<Record<string, string>>({})
const busyChoice = ref<string | null>(null)
async function chooseProject(t: QueueTask, selected: string) {
  if (!selected || busyChoice.value) return
  busyChoice.value = t.id
  spokenTasks.set(t.id, { status: t.status, announced: true })
  try {
    const next = await api.queueChooseProject(t.id, selected)
    const resumed = next.find((item) => item.id === t.id)
    if (resumed) spokenTasks.set(t.id, { status: resumed.status, announced: true })
    speakManagerReply(`Certo, selecionei ${name(selected)} e retomei o pedido.`)
  } catch (e) {
    spokenTasks.delete(t.id)
    toast(String((e as Error).message))
  } finally {
    busyChoice.value = null
  }
}

async function manage(t: QueueTask) {
  try {
    await api.queueManage(t.id, t.cwd ? undefined : cwd.value, t.cwd ? undefined : [...extraDirs.value])
  } catch (e) {
    state.error = String((e as Error).message)
  }
}
async function openTask(t: QueueTask) {
  if (t.uid && liveAgent(t)) return api.agentShow(t.uid).catch(() => undefined)
  if (!t.sessionId) return toast('A conversa dessa tarefa não foi guardada.')
  if (await api.agentFocus(t.sessionId).catch(() => false)) return
  const h = (await api.agentHistory().catch(() => [])).find((x) => x.sessionId === t.sessionId)
  if (!h) return toast('A conversa dessa tarefa não está mais no histórico.')
  await api.agentOpen({ provider: h.provider, model: h.model, effort: h.effort, mode: h.mode, cwd: h.cwd, resumeId: h.sessionId }).catch(() => undefined)
}
const scrollEnd = () => nextTick(() => { if (feed.value) feed.value.scrollTop = feed.value.scrollHeight })
onMounted(scrollEnd)
onMounted(() => api.knownModels().then((models) => (known.value = models)).catch(() => undefined))
onMounted(async () => {
  const generation = historyGeneration
  try {
    const page = await api.queueHistory()
    if (generation !== historyGeneration) return
    archived.value = page.tasks
    archiveCursor.value = page.nextCursor
  } catch (e) { toast(String((e as Error).message)) }
  finally { archiveReady.value = true }
})
watch(() => state.queue.map((t) => [t.id, t.status, t.uid].join(':')).join('|'), scrollEnd)
</script>

<template>
  <section class="manager">
    <header class="manager-head">
      <span class="avatar"><Icon name="bot" :size="19" /></span>
      <span><strong>Gerenciador de agentes</strong><small>{{ scopeLabel }}</small></span>
      <span class="head-spacer" />
      <button v-if="canClear" class="ghost icon" title="Limpar histórico concluído" aria-label="Limpar histórico concluído" @click="clearConversation"><Icon name="trash" :size="14" /></button>
      <button v-if="voicePlatform" class="ghost icon voice-toggle" :class="{ on: conversation }" :title="conversation ? 'Encerrar conversa por voz' : 'Iniciar conversa por voz'" :aria-label="conversation ? 'Encerrar conversa por voz' : 'Iniciar conversa por voz'" :aria-pressed="conversation" @click="toggleConversation"><Icon name="phone" :size="18" /></button>
      <button v-if="voicePlatform && voicePending" class="ghost icon" title="Interromper fala do gerenciador" @click="api.voiceCancel(managerVoiceId)"><Icon name="stop" :size="13" /></button>
      <button v-if="voicePlatform" class="ghost icon" title="Instalar e testar voz local" @click="voiceSetup = true"><Icon name="settings" :size="14" /></button>
    </header>
    <div ref="feed" class="feed">
      <button v-if="hasEarlier" class="ghost older" @click="showEarlier = !showEarlier">{{ showEarlier ? 'Voltar à conversa atual' : 'Ver histórico anterior' }}</button>
      <button v-if="hasOlder" class="ghost older" :disabled="loadingOlder" @click="loadOlder">{{ loadingOlder ? 'Carregando…' : 'Ver mensagens anteriores' }}</button>
      <div v-if="!tasks.length" class="intro">
        <Icon name="bot" :size="28" />
        <strong>{{ conversation ? 'Conversa iniciada' : 'O que precisa ser feito?' }}</strong>
        <p>{{ conversation ? hasEarlier ? 'Pode falar com o gerenciador. O histórico anterior está disponível acima.' : 'Pode falar com o gerenciador.' : 'Consulte os agentes de qualquer projeto ou peça uma tarefa. Para executar, escolha um projeto ou cite o nome dele.' }}</p>
      </div>
      <article v-for="t in tasks" :key="t.id" class="exchange">
        <div class="user-message">
          <p>{{ t.text }}</p>
          <div v-if="t.attachments?.length" class="sent-attachments"><span v-for="a in t.attachments" :key="a.path" :title="a.path"><Icon name="paperclip" :size="11" />{{ a.name }}</span></div>
          <small>{{ where(t) }}<template v-if="t.config"> · {{ configLabel(t) }}</template></small>
        </div>
        <div class="manager-message" :class="t.projectChoices?.length ? 'awaiting' : t.status">
          <span class="message-avatar"><Icon :name="t.projectChoices?.length ? 'bot' : t.status === 'done' ? 'check' : t.status === 'failed' ? 'alert' : 'bot'" :size="13" /></span>
          <div class="message-body">
            <template v-if="t.managed">
              <p v-if="t.managerThinking">Estou analisando o pedido e verificando os agentes…</p>
              <p v-else-if="t.reply" class="manager-reply">{{ t.reply }}</p>
              <p v-else-if="t.status === 'queued' && !t.uid">Estou procurando o agente mais adequado em {{ where(t) }}…</p>
              <p v-else-if="t.status === 'queued'">{{ t.via === 'new' ? 'Criei um novo agente: ' + agentName(t) : 'Encaminhei para ' + agentName(t) }}. O pedido aguarda a vez dele.</p>
              <p v-else-if="t.status === 'running'">{{ t.via === 'new' ? 'Criei um novo agente: ' + agentName(t) + '.' : 'Encaminhei para ' + agentName(t) + '.' }} {{ agentOf(t)?.status === 'waiting' ? 'Ele aguarda sua resposta.' : 'Ele está trabalhando agora.' }}</p>
              <p v-else-if="t.status === 'done'">{{ agentName(t) }} concluiu o pedido.</p>
              <p v-else>{{ t.reason || agentName(t) + ' não conseguiu concluir o pedido.' }}</p>
            </template>
            <template v-else>
              <p v-if="t.status === 'queued'">Pedido da fila anterior{{ t.stage === 'reasoning' ? ' em raciocínio' : '' }}. Você pode encaminhá-lo pelo gerenciador.</p>
              <p v-else-if="t.status === 'running'">Pedido da fila anterior em execução com {{ agentName(t) }}.</p>
              <p v-else-if="t.status === 'done'">Pedido da fila anterior concluído por {{ agentName(t) }}.</p>
              <p v-else>Pedido da fila anterior falhou com {{ agentName(t) }}.</p>
              <details v-if="t.analysis" class="analysis"><summary>Ver raciocínio anterior</summary><pre>{{ t.analysis }}</pre></details>
            </template>
            <div v-if="t.projectChoices?.length" class="project-choices">
              <small class="choice-hint">Escolha para continuar este pedido:</small>
              <template v-if="t.projectChoices.length <= 6">
                <button v-for="(choice, index) in t.projectChoices" :key="choice.cwd" type="button" class="project-option" :disabled="!!busyChoice" :title="choice.cwd" @click="chooseProject(t, choice.cwd)">{{ index + 1 }}. {{ choice.label }}</button>
              </template>
              <template v-else>
                <select v-model="chosenChoice[t.id]" :disabled="!!busyChoice" :aria-label="`Projeto para ${t.text}`">
                  <option value="">Escolha um projeto…</option>
                  <option v-for="(choice, index) in t.projectChoices" :key="choice.cwd" :value="choice.cwd">{{ index + 1 }}. {{ choice.label }}</option>
                </select>
                <button type="button" class="project-option" :disabled="!chosenChoice[t.id] || !!busyChoice" @click="chooseProject(t, chosenChoice[t.id])">Continuar pedido</button>
              </template>
            </div>
            <div class="message-actions">
              <button v-if="!t.managed && t.status === 'queued'" class="ghost link" :disabled="t.analyzing" @click="manage(t)">{{ t.analyzing ? 'Analisando…' : 'Encaminhar com gerenciador' }}</button>
              <button v-if="t.uid && (liveAgent(t) || t.sessionId)" class="ghost link" @click="openTask(t)">Abrir conversa</button>
              <button v-if="t.status === 'failed'" class="ghost link" @click="api.queueRetry(t.id)">Tentar de novo</button>
              <button v-if="t.status === 'done' || t.status === 'failed'" class="ghost link faint" @click="api.queueRemove(t.id)">Remover</button>
            </div>
          </div>
        </div>
      </article>
    </div>
    <div class="manager-composer" :class="{ conversation }">
      <MiniComposer manager :cwd="cwd" :extra-dirs="extraDirs" :manager-session-id="voiceSessionId ?? undefined" :known="known" :dictation-terms="dictationTerms" :auto-send-dictation="conversation" :voice-speaking="voicePending > 0" :voice-phase="voicePhase" :placeholder="conversation ? 'Escreva sua mensagem…' : 'Pergunte ou peça algo ao gerenciador…'" @manager-task="managerTaskSent" @end-conversation="toggleConversation">
        <template #scope><div class="project-scope"><RepoSelect v-model="cwd" v-model:extra="extraDirs" any any-label="Todos os projetos" class="repo" /></div></template>
      </MiniComposer>
    </div>
    <VoiceSetupDialog v-if="voiceSetup" @close="closeVoiceSetup" />
  </section>
</template>

<style scoped>
.manager { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--text); }
.manager-head { display: flex; align-items: center; gap: 10px; padding: 15px 14px; border-bottom: 1px solid var(--border); flex: none; }
.manager-head > span:nth-child(2) { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.manager-head strong { font-size: 13px; }
.manager-head small { color: var(--faint); font-size: 10.5px; }
.head-spacer { flex: 1; }
.voice-toggle { width: 32px; height: 32px; padding: 0; color: var(--muted); }
.voice-toggle.on { color: var(--accent); background: var(--accent-soft); }
.avatar, .message-avatar { display: grid; place-items: center; flex: none; color: var(--accent); background: var(--accent-soft); }
.avatar { width: 34px; height: 34px; border-radius: 11px; }
.feed { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 18px; padding: 16px 12px; }
.older { align-self: center; flex: none; color: var(--muted); font-size: 11px; }
.intro { margin: auto 4px; display: flex; flex-direction: column; align-items: center; gap: 9px; text-align: center; color: var(--muted); }
.intro > svg { color: var(--accent); }
.intro strong { color: var(--text); font-size: 13px; }
.intro p { margin: 0; font-size: 12px; line-height: 1.5; }
.exchange { display: flex; flex-direction: column; gap: 10px; }
.user-message { align-self: flex-end; max-width: 92%; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 12px 12px 3px 12px; background: var(--accent-soft); overflow-wrap: anywhere; }
.user-message p { margin: 0 0 5px; white-space: pre-wrap; font-size: 12.5px; line-height: 1.45; }
.user-message small { color: var(--muted); font-size: 10px; }
.sent-attachments { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
.sent-attachments span { display: inline-flex; align-items: center; gap: 3px; max-width: 100%; padding: 2px 5px; border-radius: 5px; background: var(--panel); font-size: 10px; overflow-wrap: anywhere; }
.manager-message { display: flex; align-items: flex-start; gap: 7px; }
.message-avatar { width: 22px; height: 22px; border-radius: 7px; }
.manager-message.done .message-avatar { color: var(--add); background: color-mix(in srgb, var(--add) 15%, transparent); }
.manager-message.failed .message-avatar { color: var(--del); background: color-mix(in srgb, var(--del) 15%, transparent); }
.manager-message.awaiting .message-avatar { color: var(--mod); background: color-mix(in srgb, var(--mod) 15%, transparent); }
.message-body { min-width: 0; flex: 1; padding-top: 2px; }
.message-body p { margin: 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.message-body .manager-reply { white-space: pre-line; }
.project-choices { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.choice-hint { width: 100%; color: var(--muted); font-size: 10px; }
.project-option, .project-choices select { min-height: 27px; max-width: 100%; padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: 7px; background: var(--accent-soft); color: var(--text); font-size: 11px; overflow-wrap: anywhere; }
.project-option { cursor: pointer; }
.project-option:hover:not(:disabled) { border-color: var(--accent); }
.project-option:disabled { opacity: .5; cursor: default; }
.project-choices select { min-width: 0; max-width: 100%; background: var(--panel); }
.message-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
.message-actions:empty { display: none; }
.link { min-height: 22px; padding: 0; color: var(--accent); font-size: 11px; }
.link.faint { color: var(--faint); }
.analysis { margin-top: 6px; font-size: 11px; color: var(--muted); }
.analysis pre { max-height: 170px; overflow: auto; white-space: pre-wrap; font: inherit; line-height: 1.4; }
.manager-composer { flex: none; margin: 0 12px 12px; }
.manager-composer.conversation { margin: 0; }
.manager-composer.conversation :deep(.mini) { border-radius: 22px 22px 0 0; border-left: 0; border-right: 0; border-bottom: 0; }
.project-scope { display: flex; align-items: center; gap: 8px; padding: 0 4px; }
.repo { max-width: 230px; }
.repo :deep(.sel) { height: 28px; font-size: 11px; background: var(--panel); }
</style>
