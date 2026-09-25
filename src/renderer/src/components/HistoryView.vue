<script setup lang="ts">
import { onMounted } from 'vue'
import { loadHistory, state } from '../store'

onMounted(loadHistory)

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]
]
function relative(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const [unit, secs] = UNITS.find(([, s]) => Math.abs(diff) >= s) ?? ['second', 1]
  return rtf.format(Math.round(diff / secs), unit)
}
</script>

<template>
  <div class="history">
    <div v-if="!state.history.length" class="empty faint">Nenhum commit ainda.</div>
    <ol v-else>
      <li v-for="c in state.history" :key="c.hash" :title="c.hash">
        <span class="dot" />
        <div class="main">
          <div class="subject ellipsis">{{ c.subject }}</div>
          <div class="meta faint">
            <span class="mono">{{ c.short }}</span> · {{ c.author }} · <span :title="new Date(c.date).toLocaleString('pt-BR')">{{ relative(c.date) }}</span>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.history { flex: 1; overflow: auto; background: var(--panel); }
.empty { padding: 48px; text-align: center; }
ol { list-style: none; margin: 0 auto; padding: 16px 24px; max-width: 900px; }
li { display: flex; gap: 14px; padding: 8px 0; position: relative; user-select: text; }
li::before {
  content: ''; position: absolute; left: 5px; top: 0; bottom: 0; width: 2px; background: var(--border);
}
li:first-child::before { top: 16px; }
li:last-child::before { bottom: calc(100% - 16px); }
.dot {
  width: 12px; height: 12px; border-radius: 50%; background: var(--panel);
  border: 2px solid var(--accent); margin-top: 4px; flex: none; z-index: 1;
}
.main { min-width: 0; }
.subject { font-weight: 500; }
.meta { font-size: 12px; }
</style>
