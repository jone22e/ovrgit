<script setup lang="ts">
import { setPane, state } from '../store'
import Icon from './Icon.vue'

/** Alterna entre os arquivos alterados (diff à direita), todos os arquivos do projeto (editor à direita) e o histórico de versões */
const current = () => (state.tab === 'history' ? 'history' : state.pane)
function go(v: 'changes' | 'files' | 'history') {
  if (v === 'history') {
    state.tab = 'history'
    return
  }
  state.tab = 'changes'
  setPane(v)
}
</script>

<template>
  <div class="seg pane-switch" role="group" aria-label="Lista de arquivos">
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
.seg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
/* painel estreito: só os ícones */
@container (max-width: 540px) {
  .lbl { display: none; }
  .seg button { width: 28px; padding: 0; }
}
</style>
