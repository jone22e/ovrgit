<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Service, ServiceState } from '@shared/types'
import { api, state, toast } from '../store'
import Icon from './Icon.vue'

/** Ícone dos serviços na barra do topo: contador dos ativos e um menu com play/stop, portas e terminal. */
const open = ref(false)
const root = ref<HTMLElement>()
const states = ref<ServiceState[]>([])
const busy = ref<string | null>(null)
const services = computed(() => state.settings?.services ?? [])
const stateOf = (id: string) => states.value.find((s) => s.id === id)
const running = computed(() => services.value.filter((s) => stateOf(s.id)?.status === 'running'))
/** Ativos primeiro, depois os outros na ordem cadastrada */
const ordered = computed(() => [...running.value, ...services.value.filter((s) => stateOf(s.id)?.status !== 'running')])

async function start(s: Service) {
  busy.value = s.id
  try {
    await api.serviceStart(s.id)
  } catch (e) {
    toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  } finally {
    busy.value = null
  }
}
async function stop(s: Service) {
  busy.value = s.id
  try {
    await api.serviceStop(s.id)
  } finally {
    busy.value = null
  }
}
function manage() {
  open.value = false
  state.showServices = true
}

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
const offs: (() => void)[] = []
onMounted(async () => {
  document.addEventListener('mousedown', onDoc)
  states.value = await api.servicesStates().catch(() => [])
  offs.push(api.onServicesChanged((s) => (states.value = s)))
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  offs.forEach((f) => f())
})
</script>

<template>
  <div ref="root" class="services nodrag">
    <button class="ghost icon" :class="{ on: open, live: running.length }" :title="running.length ? `${running.length} serviço(s) rodando` : 'Serviços'" @click="open = !open">
      <Icon name="server" />
      <span v-if="running.length" class="count">{{ running.length }}</span>
    </button>
    <div v-if="open" class="menu">
      <div class="head">
        <strong>Serviços</strong>
        <small class="faint">{{ running.length ? `${running.length} rodando` : 'nenhum rodando' }}</small>
      </div>
      <p v-if="!services.length" class="faint none">Nenhum serviço cadastrado.</p>
      <div v-for="s in ordered" :key="s.id" class="row" :class="stateOf(s.id)?.status">
        <span class="dot" :class="stateOf(s.id)?.status" />
        <span class="text">
          <span class="name ellipsis">{{ s.name }}</span>
          <span v-if="stateOf(s.id)?.ports?.length" class="ports">
            <button v-for="p in stateOf(s.id)!.ports" :key="p" type="button" class="port" :title="`Abrir http://localhost:${p}`" @click="api.openExternal(`http://localhost:${p}`)">:{{ p }}</button>
          </span>
          <small v-else class="faint ellipsis">{{ stateOf(s.id)?.status === 'running' ? (stateOf(s.id)?.lastLine || 'rodando') : stateOf(s.id)?.status === 'exited' ? 'encerrado' : 'parado' }}</small>
        </span>
        <button v-if="stateOf(s.id)?.status === 'running'" type="button" class="ghost icon small" title="Parar" :disabled="busy === s.id" @click="stop(s)"><Icon name="stop" :size="13" /></button>
        <button v-else type="button" class="ghost icon small play" title="Iniciar" :disabled="busy === s.id" @click="start(s)"><Icon name="play" :size="13" /></button>
        <button type="button" class="ghost icon small" title="Ver o terminal" @click="api.serviceOpenWindow(s.id)"><Icon name="terminal" :size="13" /></button>
      </div>
      <button type="button" class="ghost item" @click="manage"><Icon name="settings" :size="13" /> Gerenciar serviços…</button>
    </div>
  </div>
</template>

<style scoped>
.services { position: relative; flex: none; }
.nodrag, button { -webkit-app-region: no-drag; }
.icon { position: relative; }
.icon.on { color: var(--accent); background: var(--accent-soft); }
.icon.live { color: var(--add); }
.count {
  position: absolute; top: 3px; right: 3px; min-width: 14px; height: 14px; padding: 0 4px; border-radius: 999px;
  display: inline-grid; place-items: center; font-size: 9.5px; font-weight: 700; font-family: var(--mono);
  background: var(--add); color: var(--bg); box-shadow: 0 0 0 2px var(--panel);
}
.menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: 340px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px; animation: drop 0.12s ease-out;
}
@keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
.head { display: flex; align-items: baseline; justify-content: space-between; padding: 6px 10px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.head strong { font-size: 13px; }
.head small { font-size: 11.5px; }
.none { margin: 8px 10px 10px; font-size: 12.5px; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 10px; border-radius: 8px; min-width: 0; }
.row:hover { background: var(--hover); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); opacity: 0.5; }
.dot.running { background: var(--add); opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--add) 25%, transparent); }
.dot.exited { background: var(--mod); opacity: 1; }
.text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.name { font-size: 13px; font-weight: 600; }
.text small { font-size: 11.5px; }
.ports { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.port {
  height: 20px; padding: 0 7px; border-radius: 999px; font-family: var(--mono); font-size: 11px; font-weight: 700;
  color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); border: 1px solid color-mix(in srgb, var(--add) 40%, transparent);
}
.port:hover { background: color-mix(in srgb, var(--add) 24%, transparent); }
.small { width: 26px; height: 26px; color: var(--muted); flex: none; }
.small:hover { color: var(--text); }
.small.play { color: var(--add); }
.item { justify-content: flex-start; gap: 8px; height: 32px; padding: 0 10px; font-weight: 500; color: var(--muted); border-top: 1px solid var(--border); border-radius: 0 0 8px 8px; margin-top: 4px; }
.item:hover { color: var(--text); }
</style>
