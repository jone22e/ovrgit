<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AwsStatus, Service, ServiceState } from '@shared/types'
import { api, openTerminalTab, state, toast } from '../store'
import Icon from './Icon.vue'

/**
 * Ícone dos serviços na barra do topo: contador dos ativos e um menu com play/stop, portas e terminal.
 * A conexão com a AWS (aws login) é uma linha fixa no topo do menu: entrar abre o navegador, parar encerra a sessão.
 */
const open = ref(false)
const root = ref<HTMLElement>()
const query = ref('')
const searchEl = ref<HTMLInputElement>()
const plain = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const states = ref<ServiceState[]>([])
const busy = ref<string | null>(null)
const services = computed(() => state.settings?.services ?? [])
const stateOf = (id: string) => states.value.find((s) => s.id === id)
const running = computed(() => services.value.filter((s) => stateOf(s.id)?.status === 'running'))
/** Ativos primeiro, depois os outros na ordem cadastrada; a busca filtra por nome, porta ou comando */
const ordered = computed(() => {
  const all = [...running.value, ...services.value.filter((s) => stateOf(s.id)?.status !== 'running')]
  const words = plain(query.value).split(/\s+/).filter(Boolean)
  if (!words.length) return all
  return all.filter((s) => {
    const hay = plain(`${s.name} ${s.command} ${(stateOf(s.id)?.ports ?? []).map((p) => `:${p}`).join(' ')}`)
    return words.every((w) => hay.includes(w))
  })
})
// ---------- AWS: linha fixa no topo ----------
const aws = ref<AwsStatus | null>(null)
const awsLoading = ref(false)
const awsBusy = ref<'login' | 'logout' | null>(null)
const now = ref(Date.now())
async function loadAws() {
  awsLoading.value = true
  aws.value = await api.awsStatus().catch(() => aws.value)
  awsLoading.value = false
  now.value = Date.now()
}
const awsOk = computed(() => !!aws.value?.session?.ok)
/** Chaves fixas não têm "entrar": a sessão vale enquanto as chaves valerem */
const awsCanLogin = computed(() => !!aws.value?.installed && !!aws.value.profile && aws.value.auth !== 'static')
const awsLine = computed(() => {
  const a = aws.value
  if (!a) return awsLoading.value ? 'verificando…' : ''
  if (!a.installed) return 'AWS CLI não instalado'
  if (!a.profile) return 'nenhum perfil configurado'
  if (awsBusy.value === 'login') return 'aguardando o login no navegador…'
  const s = a.session
  if (s?.ok) {
    const who = s.arn.replace(/^arn:aws:(sts|iam)::\d+:(assumed-role|user|role)\//, '').split('/').pop()
    let left = ''
    if (s.expiresAt) {
      const ms = s.expiresAt - now.value
      const h = Math.floor(ms / 3600_000)
      const m = Math.max(0, Math.round((ms % 3600_000) / 60_000))
      left = ms <= 0 ? ' · expirada' : h ? ` · expira em ${h} h ${m} min` : ` · expira em ${m} min`
    }
    return `${a.profile} · ${who}${left}`
  }
  return `${a.profile} · desconectado`
})
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
async function awsLogin() {
  if (!aws.value || awsBusy.value) return
  awsBusy.value = 'login'
  try {
    aws.value = await api.awsLogin(aws.value.profile)
    if (aws.value.session?.ok) toast('Conectado à AWS.')
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    awsBusy.value = null
  }
}
async function awsLogout() {
  if (!aws.value || awsBusy.value) return
  awsBusy.value = 'logout'
  try {
    aws.value = await api.awsLogout(aws.value.profile)
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    awsBusy.value = null
  }
}
/** Abre Configurações já na seção AWS (instalar o CLI, trocar de perfil, acompanhar a sessão) */
function awsSettings() {
  open.value = false
  localStorage.setItem('ovseer.settings.section', 'aws')
  state.showSettings = true
}

function toggle() {
  open.value = !open.value
  if (!open.value) return
  loadAws()
  query.value = ''
  setTimeout(() => searchEl.value?.focus(), 30)
}

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
/** Parados (ou encerrados): os que o "Iniciar todos" sobe, um de cada vez, na ordem cadastrada */
const stopped = computed(() => services.value.filter((s) => stateOf(s.id)?.status !== 'running'))
const startingAll = ref(false)
async function startAll() {
  if (startingAll.value) return
  startingAll.value = true
  const failed: string[] = []
  for (const s of [...stopped.value]) {
    try {
      await api.serviceStart(s.id)
    } catch {
      failed.push(s.name)
    }
  }
  startingAll.value = false
  if (failed.length) toast(`Não deu para iniciar: ${failed.join(', ')}`)
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
  offs.push(api.onAwsChanged((s) => (aws.value = s)))
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  offs.forEach((f) => f())
})
</script>

