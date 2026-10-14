<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, refreshOvseer, state } from '../store'
import Icon from './Icon.vue'

/** Foto do usuário logado no Ovseer (ou a engrenagem, sem conta) com o menu de conta e configurações.
 * Na barra lateral (`side`) o menu abre para o lado, alinhado pelo pé; na barra de topo, cai do avatar. */
defineProps<{ side?: boolean }>()
const me = computed(() => (state.ovseer?.connected ? state.ovseer.user ?? null : null))
const avatarBroken = ref(false)
const open = ref(false)
const root = ref<HTMLElement>()
const ovseerHome = computed(() => (state.ovseer?.url ?? state.settings?.ovseerUrl ?? '').replace(/\/+$/, ''))
async function disconnectOvseer() {
  state.ovseer = await api.ovseerLogout()
  await refreshOvseer()
}
const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
const mod = window.ovseer.platform === 'darwin' ? '⌘' : 'Ctrl+'
function settings() {
  open.value = false
  state.showSettings = true
}
</script>

<template>
  <div ref="root" class="user" :class="{ side }">
    <button class="avatar" :class="{ on: open, anon: !me }" :title="me ? `${me.name}${me.email ? ` · ${me.email}` : ''}` : 'Conta e configurações'" @click="open = !open">
      <img v-if="me?.avatarUrl && !avatarBroken" :src="me.avatarUrl" alt="" @error="avatarBroken = true" />
      <span v-else-if="me" class="initials">{{ initials(me.name) }}</span>
      <Icon v-else name="settings" :size="15" />
    </button>
    <div v-if="open" class="menu">
      <div v-if="me" class="who">
        <strong class="ellipsis">{{ me.name }}</strong>
        <small v-if="me.email" class="faint ellipsis">{{ me.email }}</small>
      </div>
      <div v-else class="who"><small class="faint">Ovseer não conectado</small></div>
      <button class="ghost item" @click="settings()">
        <Icon name="settings" :size="14" /> Configurações <span class="kbd">{{ mod }},</span>
      </button>
      <button class="ghost item" title="Lista de temas, com prévia ao vivo (também: Shift Shift e digitar 'tema')" @click="(open = false), (state.quickOpen = 'tema ')"><Icon name="sliders" :size="14" /> Tema…</button>
      <button class="ghost item" @click="(open = false), (state.showServices = true)">
        <Icon name="server" :size="14" /> Serviços
      </button>
      <button v-if="state.ovseer?.connected" class="ghost item" @click="(open = false), api.openExternal(ovseerHome)">
        <Icon name="external" :size="14" /> Abrir Ovseer
      </button>
      <button v-if="state.ovseer?.connected" class="ghost item" @click="(open = false), disconnectOvseer()">
        <Icon name="x" :size="14" /> Desconectar do Ovseer
      </button>
      <button v-else class="ghost item" @click="settings()">
        <Icon name="cloud" :size="14" /> Conectar ao Ovseer…
      </button>
    </div>
  </div>
</template>

<style scoped>
.user { position: relative; flex: none; -webkit-app-region: no-drag; }
.avatar {
  width: 28px; height: 28px; padding: 0; border-radius: 50%; overflow: hidden; flex: none;
  border: 1px solid var(--border); background: var(--accent); color: var(--on-accent);
}
.side .avatar { width: 30px; height: 30px; }
.avatar.anon { background: var(--panel-2); color: var(--muted); }
.avatar.on { box-shadow: 0 0 0 2px var(--accent-soft); }
.avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.avatar .initials { font-size: 10.5px; font-weight: 700; }
.menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 240px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px; animation: drop 0.12s ease-out;
}
/* na barra lateral: ao lado do avatar, com o pé alinhado ao dele */
.side .menu { top: auto; right: auto; bottom: 0; left: calc(100% + 12px); animation: slide 0.12s ease-out; }
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
@keyframes slide { from { opacity: 0; transform: translateX(-4px); } }
.who { display: flex; flex-direction: column; gap: 1px; padding: 8px 10px 10px; border-bottom: 1px solid var(--border); margin-bottom: 4px; min-width: 0; }
.who strong { font-size: 13px; }
.who small { font-size: 11.5px; }
.item { justify-content: flex-start; gap: 10px; height: 32px; padding: 0 10px; font-weight: 500; color: var(--text); }
.kbd { margin-left: auto; font-size: 11px; color: var(--faint); font-family: var(--mono); }
</style>
