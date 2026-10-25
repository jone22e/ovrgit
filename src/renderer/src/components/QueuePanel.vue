<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { KnownModels, QueueTask } from '@shared/types'
import { groupOf } from '@shared/repoGroups'
import { MODES, PROVIDER_LABEL } from '@shared/models'
import { api, saveSettings, state, toast } from '../store'
import Icon from './Icon.vue'
import MiniComposer from './MiniComposer.vue'
import RepoSelect from './RepoSelect.vue'
import VoiceSetupDialog from './VoiceSetupDialog.vue'

const cwd = ref(state.repo?.root ?? '')
const extraDirs = ref<string[]>([])
const known = ref<KnownModels | null>(null)
const feed = ref<HTMLElement>()
const tasks = computed(() => state.queue)
const voiceSetup = ref(false)
let enableVoiceAfterSetup = false
const voicePlatform = api.platform === 'darwin' || api.platform === 'linux'
const conversation = computed(() => voicePlatform && !!state.settings?.managerConversationVoice)
async function toggleConversation() {
  if (conversation.value) {
    await saveSettings({ managerConversationVoice: false })
    return
  }
  try {
    if (!(await api.voiceStatus()).ready) {
      enableVoiceAfterSetup = true
      voiceSetup.value = true
      return
    }
    await saveSettings({ managerConversationVoice: true })
  } catch (e) { toast(String((e as Error).message)) }
}
async function closeVoiceSetup() {
  voiceSetup.value = false
  if (enableVoiceAfterSetup && (await api.voiceStatus().catch(() => null))?.ready) await saveSettings({ managerConversationVoice: true })
  enableVoiceAfterSetup = false
}
const name = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const where = (t: QueueTask) => t.cwd ? (groupOf(state.settings?.repoGroups ?? [], t.cwd, t.extraDirs)?.name ?? name(t.cwd)) : 'Sem projeto'
const agentOf = (t: QueueTask) => state.agentSnaps.find((a) => a.uid === t.uid)
const agentName = (t: QueueTask) => agentOf(t)?.title || t.agentTitle || 'agente'
const configLabel = (t: QueueTask) => t.config ? [PROVIDER_LABEL[t.config.provider], t.config.model || 'modelo padrão', MODES.find((m) => m.id === t.config?.mode)?.label].filter(Boolean).join(' · ') : ''
const liveAgent = (t: QueueTask) => !!t.uid && state.agentSnaps.some((a) => a.uid === t.uid)

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
watch(() => tasks.value.map((t) => [t.id, t.status, t.uid].join(':')).join('|'), scrollEnd)
watch(() => state.repo?.root, (next, previous) => {
  if (!cwd.value || cwd.value === previous) {
    cwd.value = next ?? ''
    extraDirs.value = []
  }
})
</script>

<template>
  <section class="manager">
    <header class="manager-head">
      <span class="avatar"><Icon name="bot" :size="19" /></span>
      <span><strong>Gerenciador de agentes</strong><small>Encaminha cada pedido no projeto certo</small></span>
      <span class="head-spacer" />
      <button v-if="voicePlatform" class="ghost voice-toggle" :class="{ on: conversation }" :title="conversation ? 'Desativar conversa por voz' : 'Ativar conversa por voz'" @click="toggleConversation"><Icon name="volume" :size="14" /> {{ conversation ? 'Voz ligada' : 'Conversa por voz' }}</button>
      <button v-if="voicePlatform" class="ghost icon" title="Instalar e testar voz local" @click="voiceSetup = true"><Icon name="settings" :size="14" /></button>
    </header>
    <div ref="feed" class="feed">
      <div v-if="!tasks.length" class="intro">
        <Icon name="bot" :size="28" />
        <strong>O que precisa ser feito?</strong>
        <p>Vou encontrar uma conversa relacionada neste projeto ou criar um agente para o pedido.</p>
      </div>
      <article v-for="t in tasks" :key="t.id" class="exchange">
        <div class="user-message">
          <p>{{ t.text }}</p>
          <div v-if="t.attachments?.length" class="sent-attachments"><span v-for="a in t.attachments" :key="a.path" :title="a.path"><Icon name="paperclip" :size="11" />{{ a.name }}</span></div>
          <small>{{ where(t) }}<template v-if="t.config"> · {{ configLabel(t) }}</template></small>
        </div>
        <div class="manager-message" :class="t.status">
          <span class="message-avatar"><Icon :name="t.status === 'done' ? 'check' : t.status === 'failed' ? 'alert' : 'bot'" :size="13" /></span>
          <div class="message-body">
            <template v-if="t.managed">
              <p v-if="t.status === 'queued' && !t.uid">Estou procurando o agente mais adequado em {{ where(t) }}…</p>
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
    <div class="manager-composer">
      <MiniComposer manager :cwd="cwd" :extra-dirs="extraDirs" :known="known" :auto-send-dictation="conversation" :placeholder="conversation ? 'Dite ou escreva para o gerenciador…' : 'Peça algo ao gerenciador…'">
        <template #scope><div class="project-scope"><RepoSelect v-model="cwd" v-model:extra="extraDirs" class="repo" /></div></template>
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
.voice-toggle { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; padding: 5px 7px; color: var(--muted); font-size: 10.5px; }
.voice-toggle.on { color: var(--accent); background: var(--accent-soft); }
.avatar, .message-avatar { display: grid; place-items: center; flex: none; color: var(--accent); background: var(--accent-soft); }
.avatar { width: 34px; height: 34px; border-radius: 11px; }
.feed { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 18px; padding: 16px 12px; }
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
.message-body { min-width: 0; flex: 1; padding-top: 2px; }
.message-body p { margin: 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.message-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
.message-actions:empty { display: none; }
.link { min-height: 22px; padding: 0; color: var(--accent); font-size: 11px; }
.link.faint { color: var(--faint); }
.analysis { margin-top: 6px; font-size: 11px; color: var(--muted); }
.analysis pre { max-height: 170px; overflow: auto; white-space: pre-wrap; font: inherit; line-height: 1.4; }
.manager-composer { flex: none; margin: 0 12px 12px; }
.project-scope { display: flex; align-items: center; gap: 8px; padding: 0 4px; }
.repo { max-width: 230px; }
.repo :deep(.sel) { height: 28px; font-size: 11px; background: var(--panel); }
</style>
