<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { loadTasks, state } from '../store'
import Icon from './Icon.vue'

/** Seletor opcional de tarefa do Ovseer. */
const props = defineProps<{ modelValue: string | null; compact?: boolean; up?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string | null] }>()

const open = ref(false)
const query = ref('')
const root = ref<HTMLElement>()
const input = ref<HTMLInputElement>()
const index = ref(0)

const selected = computed(() => state.tasks.find((t) => t.id === props.modelValue) ?? null)
const items = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? state.tasks.filter((t) => `${t.key} ${t.title} ${t.statusLabel}`.toLowerCase().includes(q))
    : state.tasks
  return [...list].sort((a, b) => Number(!!b.assignedToMe) - Number(!!a.assignedToMe))
})

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  query.value = ''
  index.value = 0
  loadTasks()
  await nextTick()
  input.value?.focus()
}

function choose(id: string | null) {
  emit('update:modelValue', id)
  open.value = false
}

function onKey(e: KeyboardEvent) {
  const n = items.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    index.value = n ? (index.value + 1) % n : 0
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    index.value = n ? (index.value - 1 + n) % n : 0
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (items.value[index.value]) choose(items.value[index.value].id)
  } else if (e.key === 'Escape') {
    e.stopPropagation()
    open.value = false
  }
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="picker">
    <button
      type="button"
      class="trigger"
      :class="{ set: !!selected, compact }"
      :title="selected ? `${selected.key} · ${selected.title} (clique para trocar)` : 'Vincular a uma tarefa do Ovseer (opcional)'"
      @click="toggle"
    >
      <Icon name="task" :size="14" />
      <template v-if="selected">
        <span class="key mono">{{ selected.key }}</span>
        <span v-if="!compact" class="title ellipsis">{{ selected.title }}</span>
      </template>
      <span v-else class="placeholder">Tarefa</span>
      <span v-if="selected" class="clear" title="Sem tarefa" @click.stop="choose(null)"><Icon name="x" :size="12" /></span>
    </button>

    <div v-if="open" class="pop" :class="{ up }" @keydown="onKey">
      <input ref="input" v-model="query" type="text" placeholder="Buscar tarefa…" spellcheck="false" />
      <p v-if="state.tasksError" class="bad">{{ state.tasksError }}</p>
      <p v-else-if="state.tasksLoading && !state.tasks.length" class="faint msg"><span class="spinner" /> Carregando tarefas…</p>
      <ul v-else-if="items.length">
        <li
          v-for="(t, i) in items"
          :key="t.id"
          :class="{ hi: i === index, on: t.id === modelValue }"
          @mouseenter="index = i"
          @click="choose(t.id)"
        >
          <span class="key mono">{{ t.key }}</span>
          <span class="title ellipsis">{{ t.title }}</span>
          <span class="status">{{ t.statusLabel }}</span>
        </li>
      </ul>
      <p v-else class="faint msg">Nenhuma tarefa ativa encontrada.</p>
      <button v-if="modelValue" type="button" class="ghost none" @click="choose(null)">Sem tarefa</button>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; min-width: 0; }
.trigger { gap: 6px; max-width: 280px; padding: 0 10px; color: var(--muted); font-weight: 500; }
.trigger.set { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.trigger.compact { height: 26px; font-size: 12px; padding: 0 8px; max-width: 150px; }
.key { color: var(--accent); font-size: 11.5px; font-weight: 700; flex: none; }
.title { min-width: 0; }
.placeholder { font-weight: 400; }
.clear { display: inline-flex; margin-right: -4px; padding: 2px; border-radius: 4px; color: var(--faint); }
.clear:hover { background: var(--hover); color: var(--text); }
.pop {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 60; width: min(420px, 90vw); padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.pop.up { top: auto; bottom: calc(100% + 6px); }
input { height: 32px; margin-bottom: 4px; }
ul { list-style: none; margin: 0; padding: 0; max-height: 280px; overflow: auto; }
li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
li.hi { background: var(--hover); }
li.on .title { color: var(--accent); }
li .title { flex: 1; font-size: 12.5px; }
.status {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
  background: var(--panel-2); padding: 1px 6px; border-radius: 4px; flex: none;
}
.msg, .bad { margin: 8px; font-size: 12px; display: flex; align-items: center; gap: 8px; }
.bad { color: var(--del); }
.none { width: 100%; justify-content: flex-start; height: 30px; margin-top: 4px; border-top: 1px solid var(--border); border-radius: 0 0 7px 7px; }
</style>
