<script setup lang="ts">
import { answer, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
</script>

<template>
  <Modal v-if="state.confirm" :title="state.confirm.title" :width="420" @close="answer(false)">
    <div class="body">
      <span class="ic" :class="{ danger: state.confirm.danger }"><Icon :name="state.confirm.danger ? 'alert' : 'info'" :size="18" /></span>
      <p>{{ state.confirm.message }}</p>
    </div>
    <template #footer>
      <button type="button" @click="answer(false)">Voltar</button>
      <button type="button" class="primary" :class="{ danger: state.confirm.danger }" autofocus @click="answer(true)">
        {{ state.confirm.confirmLabel }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.body { display: flex; gap: 12px; align-items: flex-start; }
.ic { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none; background: var(--accent-soft); color: var(--accent); }
.ic.danger { background: var(--del-bg); color: var(--del); }
p { margin: 4px 0 0; font-size: 13px; line-height: 1.55; color: var(--muted); }
.primary.danger { background: var(--del); border-color: var(--del); color: #fff; }
.primary.danger:hover { filter: brightness(1.08); }
</style>
