<script setup lang="ts">
import { computed } from 'vue'
import type { AgentContext } from '@shared/types'

/**
 * Bateria de contexto: quanto da janela de contexto do agente ainda está livre. Cheia no começo, esvazia conforme
 * a conversa cresce. Com mais de 80% livre, ou logo depois de o CLI compactar a conversa (a bateria "recarrega"),
 * fica na cor do tema com o raio; abaixo disso, cinza; vermelha quando resta pouco. Fica ao lado do batimento,
 * no rodapé do cartão.
 */
const props = defineProps<{ context: AgentContext }>()
const usedFrac = computed(() => Math.min(1, Math.max(0, props.context.used / Math.max(1, props.context.window))))
const left = computed(() => 1 - usedFrac.value)
const tone = computed(() => (props.context.compacted || left.value > 0.8 ? 'charged' : left.value <= 0.15 ? 'low' : 'ok'))
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const title = computed(() => {
  const pct = Math.round(usedFrac.value * 100)
  return `Contexto: ${pct}% usado (${k(props.context.used)} de ${k(props.context.window)} tokens)${props.context.compacted ? ' · compactado nesta vez' : ''}`
})
/* a carga: largura do preenchimento dentro do corpo (12 unidades úteis); com algo livre, pelo menos um fio */
const fill = computed(() => (left.value <= 0 ? 0 : Math.max(1, Math.round(12 * left.value * 10) / 10)))
</script>

<template>
  <span class="bat-wrap" :class="tone" :title="title">
    <svg class="bat" viewBox="0 0 20 12" width="20" height="12" role="img" :aria-label="title">
      <title>{{ title }}</title>
      <rect class="body" x="0.75" y="0.75" width="15.5" height="10.5" rx="2.5" />
      <rect class="nub" x="17.25" y="3.5" width="2" height="5" rx="1" />
      <rect class="charge" x="2.5" y="2.5" :width="fill" height="7" :rx="fill < 2 ? 0 : 1" />
      <path v-if="tone === 'charged'" class="bolt" d="M9.5 1.5 6 7h2.4l-.9 3.5L11 5H8.6z" />
    </svg>
  </span>
</template>

<style scoped>
.bat-wrap { display: inline-flex; align-items: center; flex: none; color: var(--faint); }
.bat { display: block; flex: none; }
.body { fill: none; stroke: currentColor; stroke-width: 1.3; }
.nub, .charge { fill: currentColor; opacity: 0.8; }
.bat-wrap.low { color: var(--del); }
.bat-wrap.charged { color: var(--accent); }
.bat-wrap.charged .charge { opacity: 0.3; }
.bolt { fill: var(--accent); stroke: var(--panel); stroke-width: 0.7; paint-order: stroke; }
</style>
