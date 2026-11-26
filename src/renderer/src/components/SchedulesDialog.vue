<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { timingLabel, WEEKDAYS, type ScheduleInput, type ScheduledTask, type ScheduleTiming, type ScheduleRun } from '@shared/schedules'
import type { KnownModels } from '@shared/types'
import { readAgentPrefs } from '../agentPrefs'
import { api, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import ModelPicker from './ModelPicker.vue'

const emit = defineEmits<{ close: [] }>()
const tasks = ref<ScheduledTask[]>([])
const error = ref('')
const busy = ref(false)
const loading = ref(true)
const editing = ref<string | null>(null)
const showForm = ref(false)
const expanded = ref<string | null>(null)
const deleting = ref<string | null>(null)
const known = ref<KnownModels | null>(null)
const prefs = readAgentPrefs()
const defaults = Object.fromEntries(Object.keys(prefs.model).map((p) => [p, { model: prefs.model[p as keyof typeof prefs.model], effort: prefs.effort[p as keyof typeof prefs.effort] }]))
const form = reactive<ScheduleInput>({
  name: '', prompt: '', cwd: state.repo?.root ?? '', provider: prefs.provider, model: prefs.model[prefs.provider],
  effort: prefs.effort[prefs.provider], mode: 'full', enabled: true, timing: { kind: 'interval', minutes: 60 }
})
const kind = ref<ScheduleTiming['kind']>('daily')
const minutes = ref(60)
const time = ref('08:00')
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone)
const days = ref([1, 2, 3, 4, 5])
const date = (at: number) => new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const running = (task: ScheduledTask) => task.runs.some((r) => r.status === 'running')
const statusLabel: Record<ScheduleRun['status'], string> = { running: 'Em execução', done: 'Concluída', error: 'Falhou', interrupted: 'Interrompida' }
const cleanError = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
async function load() {
  try { tasks.value = await api.schedulesList() }
  catch (e) { error.value = cleanError(e) }
  finally { loading.value = false }
}
async function action(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await fn(); await load() }
  catch (e) { error.value = cleanError(e) }
  finally { busy.value = false }
}
function edit(task?: ScheduledTask) {
  editing.value = task?.id ?? null
  deleting.value = null
  if (task) {
    Object.assign(form, JSON.parse(JSON.stringify(task)))
    kind.value = task.timing.kind
    if (task.timing.kind === 'interval') minutes.value = task.timing.minutes
    else {
      time.value = task.timing.time
      timezone.value = task.timing.timezone
      if (task.timing.kind === 'weekly') days.value = [...task.timing.days]
    }
  } else {
    Object.assign(form, { name: '', prompt: '', cwd: state.repo?.root ?? '', provider: prefs.provider,
      model: prefs.model[prefs.provider], effort: prefs.effort[prefs.provider], mode: 'full', enabled: true })
    kind.value = 'daily'; minutes.value = 60; time.value = '08:00'
    timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone
    days.value = [1, 2, 3, 4, 5]
  }
  showForm.value = true
  error.value = ''
}
function save() {
  const timing: ScheduleTiming = kind.value === 'interval' ? { kind: 'interval', minutes: Number(minutes.value) }
    : kind.value === 'daily' ? { kind: 'daily', time: time.value, timezone: timezone.value.trim() }
      : { kind: 'weekly', time: time.value, timezone: timezone.value.trim(), days: [...days.value] }
  void action(async () => {
    await api.scheduleSave({ name: form.name, prompt: form.prompt, cwd: form.cwd, provider: form.provider,
      model: form.model, effort: form.effort, mode: form.mode, enabled: form.enabled, timing }, editing.value ?? undefined)
    showForm.value = false
  })
}
async function pickFolder() {
  await action(async () => { const folder = await api.pickFolder(form.cwd); if (folder) form.cwd = folder })
}
let off: (() => void) | undefined
onMounted(() => {
  off = api.onSchedulesChanged(() => { void load() })
  void load()
  void api.knownModels().then((models) => { known.value = models }).catch(() => undefined)
})
onUnmounted(() => off?.())
</script>

