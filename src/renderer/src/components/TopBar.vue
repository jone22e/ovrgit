<script setup lang="ts">
import { count } from '@shared/plural'
import logo from '../assets/logo.png'
import { myDoingCount, openNewAgent, setShowDiff, setShowDock, setShowTasks, setShowTerminal, state } from '../store'
import Icon from './Icon.vue'
import AgentHistoryMenu from './AgentHistoryMenu.vue'
import BranchSwitcher from './BranchSwitcher.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
import ServicesMenu from './ServicesMenu.vue'
import UsageChip from './UsageChip.vue'
import UserMenu from './UserMenu.vue'

const switcherOpen = defineModel<boolean>('switcher', { default: false })
const mod = window.ovseer.platform === 'darwin' ? '⌘' : 'Ctrl+'
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
        <span v-if="myDoingCount" class="badge-dot" :title="count(myDoingCount, 'tarefa em execução', 'tarefas em execução')" />
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
    <ServicesMenu />

    <template v-if="state.repo">
      <span class="layout">
        <!-- no orquestrador o painel lateral é a conversa ao lado dos cartões; nas outras abas, o diff -->
        <button
          v-if="state.tab === 'agents' && state.settings?.orchestrator"
          class="ghost icon"
          :class="{ on: state.showDock }"
          :title="state.showDock ? 'Esconder a conversa ao lado dos cartões' : 'Mostrar a conversa ao lado dos cartões'"
          @click="setShowDock(!state.showDock)"
        >
          <Icon name="panel" />
        </button>
        <button
          v-else
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
    <!-- sem projeto não há barra lateral: a conta fica aqui -->
    <UserMenu v-if="!state.repo" />
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
button { -webkit-app-region: no-drag; }
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
}
@media (max-width: 600px) {
  .topbar { gap: 4px; }
}
</style>
