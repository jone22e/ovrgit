<script setup lang="ts">
import { acceptResolution, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
</script>

<template>
  <Modal v-if="state.resolution" :title="`Proposta da IA: ${state.resolution.file}`" :width="720" @close="state.resolution = null">
    <p class="expl"><Icon name="sparkles" :size="15" /> {{ state.resolution.explanation }}</p>
    <p class="muted small">Como o arquivo vai ficar (confira antes de usar):</p>
    <pre class="code mono">{{ state.resolution.content }}</pre>
    <template #footer>
      <button @click="state.resolution = null">Cancelar</button>
      <button class="primary" @click="acceptResolution"><Icon name="check" :size="14" /> Usar esta versão</button>
    </template>
  </Modal>
</template>

<style scoped>
.expl { display: flex; gap: 8px; margin: -4px 0 0; font-size: 13px; line-height: 1.5; }
.expl svg { color: var(--accent); flex: none; margin-top: 2px; }
.small { margin: 0; font-size: 12px; }
.code { margin: 0; padding: 12px; max-height: 50vh; overflow: auto; background: var(--panel-2); border-radius: 10px; font-size: 12px; line-height: 1.5; white-space: pre; user-select: text; }
</style>