<template>
  <div ref="root" class="services nodrag">
    <button class="ghost icon" :class="{ on: open, live: running.length }" :title="running.length ? `${running.length} serviço(s) rodando` : 'Serviços'" @click="toggle">
      <Icon name="server" />
      <span v-if="running.length" class="count">{{ running.length }}</span>
    </button>
    <div v-if="open" class="menu">
      <div class="head">
        <strong>Serviços</strong>
        <span class="head-right">
          <button v-if="stopped.length" type="button" class="ghost start-all" :disabled="startingAll" :title="`Inicia os ${stopped.length} serviços parados`" @click="startAll">
            <Icon name="play" :size="10" /> {{ startingAll ? 'Iniciando…' : 'Iniciar todos' }}
          </button>
          <small class="faint">{{ running.length ? `${running.length} rodando` : 'nenhum rodando' }}</small>
        </span>
      </div>
      <!-- conexão com a AWS: fixa no topo, fora da busca -->
      <div class="row aws" :class="{ running: awsOk }">
        <span class="dot" :class="awsOk ? 'running' : aws?.installed && aws.profile ? 'exited' : ''" />
        <span class="text">
          <span class="name ellipsis"><Icon name="cloud" :size="12" class="faint" /> AWS</span>
          <small class="faint ellipsis" :title="aws?.session && !aws.session.ok ? aws.session.error : awsLine">{{ awsLine || 'conexão com a AWS' }}</small>
        </span>
        <span v-if="awsBusy === 'login'" class="spinner" />
        <button v-if="awsBusy === 'login'" type="button" class="ghost icon small" title="Cancelar o login" @click="api.awsCancelLogin()"><Icon name="x" :size="13" /></button>
        <button v-else-if="awsOk && awsCanLogin" type="button" class="ghost icon small" title="Encerrar a sessão da AWS" :disabled="!!awsBusy" @click="awsLogout"><Icon name="stop" :size="13" /></button>
        <button v-else-if="awsCanLogin" type="button" class="ghost icon small play" title="Entrar na AWS (abre o navegador)" :disabled="!!awsBusy" @click="awsLogin"><Icon name="play" :size="13" /></button>
        <button type="button" class="ghost icon small" title="Configurações da AWS" @click="awsSettings"><Icon name="settings" :size="13" /></button>
      </div>
      <label v-if="services.length > 3" class="search">
        <Icon name="search" :size="13" class="faint" />
        <input ref="searchEl" v-model="query" type="text" placeholder="Buscar por nome, porta ou comando" spellcheck="false" @keydown.esc="open = false" />
      </label>
      <div class="rows">
      <p v-if="!services.length" class="faint none">Nenhum serviço cadastrado.</p>
      <p v-else-if="!ordered.length" class="faint none">Nenhum serviço com esse nome.</p>
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
        <button type="button" class="ghost icon small" title="Ver o terminal (aba no painel)" @click="(open = false), openTerminalTab({ kind: 'service', serviceId: s.id })"><Icon name="terminal" :size="13" /></button>
      </div>
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
.head { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.head strong { font-size: 13px; }
.head small { font-size: 11.5px; }
.head-right { display: inline-flex; align-items: center; gap: 10px; }
/* discreto: texto pequeno, só ganha cor ao passar o mouse */
.start-all { height: 20px; padding: 0 6px; gap: 4px; border-radius: 6px; font-size: 11.5px; font-weight: 500; color: var(--muted); }
.start-all:hover:not(:disabled) { color: var(--add); background: color-mix(in srgb, var(--add) 12%, transparent); }
.search { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; margin: 0 0 4px; border-bottom: 1px solid var(--border); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; font-size: 12.5px; color: var(--text); }
.search input:focus { box-shadow: none; }
.rows { max-height: min(60vh, 520px); overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.none { margin: 8px 10px 10px; font-size: 12.5px; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 10px; border-radius: 8px; min-width: 0; }
.row:hover { background: var(--hover); }
.row.aws { border-bottom: 1px solid var(--border); border-radius: 8px 8px 0 0; margin-bottom: 4px; padding-bottom: 8px; }
.row.aws .name { display: inline-flex; align-items: center; gap: 5px; }
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
