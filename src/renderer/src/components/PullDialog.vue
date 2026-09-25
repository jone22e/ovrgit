<script setup lang="ts">
import { state } from '../store'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <Modal title="Baixar" @close="emit('close')">
    <p>Existem <strong>{{ state.repo?.files.length }} alterações não commitadas</strong>.</p>
    <p class="muted">
      O OvrGit pode guardar essas alterações (stash), baixar do remoto e depois restaurá-las. Se houver conflito,
      elas continuam salvas em <span class="mono">git stash list</span>.
    </p>
    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" autofocus @click="emit('confirm')">Guardar e baixar</button>
    </template>
  </Modal>
</template>

<style scoped>
p { margin: 0; }
</style>
