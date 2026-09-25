<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import logo from '../assets/logo.png'
import { api, ovseerWorkspace, refreshOvseer, saveSettings, state } from '../store'

const waiting = ref(false)
const error = ref<string | null>(null)
const avatarFailed = ref(false)

const user = computed(() => state.ovseer?.user)
const initials = computed(() =>
  (user.value?.name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
)
const avatar = computed(() =>
  !avatarFailed.value && user.value?.avatarUrl?.startsWith('https://') ? user.value.avatarUrl : null
)

const clean = (e: unknown) => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function connect() {
  error.value = null
  waiting.value = true
  try {
    state.ovseer = await api.ovseerLogin()
    await refreshOvseer()
  } catch (e) {
    if (waiting.value) error.value = clean(e)
  } finally {
    waiting.value = false
  }
}

async function cancel() {
  waiting.value = false
  await api.ovseerCancelLogin()
}

async function disconnect() {
  api.ovseerLive(false)
  state.ovseerLive = false
  state.ovseer = await api.ovseerLogout()
  state.tasks = []
  state.commitTaskId = null
}

async function pickWorkspace(id: string) {
  await saveSettings({ ovseerWorkspaceId: id })
  state.commitTaskId = null
  await refreshOvseer()
}

onUnmounted(() => {
  if (waiting.value) api.ovseerCancelLogin()
})
</script>

<template>
  <div class="card" :class="{ connected: state.ovseer?.connected && !waiting }">
    <!-- conectado -->
    <template v-if="state.ovseer?.connected && !waiting">
      <div class="head">
        <img v-if="avatar" :src="avatar" class="avatar" alt="" @error="avatarFailed = true" />
        <span v-else class="avatar initials">{{ initials }}</span>
        <div class="who">
          <strong class="ellipsis">{{ user?.name ?? 'Conectado' }}</strong>
          <span class="muted ellipsis">{{ user?.email }}</span>
        </div>
        <span class="pill"><span class="dot" /> Conectado</span>
      </div>
      <div class="foot">
        <label v-if="state.ovseer.workspaces?.length" class="ws">
          <span class="muted">Workspace</span>
          <select :value="ovseerWorkspace?.id" @change="pickWorkspace(($event.target as HTMLSelectElement).value)">
            <option v-for="w in state.ovseer.workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
        </label>
        <span class="grow" />
        <button class="small ghost danger" @click="disconnect">Desconectar</button>
      </div>
      <p v-if="state.ovseer.error" class="bad">{{ state.ovseer.error }}</p>
    </template>

    <!-- desconectado / aguardando -->
    <template v-else>
      <div class="head">
        <img :src="logo" class="brand" alt="" />
        <div class="who">
          <strong>Ovseer</strong>
          <span v-if="waiting" class="muted">Aguardando autorização no navegador…</span>
          <span v-else class="muted">Vincule seus commits às tarefas</span>
        </div>
        <button v-if="waiting" class="small" @click="cancel"><span class="spinner" /> Cancelar</button>
        <button v-else class="small primary" @click="connect">Conectar</button>
      </div>
      <p v-if="error" class="bad">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.card {
  display: flex; flex-direction: column; gap: 12px; padding: 14px;
  border: 1px solid var(--border); border-radius: 12px;
  background: linear-gradient(135deg, var(--accent-soft), transparent 70%), var(--panel-2);
}
.card.connected { background: var(--panel-2); }
.head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand { width: 40px; height: 40px; flex: none; }
.avatar {
  width: 40px; height: 40px; border-radius: 50%; flex: none; object-fit: cover;
  box-shadow: 0 0 0 2px var(--panel), 0 0 0 3px var(--accent);
}
.initials {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent); color: var(--on-accent); font-weight: 700; font-size: 14px;
}
.who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.who strong { font-size: 14px; }
.who .muted { font-size: 12px; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  color: var(--add); background: var(--add-bg);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.foot { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.ws { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
.ws select { width: auto; max-width: 220px; height: 28px; padding: 0 8px; font-size: 12.5px; }
.grow { flex: 1; }
.danger:hover:not(:disabled) { color: var(--del); background: var(--del-bg); }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
