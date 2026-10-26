<script setup lang="ts">
import { ref } from 'vue'
import { repoIconChoices } from '../repoIconChoices'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import RepoIcon from './RepoIcon.vue'

defineProps<{ title: string; current?: string | null }>()
const emit = defineEmits<{ close: []; choose: [icon: string | null] }>()
const fileInput = ref<HTMLInputElement>()
const error = ref('')

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  if (file.size > 10_000_000) {
    error.value = 'Escolha uma imagem de até 10 MB.'
    return
  }
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 96
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Não foi possível preparar a imagem.')
    const scale = Math.min(96 / bitmap.width, 96 / bitmap.height)
    const width = bitmap.width * scale
    const height = bitmap.height * scale
    ctx.drawImage(bitmap, (96 - width) / 2, (96 - height) / 2, width, height)
    emit('choose', canvas.toDataURL('image/png'))
  } catch {
    error.value = 'Não foi possível abrir esta imagem. Use PNG, JPEG, WebP, GIF ou ICO.'
  } finally {
    bitmap?.close()
  }
}
</script>

<template>
  <Teleport to="body">
    <Modal :title="`Ícone de ${title}`" :width="440" @close="emit('close')">
      <p class="hint">Escolha um símbolo ou uma imagem para identificar este repositório ou grupo em todas as conversas.</p>
      <div class="choices">
        <button v-for="choice in repoIconChoices" :key="choice.id" type="button" class="choice" :class="{ selected: current === choice.id }" :title="choice.label" :aria-label="choice.label" :aria-pressed="current === choice.id" @click="emit('choose', choice.id)">
          <RepoIcon :icon="choice.id" :size="36" />
          <span>{{ choice.label }}</span>
          <Icon v-if="current === choice.id" name="check" :size="12" class="check" />
        </button>
      </div>
      <input ref="fileInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon,.ico" @change="upload" />
      <button type="button" class="upload" @click="fileInput?.click()">
        <RepoIcon v-if="current?.startsWith('data:image/png;base64,')" :icon="current" :size="28" />
        <Icon v-else name="folder" :size="20" />
        <span>Escolher imagem do computador…</span>
      </button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
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
.choice { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-width: 0; min-height: 74px; padding: 7px 3px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font: inherit; font-size: 11px; font-weight: 500; cursor: pointer; }
.choice:hover, .choice:focus-visible { border-color: var(--accent); background: var(--hover); color: var(--text); }
.choice.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.check { position: absolute; right: 5px; top: 5px; color: var(--accent); }
.file-input { display: none; }
.upload { display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%; min-height: 44px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
.upload:hover, .upload:focus-visible { border-color: var(--accent); background: var(--hover); }
.error { margin: 0; color: var(--del); font-size: 12px; }
</style>
