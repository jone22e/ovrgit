<script setup lang="ts">
import { repoIconChoices } from '../repoIconChoices'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import RepoIcon from './RepoIcon.vue'

defineProps<{ title: string; current?: string | null }>()
const emit = defineEmits<{ close: []; choose: [icon: string | null] }>()
</script>

<template>
  <Teleport to="body">
    <Modal :title="`Ícone de ${title}`" :width="440" @close="emit('close')">
      <p class="hint">Escolha um símbolo para identificar este repositório ou grupo nas listas e conversas.</p>
      <div class="choices">
        <button v-for="choice in repoIconChoices" :key="choice.id" type="button" class="choice" :class="{ selected: current === choice.id }" :title="choice.label" :aria-label="choice.label" :aria-pressed="current === choice.id" @click="emit('choose', choice.id)">
          <RepoIcon :icon="choice.id" :size="32" />
          <span>{{ choice.label }}</span>
          <Icon v-if="current === choice.id" name="check" :size="12" class="check" />
        </button>
      </div>
      <template #footer>
        <button v-if="current" type="button" class="ghost" @click="emit('choose', null)">Remover ícone</button>
        <button type="button" class="ghost" @click="emit('close')">Fechar</button>
      </template>
    </Modal>
  </Teleport>
</template>

<style scoped>
.hint { margin: -4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
.choices { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.choice { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; min-width: 0; min-height: 66px; padding: 7px 3px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); color: var(--muted); font: inherit; font-size: 10.5px; cursor: pointer; }
.choice:hover, .choice:focus-visible { border-color: var(--accent); background: var(--hover); color: var(--text); }
.choice.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.check { position: absolute; right: 5px; top: 5px; color: var(--accent); }
</style>
