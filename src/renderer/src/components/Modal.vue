<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

defineProps<{ title: string; width?: number }>()
const emit = defineEmits<{ close: [] }>()

const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('close')
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" :style="{ width: `${width ?? 460}px` }">
      <h3>{{ title }}</h3>
      <div class="content"><slot /></div>
      <div class="footer"><slot name="footer" /></div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; background: rgba(10, 8, 16, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 24px;
  animation: fade 0.12s ease-out;
}
.modal {
  max-width: 100%; max-height: 100%; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35); padding: 20px;
  animation: pop 0.14s ease-out;
}
h3 { margin: 0 0 14px; font-size: 16px; }
.content { display: flex; flex-direction: column; gap: 12px; }
.footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.footer:empty { display: none; }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { transform: scale(0.97); opacity: 0; } }
</style>
