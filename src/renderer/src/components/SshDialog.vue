<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { SshConnection } from '@shared/types'
import { api, ask, deleteSshConnection, openTerminalTab, saveSshConnection, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const editing = state.sshEdit !== 'new' ? (state.sshEdit as SshConnection) : null

const name = ref(editing?.name ?? '')
const host = ref(editing?.host ?? '')
const user = ref(editing?.user ?? '')
const port = ref(editing?.port ?? 22)
const identityFile = ref(editing?.identityFile ?? '')
const remoteDir = ref(editing?.remoteDir ?? '')
const group = ref(editing?.group ?? '')
const knownGroups = computed(() => [...new Set((state.settings?.sshConnections ?? []).map((c) => c.group).filter(Boolean))] as string[])
const first = ref<HTMLInputElement>()

const hostOk = computed(() => /^[A-Za-z0-9._:[\]-]+$/.test(host.value.trim()) && !host.value.trim().startsWith('-'))
const userOk = computed(() => !user.value.trim() || (/^[A-Za-z0-9._@-]+$/.test(user.value.trim()) && !user.value.trim().startsWith('-')))
const portOk = computed(() => Number(port.value) >= 1 && Number(port.value) <= 65535)
const valid = computed(() => hostOk.value && userOk.value && portOk.value)
const preview = computed(() => {
  const target = `${user.value.trim() ? `${user.value.trim()}@` : ''}${host.value.trim() || 'host'}`
  const p = Number(port.value) !== 22 ? ` -p ${port.value}` : ''
  const k = identityFile.value ? ` -i ${identityFile.value.split(/[\\/]/).pop()}` : ''
  return `ssh${p}${k} ${target}`
})

// ---- chave privada: as já usadas em outras conexões, as de ~/.ssh, ou outro arquivo ----
const PICK = '__pick__'
const foundKeys = ref<string[]>([])
const others = computed(() => (state.settings?.sshConnections ?? []).filter((c) => c.id !== editing?.id))
/** chave → nomes das conexões que já a usam */
const usedKeys = computed(() => {
  const map = new Map<string, string[]>()
  for (const c of others.value) {
    if (!c.identityFile) continue
    map.set(c.identityFile, [...(map.get(c.identityFile) ?? []), c.name])
  }
  return [...map.entries()].map(([path, names]) => ({ path, names }))
})
const newKeys = computed(() => foundKeys.value.filter((k) => !usedKeys.value.some((u) => u.path === k)))
const customKey = computed(() =>
  identityFile.value && !usedKeys.value.some((u) => u.path === identityFile.value) && !foundKeys.value.includes(identityFile.value)
    ? identityFile.value
    : null
)
const keyName = (p: string) => p.split(/[\\/]/).pop() ?? p
const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~')
/** usuários já usados (sugestões no campo Usuário) */
const knownUsers = computed(() => [...new Set(others.value.map((c) => c.user).filter(Boolean))])

async function onKeyChange(e: Event) {
  const select = e.target as HTMLSelectElement
  if (select.value !== PICK) {
    identityFile.value = select.value
    return
  }
  select.value = identityFile.value // volta para a escolha atual enquanto o seletor está aberto
  const p = await api.pickSshKey()
  if (p) identityFile.value = p
}

onMounted(async () => {
  // conexão nova: já sugere a chave mais usada
  if (!editing && usedKeys.value.length) {
    identityFile.value = [...usedKeys.value].sort((a, b) => b.names.length - a.names.length)[0].path
  }
  foundKeys.value = await api.listSshKeys().catch(() => [])
  await nextTick()
  first.value?.focus()
})

function build(): SshConnection {
  return {
    id: editing?.id ?? crypto.randomUUID(),
    name: name.value.trim() || host.value.trim(),
    host: host.value.trim(),
    user: user.value.trim(),
    port: Number(port.value) || 22,
    identityFile: identityFile.value.trim() || null,
    remoteDir: remoteDir.value.trim() || null,
    group: group.value.trim() || null
  }
}

async function save(connect: boolean) {
  if (!valid.value) return
  const conn = build()
  await saveSshConnection(conn)
  emit('close')
  if (connect) openTerminalTab({ kind: 'ssh', connectionId: conn.id })
}

async function remove() {
  if (!editing) return
  const ok = await ask({
    title: 'Remover conexão?',
    message: `A conexão "${editing.name}" sai da lista. Nada muda no servidor nem nas suas chaves.`,
    confirmLabel: 'Remover',
    danger: true
  })
  if (!ok) return
  await deleteSshConnection(editing.id)
  emit('close')
}
</script>

<template>
  <Modal :title="editing ? 'Editar conexão SSH' : 'Nova conexão SSH'" :width="480" @close="emit('close')">
    <form class="form" @submit.prevent="save(true)">
      <div class="row">
        <label class="field grow">
          <span>Nome</span>
          <input ref="first" v-model="name" type="text" placeholder="Produção Ovseer" />
        </label>
        <label class="field group">
          <span>Grupo <em>opcional</em></span>
          <input v-model="group" type="text" list="ssh-groups" placeholder="ex.: Clientes" />
          <datalist id="ssh-groups"><option v-for="g in knownGroups" :key="g" :value="g" /></datalist>
        </label>
      </div>
      <div class="row">
        <label class="field grow">
          <span>Host</span>
          <input v-model="host" type="text" class="mono" placeholder="10.20.4.200 ou servidor.exemplo.com" spellcheck="false" :class="{ bad: host && !hostOk }" />
        </label>
        <label class="field port">
          <span>Porta</span>
          <input v-model.number="port" type="text" inputmode="numeric" class="mono" :class="{ bad: !portOk }" />
        </label>
      </div>
      <label class="field">
        <span>Usuário</span>
        <input v-model="user" type="text" class="mono" placeholder="ubuntu" spellcheck="false" list="ssh-users" :class="{ bad: !userOk }" />
        <datalist id="ssh-users">
          <option v-for="u in knownUsers" :key="u" :value="u" />
        </datalist>
      </label>
      <label class="field">
        <span>Chave privada <em>opcional</em></span>
        <select class="key-select" :value="identityFile" @change="onKeyChange">
          <option value="">Padrão (~/.ssh/config e agente)</option>
          <optgroup v-if="usedKeys.length" label="Usadas em outras conexões">
            <option v-for="k in usedKeys" :key="k.path" :value="k.path">
              {{ keyName(k.path) }} · {{ k.names.join(', ') }}
            </option>
          </optgroup>
          <optgroup v-if="newKeys.length" label="Encontradas em ~/.ssh">
            <option v-for="k in newKeys" :key="k" :value="k">{{ keyName(k) }}</option>
          </optgroup>
          <option v-if="customKey" :value="customKey">{{ keyName(customKey) }}</option>
          <option :value="PICK">Outro arquivo…</option>
        </select>
        <small v-if="identityFile" class="faint mono path">{{ shortPath(identityFile) }}</small>
      </label>
      <label class="field">
        <span>Pasta ao conectar <em>opcional</em></span>
        <input v-model="remoteDir" type="text" class="mono" placeholder="/home/apps/ovseer" spellcheck="false" />
      </label>
      <p class="faint preview mono">{{ preview }}</p>
      <p class="faint note">A senha nunca é salva: se o servidor pedir, digite no terminal.</p>
    </form>
    <template #footer>
      <button v-if="editing" type="button" class="ghost danger" @click="remove"><Icon name="x" :size="13" /> Remover</button>
      <span class="grow" />
      <button type="button" @click="emit('close')">Cancelar</button>
      <button type="button" :disabled="!valid" @click="save(false)">Salvar</button>
      <button type="button" class="primary" :disabled="!valid" @click="save(true)">Salvar e conectar</button>
    </template>
  </Modal>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field > span { font-size: 12px; color: var(--muted); }
.field em { font-style: normal; font-size: 10.5px; margin-left: 4px; padding: 0 6px; border-radius: 999px; background: var(--panel-2); }
.row { display: flex; gap: 10px; }
.grow { flex: 1; }
.port { width: 90px; }
.group { width: 170px; }
.key-select { font-size: 13px; }
.path { font-size: 11px; margin-top: -1px; word-break: break-all; }
input.bad { border-color: var(--del); }
.preview { margin: 0; font-size: 12px; padding: 8px 10px; background: var(--panel-2); border-radius: var(--radius); }
.note { margin: -4px 0 0; font-size: 12px; }
.danger:hover { color: var(--del); background: var(--del-bg) !important; }
</style>
