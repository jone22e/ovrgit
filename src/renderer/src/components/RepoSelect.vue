<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, loadProjectIcon, projectIcons, state } from '../store'
import Icon from './Icon.vue'

/**
 * Seletor de repositório: o ícone do projeto e o nome num botão; a lista (projeto aberto e recentes, com ícones)
 * abre embaixo. `any`: oferece "Qualquer repositório" (valor vazio).
 */
const model = defineModel<string>({ required: true })
const props = defineProps<{ any?: boolean }>()
const open = ref(false)
const root = ref<HTMLElement>()
const projects = ref<string[]>([])
const options = computed(() => [...new Set([state.repo?.root ?? '', ...projects.value].filter(Boolean))])
const name = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const dir = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const icon = (p: string) => projectIcons.get(p) ?? null

onMounted(async () => {
  projects.value = await api.agentProjects().catch(() => [])
  for (const p of options.value) loadProjectIcon(p)
})
watch(options, (l) => l.forEach(loadProjectIcon))
function choose(p: string) {
  model.value = p
  open.value = false
}
const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <span ref="root" class="repo-select" :class="{ on: open }">
    <button type="button" class="sel" :title="model || (props.any ? 'Qualquer repositório' : '')" @click="open = !open">
      <template v-if="model">
        <img v-if="icon(model)" :src="icon(model)!" class="fav" alt="" />
        <Icon v-else name="folder" :size="14" class="faint" />
        <span class="ellipsis">{{ name(model) }}</span>
      </template>
      <template v-else>
        <Icon name="layers" :size="14" class="faint" />
        <span class="ellipsis faint-text">Qualquer repositório</span>
      </template>
      <Icon name="chevron" :size="12" class="chev" />
    </button>
    <div v-if="open" class="pop" role="listbox">
      <button v-if="props.any" type="button" class="ghost opt" :class="{ cur: !model }" @click="choose('')">
        <Icon name="layers" :size="14" class="faint" />
        <span class="txt"><span class="nm">Qualquer repositório</span><small class="faint">o próximo agente em espera livre, de qualquer projeto</small></span>
        <Icon v-if="!model" name="check" :size="13" class="ok" />
      </button>
      <button v-for="p in options" :key="p" type="button" class="ghost opt" :class="{ cur: p === model }" :title="p" @click="choose(p)">
        <img v-if="icon(p)" :src="icon(p)!" class="fav" alt="" />
        <Icon v-else name="folder" :size="14" class="faint" />
        <span class="txt"><span class="nm ellipsis">{{ name(p) }}</span><small class="faint ellipsis">{{ dir(p) }}</small></span>
        <Icon v-if="p === model" name="check" :size="13" class="ok" />
      </button>
    </div>
  </span>
</template>

<style scoped>
.repo-select { position: relative; display: inline-flex; min-width: 0; }
.sel { display: inline-flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 13px; font-weight: 500; text-align: left; min-width: 0; }
.sel:hover, .repo-select.on .sel { border-color: color-mix(in srgb, var(--text) 25%, var(--border)); background: var(--hover); }
.sel .ellipsis { flex: 1; min-width: 0; }
.faint-text { color: var(--muted); font-weight: 400; }
.fav { width: 16px; height: 16px; border-radius: 4px; flex: none; }
.chev { color: var(--faint); transform: rotate(90deg); flex: none; }
.pop { position: absolute; left: 0; top: calc(100% + 6px); z-index: 60; min-width: 100%; width: max-content; max-width: 360px; max-height: 320px; overflow: auto; padding: 6px; border-radius: 12px; background: var(--panel); border: 1px solid var(--border); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); display: flex; flex-direction: column; gap: 2px; animation: drop 0.12s ease-out; }
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
.opt { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 10px; justify-content: flex-start; color: var(--text); min-width: 0; }
.opt.cur { background: var(--accent-soft); }
.txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; text-align: left; }
.nm { font-size: 13px; font-weight: 500; }
.txt small { font-size: 11px; }
.ok { color: var(--accent); flex: none; }
</style>
