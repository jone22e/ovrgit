<script setup lang="ts">
import logo from '../assets/logo.png'
import { myDoingCount, openNewTask, refresh, setShowDiff, setShowTasks, setShowTerminal, state } from '../store'
import Icon from './Icon.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'

const switcherOpen = defineModel<boolean>('switcher', { default: false })
const mod = window.ovrgit.platform === 'darwin' ? '⌘' : 'Ctrl+'

defineEmits<{ settings: [] }>()
</script>

<template>
  <header class="topbar">
    <img :src="logo" class="logo" alt="OvrGit" title="OvrGit" />
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
      <button class="ghost icon" title="Nova tarefa no Ovseer" @click="openNewTask">
        <Icon name="squarePen" />
      </button>
    </span>

    <template v-if="state.repo">
      <ProjectSwitcher v-model:open="switcherOpen" />
      <span class="badge accent branch" :title="state.repo.upstream ? `upstream: ${state.repo.upstream}` : 'sem upstream'">
        <Icon name="branch" :size="13" />
        <span>{{ state.repo.branch ?? 'HEAD destacado' }}</span>
      </span>
      <span v-if="state.repo.ahead" class="badge wide-only" title="Commits locais ainda não enviados">
        <Icon name="up" :size="12" />{{ state.repo.ahead }}
      </span>
      <span v-if="state.repo.behind" class="badge wide-only" title="Commits no remoto ainda não baixados">
        <Icon name="down" :size="12" />{{ state.repo.behind }}
      </span>
      <span v-if="!state.repo.hasRemote" class="badge wide-only" title="Sem remote origin">local</span>
    </template>

    <span class="spacer" />

    <template v-if="state.repo">
      <nav class="tabs nodrag">
        <button :class="{ active: state.tab === 'changes' }" class="ghost small" title="Alterações" @click="state.tab = 'changes'">
          <Icon name="list" :size="14" class="tab-icon" />
          <span class="tab-label">Alterações</span>
          <span v-if="state.repo.files.length" class="count">{{ state.repo.files.length }}</span>
        </button>
        <button :class="{ active: state.tab === 'history' }" class="ghost small" title="Histórico" @click="state.tab = 'history'">
          <Icon name="history" :size="14" class="tab-icon" />
          <span class="tab-label">Histórico</span>
        </button>
      </nav>
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
      <button class="ghost icon nodrag" title="Atualizar (Ctrl/⌘+R)" @click="refresh"><Icon name="refresh" /></button>
    </template>
    <button class="ghost icon nodrag" title="Configurações" @click="$emit('settings')"><Icon name="settings" /></button>
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
  .tabs .count { display: none; }
}
.tab-icon { display: none; }
@media (max-width: 600px) {
  .topbar { gap: 4px; }
  .tabs button { padding: 0 8px; }
  .tab-label { display: none; }
  .tab-icon { display: block; }
}
.tabs { display: flex; gap: 2px; padding: 2px; background: var(--panel-2); border-radius: 9px; margin-right: 4px; }
.tabs button { height: 26px; }
.tabs button.active { background: var(--panel); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.count { font-size: 11px; color: var(--accent); font-weight: 700; }
</style>