<template>
  <Modal title="Agendamentos" :width="800" @close="emit('close')">
    <p class="muted intro">Tarefas periódicas executadas por agentes em conversas separadas. O Ovseer precisa estar aberto e o computador acordado.</p>
    <p class="muted intro">Ao retornar, executa uma vez o horário atrasado. Pausar impede as próximas execuções; a conversa atual continua.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <form v-if="showForm" class="editor" @submit.prevent="save">
      <strong>{{ editing ? 'Editar agendamento' : 'Novo agendamento' }}</strong>
      <label>Nome<input v-model="form.name" required maxlength="100" placeholder="Resumo diário dos erros" :disabled="busy" /></label>
      <label>Instrução<textarea v-model="form.prompt" required maxlength="50000" rows="4" placeholder="Descreva exatamente o que o agente deve fazer em cada execução." :disabled="busy" /></label>
      <label>Projeto<div class="row"><input v-model="form.cwd" required placeholder="Caminho absoluto do projeto" :disabled="busy" /><button type="button" class="ghost" :disabled="busy" @click="pickFolder">Escolher pasta</button></div></label>
      <ModelPicker v-model:provider="form.provider" v-model:model="form.model" v-model:effort="form.effort" inline providers no-fast :known="known" :defaults="defaults" :disabled="busy" />
      <div class="row fields">
        <label>Modo<select v-model="form.mode" :disabled="busy"><option value="full">Controle Total</option><option value="plan">Plano (análise)</option></select></label>
        <label>Repetição<select v-model="kind" :disabled="busy"><option value="interval">Intervalo</option><option value="daily">Diariamente</option><option value="weekly">Dias da semana</option></select></label>
        <label v-if="kind === 'interval'">Intervalo em minutos<input v-model.number="minutes" type="number" min="1" max="525600" required :disabled="busy" /></label>
        <label v-else>Horário<input v-model="time" type="time" required :disabled="busy" /></label>
      </div>
      <label v-if="kind !== 'interval'">Fuso horário<input v-model="timezone" required placeholder="America/Sao_Paulo" :disabled="busy" /></label>
      <fieldset v-if="kind === 'weekly'" :disabled="busy"><legend>Dias da semana</legend><label v-for="(day, index) in WEEKDAYS" :key="index" class="check"><input v-model="days" type="checkbox" :value="index" />{{ day }}</label></fieldset>
      <label class="check"><input v-model="form.enabled" type="checkbox" :disabled="busy" />Agendamento ativo</label>
      <div class="row end"><button type="button" class="ghost" :disabled="busy" @click="showForm = false">Cancelar</button><button class="primary" :disabled="busy">{{ busy ? 'Salvando…' : 'Salvar agendamento' }}</button></div>
    </form>
    <template v-else>
      <div class="row end"><button class="primary" :disabled="busy || loading" @click="edit()"><Icon name="plus" :size="14" /> Novo agendamento</button></div>
      <p v-if="loading" class="muted">Carregando agendamentos…</p>
      <p v-else-if="!tasks.length" class="muted empty">Nenhum agendamento. Crie aqui ou peça a um agente para agendar uma tarefa.</p>
      <article v-for="task in tasks" :key="task.id" class="task">
        <div class="row"><strong>{{ task.name }}</strong><span class="badge" :class="{ live: running(task) }">{{ running(task) ? 'Em execução' : task.enabled ? 'Ativo' : 'Pausado' }}</span></div>
        <small class="muted">{{ timingLabel(task.timing) }} · {{ task.mode === 'plan' ? 'Plano' : 'Controle Total' }}</small>
        <small class="muted path">{{ task.cwd }}</small>
        <p class="instruction">{{ task.prompt }}</p>
        <small v-if="task.enabled" class="muted">Próxima: {{ date(task.nextRunAt) }} (horário deste computador)</small>
        <small v-if="task.runs[0]" class="muted">Última: {{ date(task.runs[0].startedAt) }} · {{ statusLabel[task.runs[0].status] }}</small>
        <div class="row actions">
          <button class="ghost small" :disabled="busy" @click="action(() => api.scheduleEnable(task.id, !task.enabled))">{{ task.enabled ? 'Pausar' : 'Retomar' }}</button>
          <button class="ghost small" :disabled="busy || running(task)" @click="action(() => api.scheduleRun(task.id))">Executar agora</button>
          <button class="ghost small" :disabled="busy" @click="edit(task)">Editar</button>
          <button class="ghost small" :disabled="!task.runs.length" @click="expanded = expanded === task.id ? null : task.id">Histórico ({{ task.runs.length }})</button>
          <button class="ghost small" :disabled="busy || running(task)" @click="deleting = task.id">Excluir</button>
        </div>
        <div v-if="deleting === task.id" class="row"><span>Excluir este agendamento e seu histórico?</span><button class="danger small" :disabled="busy" @click="action(async () => { await api.scheduleRemove(task.id); deleting = null })">Excluir</button><button class="ghost small" :disabled="busy" @click="deleting = null">Cancelar</button></div>
        <div v-if="expanded === task.id" class="history">
          <small class="muted">Últimas 50 execuções. As conversas também aparecem no histórico de agentes.</small>
          <details v-for="run in task.runs" :key="run.id">
            <summary>{{ date(run.startedAt) }} · {{ statusLabel[run.status] }}</summary>
            <p v-if="run.finishedAt" class="muted">Finalizada em {{ date(run.finishedAt) }}</p>
            <p v-if="run.error" class="error">{{ run.error }}</p>
            <pre v-if="run.result">{{ run.result }}</pre>
            <button v-if="run.uid || run.sessionId" class="ghost small" :disabled="busy" @click="action(async () => { await api.scheduleOpen(task.id, run.id); emit('close') })">Abrir conversa</button>
          </details>
        </div>
      </article>
    </template>
    <template #footer><button class="ghost" @click="emit('close')">Fechar</button></template>
  </Modal>
</template>

<style scoped>
.intro { margin: 0; font-size: 12px; line-height: 1.5; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.end { justify-content: flex-end; }
.editor, .task { border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.editor { background: var(--panel-2); }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
input, textarea, select { width: 100%; box-sizing: border-box; }
.row input { flex: 1; min-width: 180px; }
textarea { resize: vertical; }
.fields > label { flex: 1; min-width: 140px; }
.check { display: inline-flex; flex-direction: row; align-items: center; margin-right: 10px; }
.check input { width: auto; min-width: 0; }
fieldset { border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
legend { font-size: 12px; }
.badge { margin-left: auto; border-radius: 20px; background: var(--panel-2); padding: 3px 8px; font-size: 11px; }
.live { color: var(--accent); }
.path, .instruction { overflow-wrap: anywhere; }
.instruction { margin: 0; white-space: pre-wrap; max-height: 100px; overflow: auto; font-size: 12px; }
.empty { padding: 25px 0; text-align: center; }
.actions { padding-top: 4px; }
.history { display: flex; flex-direction: column; gap: 8px; }
details { border-top: 1px solid var(--border); padding-top: 8px; font-size: 12px; }
summary { cursor: pointer; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 280px; overflow: auto; }
</style>
