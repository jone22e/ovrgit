<script setup lang="ts">
import { computed } from 'vue'
import { abortOperation, continueOperation, openInEditor, state } from '../store'
import Icon from './Icon.vue'

const op = computed(() => state.repo?.operation)
const conflicts = computed(() => state.repo?.conflicts ?? 0)
const NAME = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' } as const
</script>

<template>
  <div v-if="op" class="banner" :class="{ done: !conflicts }">
    <Icon :name="conflicts ? 'alert' : 'check'" :size="18" />
    <div class="text">
      <strong>{{ NAME[op] }} em andamento</strong>
      <span v-if="conflicts">
        · {{ conflicts }} arquivo{{ conflicts === 1 ? '' : 's' }} em conflito. Escolha a versão de cada um abaixo, ou edite
        no editor e clique em "Resolvido".
      </span>
      <span v-else> · conflitos resolvidos. Pode concluir.</span>
    </div>
    <button class="small" @click="openInEditor"><Icon name="external" :size="13" /> Abrir no editor</button>
    <button class="small" :disabled="!!state.busy" @click="abortOperation">Abortar</button>
    <button class="small primary" :disabled="conflicts > 0 || !!state.busy" @click="continueOperation">
      <span v-if="state.busy === 'merge'" class="spinner" />
      Concluir {{ NAME[op].toLowerCase() }}
    </button>
  </div>
</template>

<style scoped>
.banner {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 10px 14px; background: var(--del-bg); color: var(--text);
  border-bottom: 1px solid var(--border);
}
.banner > svg { color: var(--del); }
.banner.done { background: var(--add-bg); }
.banner.done > svg { color: var(--add); }
.text { flex: 1; min-width: 0; font-size: 12.5px; }
</style>
