<script setup lang="ts">
import { api, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const close = () => (state.result = null)
</script>

<template>
  <Modal v-if="state.result" :title="state.result.title" :width="520" @close="close">
    <ul class="steps">
      <li v-for="(s, i) in state.result.steps" :key="i" :class="{ bad: !s.ok }">
        <Icon :name="s.ok ? 'check' : 'x'" :size="15" class="ic" />
        <div>
          <div>{{ s.label }}</div>
          <pre v-if="s.detail" class="detail">{{ s.detail }}</pre>
        </div>
      </li>
    </ul>
    <p v-if="!state.result.ok && state.result.error && !state.result.steps.some((s) => !s.ok)" class="err">
      {{ state.result.error }}
    </p>
    <template #footer>
      <button v-if="state.result.prUrl" @click="api.openExternal(state.result.prUrl!)">
        <Icon name="external" /> Criar Pull Request
      </button>
      <button class="primary" autofocus @click="close">OK</button>
    </template>
  </Modal>
</template>

<style scoped>
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
li { display: flex; gap: 10px; align-items: flex-start; }
.ic { color: var(--add); margin-top: 2px; }
li.bad .ic { color: var(--del); }
.detail {
  margin: 4px 0 0; font-family: var(--mono); font-size: 11.5px; color: var(--muted);
  white-space: pre-wrap; word-break: break-word; user-select: text; max-height: 200px; overflow: auto;
}
.err { color: var(--del); margin: 0; white-space: pre-wrap; user-select: text; }
</style>
