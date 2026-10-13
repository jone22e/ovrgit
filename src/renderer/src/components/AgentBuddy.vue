<script setup lang="ts">
/**
 * O mascote do app em miniatura, no canto do cartão do agente (Configurações → Indicador do agente trabalhando →
 * Mascote). Trabalhando: balança de leve, olha em volta, pisca, e o balão azul com pontinhos acompanha, como no
 * mascote do topo da tela. Esperando você: arregala os olhos e o balão vira o "?" laranja. Parado (sem sinal do
 * agente há tempo demais): cochila, de olhos quase fechados e sem balão.
 */
defineProps<{
  mood: 'working' | 'waiting' | 'stalled'
  /** Diferencia os gradientes de cada cartão (ids do SVG são globais na página) */
  uid: string
  /** Altura em pixels */
  size?: number
}>()
</script>

<template>
  <svg class="abuddy" :class="mood" viewBox="0 0 36 30" :height="size ?? 28" :width="(size ?? 28) * 1.2" aria-hidden="true">
    <defs>
      <linearGradient :id="`abskin-${uid}`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e9e9ea" />
        <stop offset="0.55" stop-color="#c9ced6" />
        <stop offset="1" stop-color="#7fa6cf" />
      </linearGradient>
      <radialGradient :id="`abshine-${uid}`" cx="0.35" cy="0.25" r="0.6">
        <stop offset="0" stop-color="#fff" stop-opacity="0.55" />
        <stop offset="1" stop-color="#fff" stop-opacity="0" />
      </radialGradient>
    </defs>
    <g class="body">
      <circle cx="19" cy="16" r="11" :fill="`url(#abskin-${uid})`" />
      <circle cx="19" cy="16" r="11" :fill="`url(#abshine-${uid})`" />
      <g class="eyes">
        <rect class="eye" x="13.6" y="13" width="3" height="6.2" rx="1.5" fill="#1b1d22" />
        <rect class="eye" x="21.4" y="13" width="3" height="6.2" rx="1.5" fill="#1b1d22" />
      </g>
    </g>
    <!-- balão: o que ele está fazendo -->
    <g v-if="mood === 'working'" class="bubble">
      <circle cx="6.5" cy="8" r="5.2" fill="#2f7cf6" />
      <circle class="bd" cx="4.2" cy="8" r="0.95" fill="#fff" />
      <circle class="bd" cx="6.5" cy="8" r="0.95" fill="#fff" />
      <circle class="bd" cx="8.8" cy="8" r="0.95" fill="#fff" />
    </g>
    <g v-else-if="mood === 'waiting'" class="bubble">
      <circle cx="6.5" cy="8" r="5.2" fill="#f08a2d" />
      <text x="6.5" y="10.4" text-anchor="middle" font-size="7.2" font-weight="700" fill="#fff" font-family="system-ui, -apple-system, sans-serif">?</text>
    </g>
  </svg>
</template>

<style scoped>
.abuddy { display: block; flex: none; overflow: visible; }
.body { animation: bob 2.8s ease-in-out infinite; }
.eyes { animation: look 7s ease-in-out infinite; }
.eye { transform-box: fill-box; transform-origin: center; animation: blink 4.6s steps(1) infinite; }
/* esperando você: olhos arregalados, parados */
.waiting .eye { animation: none; transform: scale(1.12); }
/* parado: cochila */
.stalled .eyes { animation: none; }
.stalled .eye { animation: none; transform: translateY(2px) scaleY(0.22); }
.stalled .body { animation-duration: 5s; }
.bubble { transform-origin: 6.5px 8px; animation: pop 0.25s ease-out; }
/* os pontinhos acendem um de cada vez, da esquerda para a direita */
.bd { animation: dots 1.2s steps(1) infinite; }
.bd:nth-child(3) { animation-delay: -0.8s; }
.bd:nth-child(4) { animation-delay: -0.4s; }
@keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
@keyframes look { 0%, 28%, 100% { transform: translateX(0); } 36%, 56% { transform: translateX(1.6px); } 66%, 90% { transform: translateX(-1.6px); } }
@keyframes blink { 0%, 93%, 100% { transform: scaleY(1); } 94%, 98% { transform: scaleY(0.1); } }
@keyframes dots { 0%, 33% { opacity: 1; } 34%, 100% { opacity: 0.35; } }
@keyframes pop { from { transform: scale(0.4); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .body, .eyes, .eye, .bd, .bubble { animation: none; } }
</style>
