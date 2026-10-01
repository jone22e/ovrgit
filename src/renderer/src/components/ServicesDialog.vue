<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Service, ServiceState } from '@shared/types'
import { api, saveSettings, state, toast } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

/**
 * Serviços em segundo plano: comandos que ficam rodando (encaminhamento de porta da AWS, `npm run dev` numa
 * pasta…), com nome, play/stop e um terminal em janela própria, aberto só quando pedido.
 */
const emit = defineEmits<{ close: [] }>()
const services = computed(() => state.settings?.services ?? [])
const states = ref<ServiceState[]>([])
const stateOf = (id: string) => states.value.find((s) => s.id === id)
const busy = ref<string | null>(null)

// formulário (novo ou edição)
const editing = ref<Service | null>(null)
const name = ref('')
const command = ref('')
const cwd = ref('')
const nameEl = ref<HTMLInputElement>()
const canSave = computed(() => !!name.value.trim() && !!command.value.trim())
const plain = (list: Service[]): Service[] => JSON.parse(JSON.stringify(list))

function openNew() {
  editing.value = { id: '', name: '', command: '', cwd: state.repo?.root ?? '' }
  name.value = ''
  command.value = ''
  cwd.value = state.repo?.root ?? ''
  setTimeout(() => nameEl.value?.focus(), 50)
}
function openEdit(s: Service) {
  editing.value = s
  name.value = s.name
  command.value = s.command
  cwd.value = s.cwd
  setTimeout(() => nameEl.value?.focus(), 50)
}
async function pickFolder() {
  const p = await api.pickFolder(cwd.value || state.repo?.root || '')
  if (p) cwd.value = p
}
async function save() {
  if (!editing.value || !canSave.value) return
  const item: Service = { id: editing.value.id || crypto.randomUUID(), name: name.value.trim(), command: command.value.trim(), cwd: cwd.value.trim() }
  const list = services.value.some((s) => s.id === item.id) ? services.value.map((s) => (s.id === item.id ? item : s)) : [...services.value, item]
  // cópia simples: os itens vindos do estado são proxies reativos, que a IPC não consegue clonar
  await saveSettings({ services: plain(list) })
  editing.value = null
  await load()
}
async function remove(s: Service) {
  if (stateOf(s.id)?.status === 'running') await api.serviceStop(s.id)
  await saveSettings({ services: plain(services.value.filter((x) => x.id !== s.id)) })
  await load()
}

async function start(s: Service) {
  busy.value = s.id
  try {
    await api.serviceStart(s.id)
  } catch (e) {
    toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  } finally {
    busy.value = null
  }
}
async function stop(s: Service) {
  busy.value = s.id
  try {
    await api.serviceStop(s.id)
  } finally {
    busy.value = null
  }
}
const openTerminal = (s: Service) => api.serviceOpenWindow(s.id)

