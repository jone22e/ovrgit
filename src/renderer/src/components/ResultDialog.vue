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
          <div class="label">{{ s.label }}</div>
          <p v-if="s.detail" class="detail" :class="{ mono: s.ok && !s.tech && /\n/.test(s.detail) }">{{ s.detail }}</p>
          <details v-if="s.tech" class="tech">
            <summary>Detalhes técnicos</summary>
            <pre>{{ s.tech }}</pre>
          </details>
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
.label { font-weight: 600; }
.detail {
  margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--text);
  white-space: pre-wrap; word-break: break-word; user-select: text; max-height: 200px; overflow: auto;
}
li:not(.bad) .detail { color: var(--muted); font-size: 12.5px; }
.detail.mono { font-family: var(--mono); font-size: 11.5px; }
.tech { margin-top: 8px; }
.tech summary { cursor: pointer; font-size: 11.5px; color: var(--faint); user-select: none; }
.tech pre {
  margin: 6px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--panel-2); font-family: var(--mono); font-size: 11px;
  color: var(--muted); white-space: pre-wrap; word-break: break-word; user-select: text; max-height: 160px; overflow: auto;
}
.err { color: var(--del); margin: 0; white-space: pre-wrap; user-select: text; }
</style>
