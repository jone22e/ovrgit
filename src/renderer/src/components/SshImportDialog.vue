<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SshImportCandidate } from '@shared/types'
import { api, saveSettings, state, toast } from '../store'
import Modal from './Modal.vue'

/** Importar conexões SSH (do ~/.ssh/config ou de CSV/TSV), escolhendo o que entra. */
const emit = defineEmits<{ close: [] }>()
const source = ref<'config' | 'csv'>('config')
const items = ref<SshImportCandidate[]>([])
const picked = ref(new Set<number>())
const csv = ref('')
const group = ref('')
const loading = ref(false)

const existing = computed(() => new Set((state.settings?.sshConnections ?? []).map((c) => `${c.user}@${c.host}:${c.port}`)))
const isDup = (c: SshImportCandidate) => existing.value.has(`${c.user}@${c.host}:${c.port}`)
const groups = computed(() => [...new Set((state.settings?.sshConnections ?? []).map((c) => c.group).filter(Boolean))] as string[])

function setItems(list: SshImportCandidate[]) {
  items.value = list
  picked.value = new Set(list.map((c, i) => (isDup(c) ? -1 : i)).filter((i) => i >= 0))
}

async function loadConfig() {
  source.value = 'config'
  loading.value = true
  setItems(await api.sshImportConfig())
  loading.value = false
}
async function parseCsv() {
  setItems(await api.sshImportCsv(csv.value))
}
async function pickFile() {
  const text = await api.pickTextFile()
  if (text) {
    csv.value = text
    await parseCsv()
  }
}
function toggle(i: number) {
  const s = new Set(picked.value)
  if (s.has(i)) s.delete(i)
  else s.add(i)
  picked.value = s
}

async function importSelected() {
  const chosen = items.value.filter((_, i) => picked.value.has(i))
  const now = state.settings?.sshConnections ?? []
  const added = chosen.map((c) => ({
    id: crypto.randomUUID(),
    name: c.name,
    host: c.host,
    user: c.user,
    port: c.port,
    identityFile: c.identityFile,
    remoteDir: null,
    group: group.value.trim() || c.group || null
  }))
  await saveSettings({ sshConnections: [...now.map((c) => ({ ...c })), ...added] })
  toast(`${added.length} conexão(ões) importada(s).`)
  emit('close')
}

onMounted(loadConfig)
</script>

<template>
  <Modal title="Importar conexões SSH" :width="600" @close="emit('close')">
    <div class="tabs">
      <button :class="{ on: source === 'config' }" @click="loadConfig">Do ~/.ssh/config</button>
      <button :class="{ on: source === 'csv' }" @click="(source = 'csv'), setItems([])">De planilha (CSV)</button>
    </div>

    <template v-if="source === 'csv'">
      <p class="muted hint">
        Cole ou escolha um arquivo CSV/TSV com cabeçalho. Colunas reconhecidas: nome, host (ou Hostname/IP), usuário, porta,
        grupo. O formato de importação do Termius também funciona.
      </p>
      <textarea v-model="csv" rows="4" class="mono" placeholder="nome,host,usuario,porta&#10;Produção,10.20.4.200,ubuntu,22" @input="parseCsv" />
      <button class="small" @click="pickFile">Escolher arquivo…</button>
    </template>

    <p v-if="loading" class="faint"><span class="spinner" /> Lendo…</p>
    <p v-else-if="!items.length" class="faint empty">
      {{ source === 'config' ? 'Nenhuma conexão encontrada no ~/.ssh/config.' : 'Nada para importar ainda.' }}
    </p>
    <ul v-else class="list">
      <li v-for="(c, i) in items" :key="i" :class="{ dup: isDup(c) }" @click="toggle(i)">
        <input type="checkbox" :checked="picked.has(i)" @click.stop @change="toggle(i)" />
        <span class="txt">
          <strong class="ellipsis">{{ c.name }}</strong>
          <small class="mono faint ellipsis">{{ c.user ? `${c.user}@` : '' }}{{ c.host }}{{ c.port !== 22 ? `:${c.port}` : '' }}<template v-if="c.group"> · {{ c.group }}</template></small>
        </span>
        <span v-if="isDup(c)" class="tag">já existe</span>
      </li>
    </ul>

    <label v-if="items.length" class="field">
      <span>Colocar no grupo (opcional)</span>
      <input v-model="group" type="text" list="ssh-groups-imp" placeholder="ex.: Clientes" />
      <datalist id="ssh-groups-imp"><option v-for="g in groups" :key="g" :value="g" /></datalist>
    </label>

    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" :disabled="!picked.size" @click="importSelected">Importar {{ picked.size }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.tabs { display: flex; gap: 2px; padding: 2px; background: var(--panel-2); border-radius: 9px; align-self: flex-start; }
.tabs button { height: 28px; border: 0; background: transparent; font-size: 12.5px; color: var(--muted); }
.tabs button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.hint { margin: 0; font-size: 12px; }
textarea { font-size: 12px; }
.empty { margin: 4px 0; font-size: 12.5px; }
.list { list-style: none; margin: 0; padding: 4px; max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.list li { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
.list li:hover { background: var(--hover); }
.list li.dup { opacity: 0.6; }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.txt strong { font-size: 12.5px; }
.txt small { font-size: 11px; }
.tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
.field { display: flex; flex-direction: column; gap: 5px; }
.field span { font-size: 12px; color: var(--muted); }
</style>
