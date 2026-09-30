<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { CliProvider, CliUpdates, ProviderUsage, UsageInfo, UsageWindow } from '@shared/types'
import { api } from '../store'
import AgentLogo from './AgentLogo.vue'
import Icon from './Icon.vue'

/**
 * Consumo semanal das assinaturas Claude e ChatGPT, como duas barrinhas no cabeçalho.
 * Clique: detalhe por assinatura, com a janela de 5 horas e quando cada limite zera,
 * e se há versão nova do CLI (com um botão que roda o `update` do próprio CLI).
 */
const usage = ref<UsageInfo | null>(null)
const open = ref(false)
const root = ref<HTMLElement>()
const loading = ref(false)
let timer: ReturnType<typeof setInterval>

const updates = ref<CliUpdates | null>(null)
/** CLI sendo atualizado agora */
const updating = ref<CliProvider | null>(null)
const updateError = ref<Partial<Record<CliProvider, string>>>({})
/** Atualizado nesta sessão: mostra a confirmação no lugar do botão */
const updated = ref<Partial<Record<CliProvider, string>>>({})

async function loadUpdates(force = false) {
  try {
    updates.value = await api.cliUpdates(force)
  } catch {
    /* sem rede: não mostra nada */
  }
}
const hasUpdate = computed(() => rows.value.some((r) => updates.value?.[r.id]?.available))

async function runUpdate(id: CliProvider) {
  if (updating.value) return
  updating.value = id
  delete updateError.value[id]
  try {
    const after = await api.cliUpdate(id)
    if (updates.value) updates.value[id] = after
    if (after && !after.available) updated.value[id] = after.current
  } catch (e) {
    updateError.value[id] = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    updating.value = null
  }
}

async function load(force = false) {
  loadUpdates(force)
  loading.value = true
  try {
    usage.value = await api.usage(force)
  } catch {
    /* sem dados: o chip não aparece */
  } finally {
    loading.value = false
  }
}

const rows = computed(() => {
  const u = usage.value
  if (!u) return []
  const list: { id: 'claude' | 'codex' | 'agy'; name: string; u: ProviderUsage }[] = []
  if (u.claude) list.push({ id: 'claude', name: 'Claude', u: u.claude })
  if (u.codex) list.push({ id: 'codex', name: 'ChatGPT', u: u.codex })
  if (u.agy) list.push({ id: 'agy', name: 'Antigravity', u: u.agy })
  return list
})
const visible = computed(() => rows.value.some((r) => r.u.week || r.u.fiveHour))
/** Uso semanal combinado: média das assinaturas com dado (100% das duas = 100%) */
const weekAvg = computed(() => {
  const vals = rows.value.map((r) => r.u.week?.pct).filter((p): p is number => typeof p === 'number')
  return vals.length ? vals.reduce((s, p) => s + p, 0) / vals.length : 0
})
const tone = (pct: number) => (pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '')
/** Comprimento do anel (2πr, r = 8) */
const RING = 2 * Math.PI * 8

