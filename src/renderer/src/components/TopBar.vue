<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import logo from '../assets/logo.png'
import { api, myDoingCount, openNewAgent, refreshOvseer, setShowDiff, setShowTasks, setShowTerminal, state } from '../store'
import Icon from './Icon.vue'
import AgentHistoryMenu from './AgentHistoryMenu.vue'
import BranchSwitcher from './BranchSwitcher.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
import UsageChip from './UsageChip.vue'

const switcherOpen = defineModel<boolean>('switcher', { default: false })
// usuário logado no Ovseer: foto no canto direito
const me = computed(() => (state.ovseer?.connected ? state.ovseer.user ?? null : null))
const avatarBroken = ref(false)
const userOpen = ref(false)
const userRoot = ref<HTMLElement>()
const ovseerHome = computed(() => (state.ovseer?.url ?? state.settings?.ovseerUrl ?? '').replace(/\/+$/, ''))
async function disconnectOvseer() {
  state.ovseer = await api.ovseerLogout()
  await refreshOvseer()
}
const onDoc = (e: MouseEvent) => {
  if (userOpen.value && userRoot.value && !userRoot.value.contains(e.target as Node)) userOpen.value = false
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

defineEmits<{ settings: [] }>()
</script>

<template>
  <header class="topbar">
    <img :src="logo" class="logo" alt="Ovseer" title="Ovseer" />
    <span class="task-btns">
      <button
        class="ghost icon"
        :class="{ on: state.showTasks }"
        :title="state.showTasks ? 'Fechar tarefas' : 'Tarefas do Ovseer'"
        @click="setShowTasks(!state.showTasks)"
      >
        <Icon name="panelLeft" />
        <span v-if="myDoingCount" class="badge-dot" :title="`${myDoingCount} tarefa(s) em execução`" />
      </button>
      <button class="ghost icon" title="Novo agente de IA (Claude ou ChatGPT) neste projeto" @click="openNewAgent()">
        <Icon name="squarePen" />
      </button>
      <AgentHistoryMenu />
    </span>

    <template v-if="state.repo">
      <ProjectSwitcher v-model:open="switcherOpen" />
      <BranchSwitcher />
      <span v-if="state.repo.ahead" class="badge wide-only" title="Versões salvas no seu computador que ainda não foram enviadas">
        <Icon name="up" :size="12" />{{ state.repo.ahead }}
      </span>
      <span v-if="state.repo.behind" class="badge wide-only" title="Versões novas no servidor que você ainda não baixou">
        <Icon name="down" :size="12" />{{ state.repo.behind }}
      </span>
      <span v-if="!state.repo.hasRemote" class="badge wide-only" title="Este projeto ainda não está em nenhum servidor">só no computador</span>
    </template>

    <span class="spacer" />
    <UsageChip />

    <template v-if="state.repo">
      <span class="layout">
        <button
          class="ghost icon"
          :class="{ on: state.showDiff }"
          :title="`${state.showDiff ? 'Fechar' : 'Abrir'} o diff (${mod}D)`"
          @click="setShowDiff(!state.showDiff)"
        >
          <Icon name="panel" />
        </button>
        <button
          class="ghost icon"
          :class="{ on: state.showTerminal }"
          :title="`${state.showTerminal ? 'Fechar' : 'Abrir'} o terminal (Ctrl+\`)`"
          @click="setShowTerminal(!state.showTerminal)"
        >
          <Icon name="panelBottom" />
        </button>
      </span>
    </template>
    <div ref="userRoot" class="user nodrag">
      <button class="avatar" :class="{ on: userOpen, anon: !me }" :title="me ? `${me.name}${me.email ? ` · ${me.email}` : ''}` : 'Conta e configurações'" @click="userOpen = !userOpen">
        <img v-if="me?.avatarUrl && !avatarBroken" :src="me.avatarUrl" alt="" @error="avatarBroken = true" />
        <span v-else-if="me" class="initials">{{ initials(me.name) }}</span>
        <Icon v-else name="settings" :size="15" />
      </button>
      <div v-if="userOpen" class="user-menu">
        <div v-if="me" class="who">
          <strong class="ellipsis">{{ me.name }}</strong>
          <small v-if="me.email" class="faint ellipsis">{{ me.email }}</small>
        </div>
        <div v-else class="who"><small class="faint">Ovseer não conectado</small></div>
        <button class="ghost item" @click="(userOpen = false), $emit('settings')">
          <Icon name="settings" :size="14" /> Configurações <span class="kbd">{{ mod }},</span>
        </button>
        <button v-if="state.ovseer?.connected" class="ghost item" @click="(userOpen = false), api.openExternal(ovseerHome)">
          <Icon name="external" :size="14" /> Abrir Ovseer
        </button>
        <button v-if="state.ovseer?.connected" class="ghost item" @click="(userOpen = false), disconnectOvseer()">
          <Icon name="x" :size="14" /> Desconectar do Ovseer
        </button>
        <button v-else class="ghost item" @click="(userOpen = false), $emit('settings')">
          <Icon name="cloud" :size="14" /> Conectar ao Ovseer…
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--titlebar);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  -webkit-app-region: drag;
  flex: none;
}
:root[data-platform='darwin'] .topbar { padding-left: 94px; }
:root[data-platform='win32'] .topbar,
:root[data-platform='linux'] .topbar { padding-right: 146px; }
.nodrag, button { -webkit-app-region: no-drag; }
.logo { width: 24px; height: 24px; margin-right: 2px; }
.user { position: relative; flex: none; margin-left: 2px; }
.avatar {
  width: 28px; height: 28px; padding: 0; border-radius: 50%; overflow: hidden; flex: none;
  border: 1px solid var(--border); background: var(--accent); color: var(--on-accent);
}
.avatar.anon { background: var(--panel-2); color: var(--muted); }
.avatar.on { box-shadow: 0 0 0 2px var(--accent-soft); }
.avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.avatar .initials { font-size: 10.5px; font-weight: 700; }
.user-menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 240px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px; animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
.who { display: flex; flex-direction: column; gap: 1px; padding: 8px 10px 10px; border-bottom: 1px solid var(--border); margin-bottom: 4px; min-width: 0; }
.who strong { font-size: 13px; }
.who small { font-size: 11.5px; }
.item { justify-content: flex-start; gap: 10px; height: 32px; padding: 0 10px; font-weight: 500; color: var(--text); }
.kbd { margin-left: auto; font-size: 11px; color: var(--faint); font-family: var(--mono); }
.spacer { flex: 1; min-width: 4px; }
.task-btns { display: flex; gap: 2px; margin-right: 4px; -webkit-app-region: no-drag; }
.task-btns button { position: relative; }
.task-btns .on { color: var(--accent); background: var(--accent-soft); }
.badge-dot {
  position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 2px var(--panel);
}
.layout { display: flex; gap: 2px; -webkit-app-region: no-drag; }
.layout .on { color: var(--accent); background: var(--accent-soft); }
.branch { min-width: 0; max-width: 240px; overflow: hidden; }
.branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 720px) {
  .wide-only { display: none; }
  .branch { max-width: 130px; }
}
@media (max-width: 600px) {
  .topbar { gap: 4px; }
}
</style>
