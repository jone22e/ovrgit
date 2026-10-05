<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { AgentSnapshot } from '@shared/types'
import { api } from '../store'
import Icon from './Icon.vue'

/**
 * Controle discreto da janela do agente, ao lado do alfinete: mostrar ou esconder a janela, deixá-la em segundo
 * plano (fechar só esconde; o agente continua) e fechar de verdade. O botão direito na linha da tarefa abre o mesmo
 * menu, na posição do ponteiro.
 */
const props = defineProps<{ a: AgentSnapshot }>()
const open = ref(false)
const root = ref<HTMLElement>()
const popEl = ref<HTMLElement>()
const popStyle = ref<Record<string, string>>({})

function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const width = 268
  // alinhado pela direita do botão, sem sair da janela
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
  popStyle.value = { top: `${r.bottom + 6}px`, left: `${left}px`, width: `${width}px` }
}
function toggle() {
  open.value = !open.value
  if (open.value) place()
}
/** Linha (ou cartão) da tarefa onde o botão está: o botão direito nela abre o menu */
let row: HTMLElement | null = null
async function onContext(e: MouseEvent) {
  // em campo de texto (a resposta rápida do cartão) fica o menu do sistema
  if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return
  e.preventDefault()
  const width = 268
  const at = (h: number) => ({
    top: `${Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8))}px`,
    left: `${Math.max(8, Math.min(e.clientX, window.innerWidth - width - 8))}px`,
    width: `${width}px`
  })
  popStyle.value = at(0)
  open.value = true
  // já com a altura real, para não passar da borda de baixo da janela
  await nextTick()
  if (popEl.value) popStyle.value = at(popEl.value.offsetHeight)
}
const run = (p: Promise<unknown>) => {
  open.value = false
  p.catch(() => undefined)
}
const working = () => props.a.status === 'live'
const onDoc = (e: MouseEvent) => {
  const t = e.target as Node
  if (open.value && root.value && !root.value.contains(t) && !popEl.value?.contains(t)) open.value = false
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) open.value = false
}
const onResize = () => (open.value = false)
onMounted(() => {
  row = root.value?.closest<HTMLElement>('[data-uid]') ?? null
  row?.addEventListener('contextmenu', onContext)
  document.addEventListener('mousedown', onDoc)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  row?.removeEventListener('contextmenu', onContext)
  document.removeEventListener('mousedown', onDoc)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <span ref="root" class="win-menu" :class="{ on: open, hidden: a.hidden, bg: a.background }">
    <button
      type="button"
      class="ghost icon small win-btn"
      :title="a.hidden ? 'Janela escondida · controle da janela' : a.background ? 'Em segundo plano · controle da janela' : 'Controle da janela: mostrar, esconder, segundo plano, fechar'"
      @click.stop="toggle"
    >
      <Icon name="monitor" :size="13" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="popEl" class="win-pop" role="menu" :style="popStyle" @click.stop>
        <h6>Janela do agente</h6>
        <button v-if="a.hidden" type="button" class="ghost opt" @click="run(api.agentShow(a.uid))">
          <Icon name="monitor" :size="14" />
          <span class="opt-text"><strong>Mostrar a janela</strong><small>Ela está escondida; a conversa continua daqui.</small></span>
        </button>
        <button v-else type="button" class="ghost opt" @click="run(api.agentHide(a.uid))">
          <Icon name="minimize" :size="14" />
          <span class="opt-text"><strong>Esconder a janela</strong><small>{{ working() ? 'O agente continua trabalhando; acompanhe por aqui.' : 'A conversa continua por aqui; volte quando quiser.' }}</small></span>
        </button>
        <button type="button" class="ghost opt" :class="{ cur: a.background }" @click="run(api.agentBackground(a.uid, !a.background))">
          <Icon name="layers" :size="14" />
          <span class="opt-text"><strong>Segundo plano</strong><small>Fechar a janela só a esconde; o agente não para.</small></span>
          <Icon v-if="a.background" name="check" :size="14" class="ok" />
        </button>
        <button type="button" class="ghost opt bad" @click="run(api.agentClose([a.uid]))">
          <Icon name="x" :size="14" />
          <span class="opt-text"><strong>Fechar a janela</strong><small>{{ working() ? 'Interrompe o agente. A conversa fica em Conversas.' : 'A conversa fica em Conversas.' }}</small></span>
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.win-menu { display: inline-flex; flex: none; }
.win-btn { color: var(--faint); opacity: 0; }
.win-menu.on .win-btn, .win-menu.hidden .win-btn, .win-menu.bg .win-btn { opacity: 1; }
.win-menu.hidden .win-btn { color: var(--mod); }
.win-menu.bg:not(.hidden) .win-btn { color: var(--accent); }
.win-pop {
  position: fixed; z-index: 60; display: flex; flex-direction: column; gap: 2px; padding: 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}
.win-pop h6 { margin: 2px 6px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.opt { justify-content: flex-start; gap: 10px; height: auto; padding: 7px 8px; width: 100%; text-align: left; color: var(--text); }
.opt.cur { background: var(--accent-soft); }
.opt.bad:hover { color: var(--del); }
.opt-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.opt-text strong { font-size: 12.5px; }
.opt-text small { font-size: 11px; color: var(--muted); white-space: normal; }
.opt .ok { color: var(--accent); flex: none; }
</style>
