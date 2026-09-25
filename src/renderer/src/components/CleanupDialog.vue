<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CleanupCandidate } from '@shared/types'
import { api, state, toast } from '../store'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const items = ref<CleanupCandidate[]>([])
const picked = ref(new Set<string>())
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  items.value = await api.cleanupCandidates().catch(() => [])
  picked.value = new Set(items.value.filter((i) => i.suggested).map((i) => i.name))
  loading.value = false
})

const merged = computed(() => items.value.filter((i) => i.reason === 'merged'))
const backups = computed(() => items.value.filter((i) => i.reason === 'backup'))
const when = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })

function toggle(name: string) {
  const s = new Set(picked.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  picked.value = s
}

async function remove() {
  busy.value = true
  error.value = null
  try {
    const r = await api.deleteBranches([...picked.value])
    const n = r.steps.filter((s) => s.ok).length
    toast(`${n} linha(s) removida(s).`)
    if (!r.ok) error.value = r.steps.filter((s) => !s.ok).map((s) => s.label).join(' · ')
    else emit('close')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Limpar linhas de trabalho" :width="520" @close="emit('close')">
    <p v-if="loading" class="faint"><span class="spinner" /> Procurando…</p>
    <p v-else-if="!items.length" class="muted">Nada para limpar: não há cópias de segurança nem linhas já incorporadas.</p>
    <template v-else>
      <section v-if="merged.length">
        <h5>Já incorporadas à linha principal</h5>
        <p class="muted hint">O conteúdo delas já está na principal, então podem sair sem perder nada.</p>
        <label v-for="i in merged" :key="i.name" class="item">
          <input type="checkbox" :checked="picked.has(i.name)" @change="toggle(i.name)" />
          <span class="mono ellipsis">{{ i.name }}</span>
          <small class="faint">{{ when(i.date) }}</small>
        </label>
      </section>
      <section v-if="backups.length">
        <h5>Cópias de segurança automáticas</h5>
        <p class="muted hint">Criadas pelo "Criar Feature" antes de mexer nas linhas. As com mais de 7 dias já vêm marcadas.</p>
        <label v-for="i in backups" :key="i.name" class="item">
          <input type="checkbox" :checked="picked.has(i.name)" @change="toggle(i.name)" />
          <span class="mono ellipsis">{{ i.name }}</span>
          <small class="faint">{{ when(i.date) }}</small>
        </label>
      </section>
    </template>
    <p v-if="error" class="bad">{{ error }}</p>
    <template #footer>
      <button @click="emit('close')">Fechar</button>
      <button class="primary" :disabled="!picked.size || busy || !state.repo" @click="remove">
        <span v-if="busy" class="spinner" /> Remover {{ picked.size }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
section { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
h5 { margin: 4px 0 0; font-size: 12.5px; }
.hint { margin: 0 0 6px; font-size: 12px; }
.item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.item:hover { background: var(--hover); }
.item span { flex: 1; min-width: 0; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