function resets(w: UsageWindow | null) {
  if (!w?.resetsAt) return ''
  const ms = w.resetsAt - Date.now()
  if (ms <= 0) return 'zera em instantes'
  const h = Math.floor(ms / 3600_000)
  const m = Math.round((ms % 3600_000) / 60_000)
  if (h >= 24) return `zera em ${Math.floor(h / 24)} d ${h % 24} h`
  return h ? `zera em ${h} h ${m} min` : `zera em ${m} min`
}
const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000)
  return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h`
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function toggle() {
  open.value = !open.value
  if (open.value) load(true)
}
onMounted(() => {
  load()
  timer = setInterval(() => load(), 5 * 60_000)
  document.addEventListener('mousedown', onDoc)
})
onUnmounted(() => {
  clearInterval(timer)
  document.removeEventListener('mousedown', onDoc)
})
</script>

<template>
  <div v-if="visible" ref="root" class="usage">
    <button class="chip" :class="{ on: open }" :title="`Uso semanal das assinaturas (média): ${rows.map((r) => `${r.name} ${Math.round(r.u.week?.pct ?? 0)}%`).join(' · ')}`" @click="toggle">
      <svg class="ring" :class="tone(weekAvg)" viewBox="0 0 20 20" aria-hidden="true">
        <circle class="ring-bg" cx="10" cy="10" r="8" />
        <circle class="ring-fill" cx="10" cy="10" r="8" :stroke-dasharray="`${(Math.max(0, Math.min(100, weekAvg)) / 100) * RING} ${RING}`" />
      </svg>
      <span class="pct">{{ Math.round(weekAvg) }}%</span>
      <span v-if="hasUpdate" class="dot" title="Há versão nova de um CLI" />
    </button>

    <div v-if="open" class="pop">
      <header>
        <strong>Uso das assinaturas</strong>
        <button class="ghost icon small" title="Atualizar" @click="load(true)">
          <span v-if="loading" class="spinner" />
          <Icon v-else name="refresh" :size="13" />
        </button>
      </header>
      <section v-for="r in rows" :key="r.id">
        <div class="who">
          <AgentLogo :source="r.id" :size="14" />
          <strong>{{ r.name }}</strong>
          <span v-if="r.u.plan" class="badge">{{ r.u.plan }}</span>
          <span class="spacer" />
          <small class="faint">{{ ago(r.u.at) }}</small>
        </div>
        <div v-if="updates?.[r.id]" class="ver">
          <small class="faint mono" :title="updates[r.id]!.latest ? `Mais recente: ${updates[r.id]!.latest}` : 'Não foi possível consultar a versão mais recente'">v{{ updates[r.id]!.current }}</small>
          <template v-if="updates[r.id]!.available">
            <small class="new">nova: v{{ updates[r.id]!.latest }}</small>
            <span class="spacer" />
            <button class="upd" :disabled="!!updating" @click="runUpdate(r.id)">
              <span v-if="updating === r.id" class="spinner" />
              <Icon v-else name="down" :size="12" />
              {{ updating === r.id ? 'Atualizando…' : 'Atualizar' }}
            </button>
          </template>
          <small v-else-if="updated[r.id]" class="ok">atualizado</small>
          <small v-else-if="updates[r.id]!.latest" class="faint">em dia</small>
        </div>
        <p v-if="updateError[r.id]" class="bad">{{ updateError[r.id] }}</p>
        <p v-if="r.u.error" class="bad">{{ r.u.error }}</p>
        <template v-else>
          <div v-for="w in (r.id === 'agy' ? [] : ([['Semana', r.u.week], ['5 horas', r.u.fiveHour]] as [string, UsageWindow | null][]))" :key="w[0]" class="line">
            <span class="lbl">{{ w[0] }}</span>
            <template v-if="w[1]">
              <span class="track" :class="tone(w[1].pct)"><span class="fill" :class="r.id" :style="{ width: `${Math.max(1, w[1].pct)}%` }" /></span>
              <span class="num mono">{{ Math.round(w[1].pct) }}%</span>
              <small class="faint reset">{{ resets(w[1]) }}</small>
            </template>
            <small v-else class="faint">sem dado</small>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.usage { position: relative; -webkit-app-region: no-drag; }
.chip { height: 26px; padding: 0 10px 0 6px; gap: 6px; border-radius: 999px; }
.chip.on { background: var(--hover); }
.ring { width: 18px; height: 18px; transform: rotate(-90deg); flex: none; }
.ring circle { fill: none; stroke-width: 3; }
.ring-bg { stroke: var(--panel-2); }
.ring-fill { stroke: var(--accent); stroke-linecap: round; transition: stroke-dasharray 0.3s; }
.ring.warm .ring-fill { stroke: var(--mod); }
.ring.hot .ring-fill { stroke: var(--del); }
.fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.3s; }
.fill.claude { background: #d97757; }
.fill.codex { background: var(--text); opacity: 0.75; }
.track.warm .fill { background: var(--mod); opacity: 1; }
.track.hot .fill { background: var(--del); opacity: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-left: -2px; }
.ver { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.ver .new { color: var(--accent); font-weight: 600; }
.ver .ok { color: var(--add); }
.upd { height: 22px; padding: 0 8px; gap: 5px; font-size: 11.5px; border-radius: 6px; }
.pct { font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--muted); }

.pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 340px; padding: 6px 6px 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
header { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 4px; font-size: 13px; }
.icon.small { width: 26px; height: 26px; }
section { padding: 8px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.who { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.who .badge { height: 18px; font-size: 10px; text-transform: capitalize; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spacer { flex: 1; }
.line { display: grid; grid-template-columns: 56px 1fr 40px auto; align-items: center; gap: 8px; font-size: 12px; }
.lbl { color: var(--muted); }
.track { height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
.num { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.reset { font-size: 11px; white-space: nowrap; }
.bad { margin: 0; font-size: 12px; color: var(--del); }
</style>
