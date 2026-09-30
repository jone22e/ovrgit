<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { DaySummary } from '@shared/types'
import { api, state, toast } from '../store'

/**
 * Resumo do dia no Histórico: quantos agentes, arquivos e deploys, o que ficou pendente (no topo) e o que foi
 * entregue. "Copiar resumo" põe tudo como texto, pronto para a daily.
 */
const sum = ref<DaySummary | null>(null)
onMounted(async () => {
  sum.value = await api.agentDaySummary().catch(() => null)
})

const dayLabel = (ms: number) => `Hoje, ${new Date(ms).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }).replace('.', '')}`
/** Projeto aparece só quando não é o aberto */
const other = (project: string) => project !== state.repo?.name

function asText(s: DaySummary): string {
  const lines = [`${dayLabel(s.day)}`, `${s.agents} agentes · ${s.files} arquivos alterados · ${s.deploys} deploys`]
  if (s.pending.length) lines.push('', 'Ficou pendente:', ...s.pending.map((p) => `- ${p}`))
  if (s.delivered.length)
    lines.push('', 'Entregue:', ...s.delivered.map((d) => `- ${d.title}${other(d.project) ? ` (${d.project})` : ''}${d.detail ? ` · ${d.detail}` : ''}`))
  return lines.join('\n')
}
async function copy() {
  if (!sum.value) return
  try {
    await navigator.clipboard.writeText(asText(sum.value))
    toast('Resumo copiado.')
  } catch {
    toast('Não foi possível copiar.')
  }
}
</script>

<template>
  <section v-if="sum && sum.agents" class="day">
    <header>
      <strong>{{ dayLabel(sum.day) }}</strong>
      <button class="small" title="Copia o resumo como texto, para colar na daily" @click="copy">Copiar resumo</button>
    </header>
    <div class="nums">
      <span><b>{{ sum.agents }}</b><small>{{ sum.agents === 1 ? 'agente' : 'agentes' }}</small></span>
      <span><b>{{ sum.files }}</b><small>{{ sum.files === 1 ? 'arquivo alterado' : 'arquivos alterados' }}</small></span>
      <span><b>{{ sum.deploys }}</b><small>{{ sum.deploys === 1 ? 'deploy' : 'deploys' }}</small></span>
    </div>
    <div v-if="sum.pending.length" class="block">
      <h4 class="pend">Ficou pendente</h4>
      <ul class="pending">
        <li v-for="p in sum.pending" :key="p">{{ p }}</li>
      </ul>
    </div>
    <div v-if="sum.delivered.length" class="block">
      <h4>Entregue</h4>
      <ul class="done">
        <li v-for="(d, i) in sum.delivered" :key="i">
          <span class="ok">✓</span>
          <span class="ellipsis ttl">{{ d.title }}</span>
          <small class="faint">{{ [other(d.project) ? d.project : '', d.detail].filter(Boolean).join(' · ') }}</small>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.day { border: 1px solid var(--border); border-radius: 12px; background: var(--panel); margin-bottom: 20px; overflow: hidden; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
header strong { font-size: 14px; }
.nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.nums span { display: flex; flex-direction: column; gap: 2px; }
.nums b { font-size: 20px; font-variant-numeric: tabular-nums; }
.nums small { font-size: 12px; color: var(--muted); }
.block { padding: 12px 16px 4px; }
.block + .block { padding-top: 4px; }
h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
h4.pend { color: var(--mod); }
ul { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.pending li { position: relative; padding-left: 14px; }
.pending li::before { content: '•'; position: absolute; left: 2px; color: var(--mod); }
.done li { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.done .ok { color: var(--add); flex: none; }
.done .ttl { flex: 1; min-width: 0; }
.done small { font-size: 12px; flex: none; }
</style>
