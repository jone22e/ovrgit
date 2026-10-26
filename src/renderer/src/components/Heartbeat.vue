<script setup lang="ts">
import { computed } from 'vue'
import { HB_HEIGHT, HB_WIDTH, RHYTHMS, heartbeatPath, heartbeatSpan, type HeartbeatTone } from '@shared/heartbeat'

/**
 * Sinais vitais: o traçado de eletrocardiograma no rodapé do cartão do agente, com um ritmo por estado (ver
 * @shared/heartbeat). O <svg> inteiro rola dentro do invólucro de largura fixa (transformação composta na GPU);
 * as bordas esmaecem pela transparência do traçado, sem depender da cor de fundo do cartão.
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
.hb { position: relative; display: block; flex: none; overflow: hidden; color: var(--faint); opacity: 0.45; mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent); }
.hb.live { color: var(--accent); opacity: 1; }
.hb.waiting { color: var(--mod); opacity: 1; }
.hb.done { color: var(--add); opacity: 0.85; }
.hb.stalled { color: var(--del); opacity: 1; }
.hb.error { color: var(--del); opacity: 0.55; }
.roll { display: block; animation: hb-scroll var(--hb-s) linear infinite; will-change: transform; }
.roll.still { animation: none; will-change: auto; }
.trace { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
@keyframes hb-scroll { to { transform: translateX(var(--hb-x)); } }
@media (prefers-reduced-motion: reduce) { .roll { animation: none; will-change: auto; } }
</style>