const since = (ms?: number) => {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h`
}
const firstLine = (cmd: string) => cmd.split('\n')[0].replace(/\\\s*$/, '').trim()

async function load() {
  states.value = await api.servicesStates().catch(() => [])
}
const offs: (() => void)[] = []
onMounted(() => {
  load()
  offs.push(api.onServicesChanged((s) => (states.value = s)))
  if (!services.value.length) openNew()
})
onUnmounted(() => offs.forEach((f) => f()))
</script>

<template>
  <Modal title="Serviços" :width="720" @close="emit('close')">
    <p class="faint intro">Comandos que ficam rodando em segundo plano enquanto o Ovseer está aberto: um túnel para o banco, um servidor de desenvolvimento, um watcher. Fechar o app para todos.</p>

    <div v-if="editing" class="form">
      <h6>{{ editing.id ? 'Editar serviço' : 'Novo serviço' }}</h6>
      <div class="field">
        <label for="svc-name">Nome</label>
        <input id="svc-name" ref="nameEl" v-model="name" type="text" placeholder="ex.: Postgres de produção (túnel)" maxlength="80" />
      </div>
      <div class="field">
        <label for="svc-cmd">Comando</label>
        <textarea id="svc-cmd" v-model="command" class="mono" rows="4" spellcheck="false" placeholder="ex.: npm run dev&#10;ou&#10;aws ssm start-session --target i-… --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '…'" />
        <p class="faint hint">Roda no seu shell de login (com o PATH do nvm, brew etc.). Pode ter várias linhas.</p>
      </div>
      <div class="field">
        <label for="svc-cwd">Pasta</label>
        <div class="row">
          <input id="svc-cwd" v-model="cwd" type="text" class="mono" placeholder="vazio: sua pasta de usuário" spellcheck="false" />
          <button type="button" @click="pickFolder">Escolher…</button>
        </div>
      </div>
      <div class="form-acts">
        <button type="button" class="ghost" @click="editing = null">Cancelar</button>
        <button type="button" class="primary" :disabled="!canSave" @click="save">{{ editing.id ? 'Salvar' : 'Adicionar' }}</button>
      </div>
    </div>

    <div v-if="services.length" class="list">
      <div v-for="s in services" :key="s.id" class="item" :class="stateOf(s.id)?.status">
        <span class="dot" :class="stateOf(s.id)?.status" />
        <div class="text">
          <div class="line">
            <strong class="ellipsis">{{ s.name }}</strong>
            <small v-if="stateOf(s.id)?.status === 'running'" class="ok">rodando há {{ since(stateOf(s.id)?.startedAt) }}</small>
            <small v-else-if="stateOf(s.id)?.status === 'exited'" :class="stateOf(s.id)?.exitCode ? 'bad' : 'faint'">
              {{ stateOf(s.id)?.exitCode ? `saiu com código ${stateOf(s.id)?.exitCode}` : 'encerrado' }}
            </small>
            <small v-else class="faint">parado</small>
          </div>
          <small class="mono faint ellipsis" :title="s.command">{{ stateOf(s.id)?.lastLine || firstLine(s.command) }}</small>
        </div>
        <!-- portas detectadas: em destaque; as de HTTP abrem no navegador -->
        <span v-if="stateOf(s.id)?.ports?.length" class="ports">
          <button v-for="p in stateOf(s.id)!.ports" :key="p" type="button" class="port" :title="`Porta ${p} em escuta · abrir http://localhost:${p}`" @click="api.openExternal(`http://localhost:${p}`)">
            :{{ p }}
          </button>
        </span>
        <span class="acts">
          <button v-if="stateOf(s.id)?.status === 'running'" type="button" class="ghost icon" title="Parar" :disabled="busy === s.id" @click="stop(s)"><Icon name="stop" :size="14" /></button>
          <button v-else type="button" class="ghost icon play" title="Iniciar" :disabled="busy === s.id" @click="start(s)"><Icon name="play" :size="14" /></button>
          <button type="button" class="ghost icon" title="Ver o terminal do serviço em outra janela" @click="openTerminal(s)"><Icon name="terminal" :size="14" /></button>
          <button type="button" class="ghost icon" title="Editar" @click="openEdit(s)"><Icon name="pencil" :size="13" /></button>
          <button type="button" class="ghost icon" title="Remover" @click="remove(s)"><Icon name="trash" :size="13" /></button>
        </span>
      </div>
    </div>
    <p v-else-if="!editing" class="faint none">Nenhum serviço ainda.</p>

    <template #footer>
      <button v-if="!editing" type="button" @click="openNew"><Icon name="plus" :size="13" /> Adicionar serviço</button>
      <span class="spacer" />
      <button type="button" class="ghost" @click="emit('close')">Fechar</button>
    </template>
  </Modal>
</template>

<style scoped>
.intro { margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; }
.form { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; margin-bottom: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); }
.form h6 { margin: 0 0 2px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.field { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: 12px; color: var(--muted); }
.field textarea { resize: vertical; min-height: 72px; font-size: 12.5px; }
.hint { margin: 0; font-size: 11.5px; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; min-width: 0; }
.form-acts { display: flex; justify-content: flex-end; gap: 8px; }
.list { display: flex; flex-direction: column; gap: 2px; }
.item { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 10px; }
.item:hover { background: var(--hover); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); opacity: 0.5; }
.dot.running { background: var(--add); opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--add) 25%, transparent); }
.dot.exited { background: var(--mod); opacity: 1; }
.text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.line strong { font-size: 13.5px; }
.text small { font-size: 12px; }
.ok { color: var(--add); }
.bad { color: var(--del); }
.ports { display: inline-flex; gap: 4px; flex: none; }
.port {
  height: 24px; padding: 0 9px; border-radius: 999px; font-family: var(--mono); font-size: 12px; font-weight: 700;
  color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); border: 1px solid color-mix(in srgb, var(--add) 40%, transparent);
}
.port:hover { background: color-mix(in srgb, var(--add) 24%, transparent); }
.acts { display: inline-flex; gap: 2px; flex: none; }
.acts .icon { width: 28px; height: 28px; color: var(--muted); }
.acts .icon:hover { color: var(--text); }
.acts .play { color: var(--add); }
.none { margin: 20px 0; text-align: center; font-size: 12.5px; }
.spacer { flex: 1; }
</style>
