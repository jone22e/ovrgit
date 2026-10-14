<script setup lang="ts">
import { computed } from 'vue'
import { count } from '@shared/plural'
import { myDoingCount, setPane, setShowTasks, state } from '../store'
import Icon from './Icon.vue'
import UserMenu from './UserMenu.vue'

/** Barra lateral de ícones à esquerda da janela, como no Codex: alterna entre o gerenciador de agentes, os arquivos
 * alterados (diff à direita), todos os arquivos do projeto (editor à direita), o histórico de versões e o mapa; e
 * abre e fecha o painel de tarefas do Ovseer (com um ponto quando há tarefa sua em execução) */
const current = () => (state.tab === 'changes' ? state.pane : state.tab)
/** Agentes esperando resposta ou que falharam: selo no botão */
const needYou = computed(() => state.agentSnaps.filter((a) => a.status === 'waiting' || a.status === 'error').length)
function go(v: 'agents' | 'changes' | 'files' | 'history' | 'map') {
  if (v === 'history' || v === 'agents' || v === 'map') {
    state.tab = v
    return
  }
  state.tab = 'changes'
  setPane(v)
}
</script>

<template>
  <nav class="rail" aria-label="Áreas do projeto">
    <button :class="{ on: current() === 'agents' }" title="Agentes: todas as janelas de agente abertas, o que cada uma precisa de você" @click="go('agents')">
      <Icon name="bot" :size="18" /><span class="lbl">Agentes</span><span v-if="needYou" class="need">{{ needYou }}</span>
    </button>
    <button :class="{ on: current() === 'changes' }" title="Arquivos alterados: ver o que mudou" @click="go('changes')">
      <Icon name="commit" :size="18" /><span class="lbl">Alterações</span><span v-if="state.repo?.files.length" class="cnt">{{ state.repo.files.length }}</span>
    </button>
    <button :class="{ on: current() === 'files' }" title="Todos os arquivos do projeto: abrir no editor" @click="go('files')">
      <Icon name="folder" :size="18" /><span class="lbl">Arquivos</span>
    </button>
    <button :class="{ on: current() === 'history' }" title="Histórico: versões salvas e alterações guardadas" @click="go('history')">
      <Icon name="history" :size="18" /><span class="lbl">Histórico</span>
    </button>
    <button :class="{ on: current() === 'map' }" title="Mapa: os arquivos do projeto e quem usa quem, num gráfico interativo" @click="go('map')">
      <Icon name="network" :size="18" /><span class="lbl">Mapa</span>
    </button>
    <button :class="{ on: state.showTasks }" :title="state.showTasks ? 'Fechar tarefas' : 'Tarefas do Ovseer'" @click="setShowTasks(!state.showTasks)">
      <Icon name="listTodo" :size="18" /><span class="lbl">Tarefas</span>
      <span v-if="myDoingCount" class="run" :title="count(myDoingCount, 'tarefa em execução', 'tarefas em execução')" />
    </button>
    <span class="gap" />
    <!-- conta e configurações no pé, como no Codex -->
    <UserMenu side />
  </nav>
</template>

<style scoped>
/* barra vertical, da altura da janela abaixo da barra de topo; só ícones, o nome fica na dica */
.rail { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 52px; flex: none; padding: 8px 0 10px; background: var(--panel); border-right: 1px solid var(--border); }
.gap { flex: 1; }
.rail button { position: relative; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 10px; background: transparent; color: var(--muted); }
.rail button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.rail button.on { background: var(--accent-soft); color: var(--accent); }
/* o nome fica só para leitores de tela */
.lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* selos no canto de fora do botão, sem cobrir o desenho do ícone: arquivos alterados (número com contorno na cor
   do tema) e agentes que precisam de você (âmbar cheio). O anel na cor do painel os separa do fundo do botão. */
.cnt, .need {
  position: absolute; top: -3px; right: -4px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 8px; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px var(--panel);
}
.cnt { background: var(--panel); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent); }
.need { background: var(--mod); color: #1a1a1a; }
/* tarefa sua em execução: um ponto na cor do tema */
.run { position: absolute; top: 4px; right: 5px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--panel); }
</style>
