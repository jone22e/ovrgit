<script setup lang="ts">
import { computed } from 'vue'
import { HB_HEIGHT, HB_WIDTH, RHYTHMS, heartbeatPath, heartbeatSpan, type HeartbeatTone } from '@shared/heartbeat'

/**
 * Sinais vitais: o traçado de eletrocardiograma no rodapé do cartão do agente, com um ritmo por estado (ver
 * @shared/heartbeat). O <svg> inteiro rola dentro do invólucro de largura fixa (transformação composta na GPU);
 * as bordas esmaecem com degradês sobrepostos na cor do fundo (`--hb-bg`, por padrão a do painel).
 */
const props = defineProps<{ tone: HeartbeatTone }>()
const rhythm = computed(() => RHYTHMS[props.tone])
const span = computed(() => heartbeatSpan(props.tone))
const d = computed(() => heartbeatPath(props.tone))
/* a animação rola um compasso por ciclo: a distância e a duração vêm do ritmo */
const style = computed(() => ({ '--hb-x': `${-rhythm.value.cell}px`, '--hb-s': `${rhythm.value.seconds}s` }))
</script>

<template>
  <span class="hb" :class="tone" :style="{ width: `${HB_WIDTH}px`, height: `${HB_HEIGHT}px` }" role="img" :aria-label="rhythm.label" :title="rhythm.label">
    <svg class="roll" :class="{ still: !rhythm.seconds }" :width="span" :height="HB_HEIGHT" :viewBox="`0 0 ${span} ${HB_HEIGHT}`" :style="style" aria-hidden="true">
      <path class="trace" :d="d" />
    </svg>
  </span>
</template>

<style scoped>
.hb { position: relative; display: block; flex: none; overflow: hidden; color: var(--faint); opacity: 0.45; }
.hb.live { color: var(--accent); opacity: 1; }
.hb.waiting { color: var(--mod); opacity: 1; }
.hb.done { color: var(--add); opacity: 0.85; }
.hb.stalled { color: var(--del); opacity: 1; }
.hb.error { color: var(--del); opacity: 0.55; }
/* bordas esmaecidas: degradês da cor do fundo por cima do traçado */
.hb::before, .hb::after { content: ''; position: absolute; top: 0; bottom: 0; width: 12px; pointer-events: none; }
.hb::before { left: 0; background: linear-gradient(90deg, var(--hb-bg, var(--panel)), transparent); }
.hb::after { right: 0; background: linear-gradient(270deg, var(--hb-bg, var(--panel)), transparent); }
.roll { display: block; animation: hb-scroll var(--hb-s) linear infinite; will-change: transform; }
.roll.still { animation: none; will-change: auto; }
.trace { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
@keyframes hb-scroll { to { transform: translateX(var(--hb-x)); } }
@media (prefers-reduced-motion: reduce) { .roll { animation: none; will-change: auto; } }
</style>
