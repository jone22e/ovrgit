<script setup lang="ts">
import { computed } from 'vue'
import { HB_HEIGHT, HB_WIDTH, RHYTHMS, heartbeatPath, type HeartbeatTone } from '@shared/heartbeat'

/** Sinais vitais: o traçado de eletrocardiograma no rodapé do cartão do agente, com um ritmo por estado (ver @shared/heartbeat) */
const props = defineProps<{ tone: HeartbeatTone }>()
const rhythm = computed(() => RHYTHMS[props.tone])
const d = computed(() => heartbeatPath(props.tone))
/* a animação rola um compasso por ciclo: a distância e a duração vêm do ritmo */
const style = computed(() => ({ '--hb-x': `${-rhythm.value.cell}px`, '--hb-s': `${rhythm.value.seconds}s` }))
</script>

<template>
  <svg class="hb" :class="tone" :viewBox="`0 0 ${HB_WIDTH} ${HB_HEIGHT}`" preserveAspectRatio="xMidYMid slice" role="img" :aria-label="rhythm.label">
    <title>{{ rhythm.label }}</title>
    <path class="trace" :class="{ still: !rhythm.seconds }" :d="d" :style="style" />
  </svg>
</template>

<style scoped>
.hb {
  display: block; width: 100%; height: 16px; overflow: hidden; color: var(--faint); opacity: 0.45;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
}
.hb.live { color: var(--accent); opacity: 1; }
.hb.waiting { color: var(--mod); opacity: 1; }
.hb.done { color: var(--add); opacity: 0.85; }
.hb.stalled { color: var(--del); opacity: 1; }
.hb.error { color: var(--del); opacity: 0.55; }
.trace {
  fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke;
  animation: hb-scroll var(--hb-s) linear infinite; will-change: transform;
}
.trace.still { animation: none; }
@keyframes hb-scroll { to { transform: translateX(var(--hb-x)); } }
@media (prefers-reduced-motion: reduce) { .trace { animation: none; } }
</style>
