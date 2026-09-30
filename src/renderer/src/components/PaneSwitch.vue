<script setup lang="ts">
import { computed } from 'vue'
import { setPane, state } from '../store'
import Icon from './Icon.vue'

/** Alterna entre o gerenciador de agentes, os arquivos alterados (diff à direita), todos os arquivos do projeto
 * (editor à direita) e o histórico de versões */
const current = () => (state.tab === 'changes' ? state.pane : state.tab)
/** Agentes esperando resposta ou que falharam: selo no botão */
const needYou = computed(() => state.agentSnaps.filter((a) => a.status === 'waiting' || a.status === 'error').length)
function go(v: 'agents' | 'changes' | 'files' | 'history') {
  if (v === 'history' || v === 'agents') {
    state.tab = v
    return
  }
  state.tab = 'changes'
  setPane(v)
}
</script>

<template>
  <div class="seg pane-switch" role="group" aria-label="Lista de arquivos">
    <button :class="{ on: current() === 'agents' }" title="Agentes: todas as janelas de agente abertas, o que cada uma precisa de você" @click="go('agents')">
      <Icon name="bot" :size="14" /><span class="lbl">Agentes</span><span v-if="needYou" class="need">{{ needYou }}</span>
    </button>
    <button :class="{ on: current() === 'changes' }" title="Arquivos alterados: ver o que mudou" @click="go('changes')">
      <Icon name="commit" :size="14" /><span class="lbl">Alterações</span>
    </button>
    <button :class="{ on: current() === 'files' }" title="Todos os arquivos do projeto: abrir no editor" @click="go('files')">
      <Icon name="folder" :size="14" /><span class="lbl">Arquivos</span>
    </button>
    <button :class="{ on: current() === 'history' }" title="Histórico: versões salvas e alterações guardadas" @click="go('history')">
      <Icon name="history" :size="14" /><span class="lbl">Histórico</span>
    </button>
  </div>
</template>

<style scoped>
.seg { display: flex; padding: 2px; gap: 2px; background: var(--panel-2); border-radius: 8px; flex: none; }
.seg button { height: 24px; padding: 0 8px; gap: 5px; border: 0; background: transparent; color: var(--muted); border-radius: 6px; font-size: 12px; }
.need { min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: var(--mod); color: #1a1a1a; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
/* painel estreito: só os ícones */
@container (max-width: 540px) {
  .lbl { display: none; }
  .seg button { width: 28px; padding: 0; }
}
</style>
