<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'

/**
 * Repositório da conversa do agente: um chip em destaque com a pasta. Enquanto a conversa não começou, o chip
 * abre a lista de repositórios recentes (os do seletor de projeto) para trocar, ou escolher outra pasta.
 */
const props = defineProps<{
  /** Pasta atual */
  cwd: string
  /** Nome exibido (a pasta) */
  project: string
  /** Pode trocar: a conversa ainda não recebeu a primeira mensagem */
  switchable: boolean
  /** Lista centralizada abaixo do chip (estado vazio); senão alinhada à esquerda (cabeçalho) */
  center?: boolean
  /** Chip maior, no título do estado vazio */
  big?: boolean
}>()
const emit = defineEmits<{ choose: [path: string]; pick: [] }>()
const api = window.ovseer

const open = ref(false)
const root = ref<HTMLElement>()
const popEl = ref<HTMLElement>()
/** A lista vai para o body (a janela do agente rola e cortava o menu); a posição sai do chip */
const popStyle = ref<Record<string, string>>({})
function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const top = r.bottom + 6
  popStyle.value = {
    top: `${top}px`,
    left: props.center ? `${r.left + r.width / 2}px` : `${r.left}px`,
    transform: props.center ? 'translateX(-50%)' : '',
    maxHeight: `${Math.max(160, window.innerHeight - top - 12)}px`
  }
}
const projects = ref<string[]>([])
const icons = reactive(new Map<string, string | null>())
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const dir = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')

async function toggle() {
  if (!props.switchable) return
  open.value = !open.value
  if (!open.value) return
  place()
  projects.value = await api.agentProjects().catch(() => [])
  for (const p of projects.value) {
    if (icons.has(p)) continue
    icons.set(p, null)
    api.projectIcon(p).then((i) => icons.set(p, i)).catch(() => undefined)
  }
}
function choose(p: string) {
  open.value = false
  if (p !== props.cwd) emit('choose', p)
}
function pick() {
  open.value = false
  emit('pick')
}
const onDoc = (e: MouseEvent) => {
  const t = e.target as Node
  if (open.value && root.value && !root.value.contains(t) && !popEl.value?.contains(t)) open.value = false
}
const onResize = () => open.value && place()
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) open.value = false
}
watch(() => props.switchable, (s) => !s && (open.value = false))
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <span ref="root" class="repo-menu" :class="{ big, center }">
    <button
      type="button"
      class="repo"
      :class="{ on: open, static: !switchable }"
      :disabled="!switchable"
      :title="switchable ? `${cwd}\nClique para trocar o repositório` : cwd"
      @click="toggle"
    >
      <Icon name="folder" :size="big ? 16 : 11" />
      <span class="ellipsis">{{ project }}</span>
      <Icon v-if="switchable" name="chevron" :size="big ? 12 : 10" class="chev" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="popEl" class="pop" :class="{ big }" role="menu" :style="popStyle">
      <h6>Trabalhar no repositório</h6>
      <div class="list">
        <button v-for="p in projects" :key="p" type="button" class="ghost opt" :class="{ cur: p === cwd }" :title="p" @click="choose(p)">
          <img v-if="icons.get(p)" :src="icons.get(p)!" class="fav" alt="" />
          <Icon v-else name="folder" :size="14" class="faint" />
          <span class="opt-text">
            <strong class="ellipsis">{{ base(p) }}</strong>
            <small class="ellipsis">{{ dir(p) }}</small>
          </span>
          <Icon v-if="p === cwd" name="check" :size="14" class="ok" />
        </button>
        <p v-if="!projects.length" class="faint none">Nenhum repositório recente.</p>
      </div>
      <hr class="sep" />
      <button type="button" class="ghost opt" @click="pick"><Icon name="plus" :size="14" class="faint" /><strong>Outra pasta…</strong></button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.repo-menu { position: relative; display: inline-flex; min-width: 0; vertical-align: baseline; -webkit-app-region: no-drag; }
/* o chip: leve destaque sobre o resto do subtítulo */
.repo {
  display: inline-flex; align-items: center; gap: 4px; height: 16px; padding: 0 6px; margin: 0 1px; min-width: 0; max-width: 100%;
  border: 0; border-radius: 6px; font: inherit; font-size: inherit; font-weight: 600; line-height: 1;
  color: var(--text); background: color-mix(in srgb, var(--text) 9%, transparent); cursor: pointer;
}
.repo:disabled, .repo.static { cursor: default; opacity: 1; }
.repo:not(.static):hover, .repo.on { background: var(--accent-soft); color: var(--accent); }
.repo .chev { transform: rotate(90deg); opacity: 0.7; flex: none; }
.repo svg:first-child { flex: none; }
/* o nome não encolhe antes do resto do subtítulo (só corta em nomes muito longos) */
.repo .ellipsis { flex: none; max-width: 220px; }
.big .repo { height: 30px; padding: 0 10px 0 8px; gap: 6px; margin: 0; border-radius: 9px; font-size: 17px; font-weight: 700; }
/* a lista vive no body (Teleport), com posição fixa calculada a partir do chip */
.pop {
  position: fixed; z-index: 60; width: 300px; padding: 6px; box-sizing: border-box;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px; text-align: left; font-size: 13px; font-weight: 400; line-height: 1.3; animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; } }
h6 { margin: 6px 10px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); flex: none; }
.list { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.opt { justify-content: flex-start; gap: 10px; height: auto; padding: 7px 10px; width: 100%; text-align: left; color: var(--text); }
.opt.cur { background: var(--accent-soft); }
.opt-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.opt-text strong { font-size: 12.5px; }
.opt-text small { font-size: 11px; color: var(--muted); }
.opt .ok { color: var(--accent); flex: none; }
.opt strong { font-size: 12.5px; }
.fav { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.sep { border: 0; border-top: 1px solid var(--border); margin: 4px 6px; }
.none { margin: 6px 10px 8px; font-size: 12px; }
</style>
