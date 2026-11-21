<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { macSimulatorKeyCode, simulatorImageSize, simulatorPanelWidth, simulatorPoint, type SimulatorCatalog, type SimulatorDebugProject, type SimulatorFrame, type SimulatorInput, type SimulatorPlatform } from '@shared/simulator'
import Icon from './Icon.vue'

const props = defineProps<{ conversationRoots: string[] }>()
const emit = defineEmits<{ close: [] }>()
const api = window.ovseer
const catalog = ref<SimulatorCatalog>({ devices: [], issues: {} })
const platform = ref<SimulatorPlatform>(api.platform === 'darwin' ? 'ios' : 'android')
const selected = ref('')
const connected = ref('')
const image = ref<SimulatorFrame | null>(null)
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const debugProjects = ref<SimulatorDebugProject[]>([])
const debugBusy = ref(false)
const activeDebug = ref<{ root: string; deviceId: string } | null>(null)
const projectsLoading = ref(false)
const debugMessage = ref('')
const debugServiceId = ref('')
const debugDevices = computed(() => debugProjects.value.filter((p) => p.platforms.includes(platform.value)))
const debugProject = computed(() => debugDevices.value.length === 1 ? debugDevices.value[0] : undefined)
const debugTitle = computed(() => debugBusy.value ? debugMessage.value : projectsLoading.value ? 'Detectando app da conversa…'
  : !props.conversationRoots.length ? 'Abra uma conversa para iniciar seu app'
  : debugDevices.value.length > 1 ? 'Mais de um app encontrado nos repositórios desta conversa'
  : debugProject.value ? `Iniciar ${debugProject.value.name} em modo Debug no aparelho selecionado`
  : `Nenhum app ${platform.value === 'ios' ? 'iOS' : 'Android'} encontrado nos repositórios desta conversa`)
const copied = ref(false)
const screen = ref<HTMLImageElement>()
const panel = ref<HTMLElement>()
const viewport = ref<HTMLElement>()
const zoom = ref(1)
const width = ref(Math.max(220, Number(localStorage.getItem('ovseer.simulator.width')) || 400))
const availableWidth = ref(window.innerWidth)
const viewportSize = ref({ width: 0, height: 0 })
const shownWidth = computed(() => simulatorPanelWidth(width.value, availableWidth.value))
const imageSize = computed(() => image.value ? simulatorImageSize(image.value, viewportSize.value, zoom.value) : { width: 0, height: 0 })
const imageWrapStyle = computed(() => ({ width: `${Math.max(viewportSize.value.width, imageSize.value.width)}px`, height: `${Math.max(viewportSize.value.height, imageSize.value.height)}px` }))
const imageStyle = computed(() => ({ width: `${imageSize.value.width}px`, height: `${imageSize.value.height}px` }))
const devices = computed(() => catalog.value.devices.filter((d) => d.platform === platform.value))
const device = computed(() => devices.value.find((d) => d.id === selected.value))
let disposed = false
let request = 0
let projectRequest = 0
let pointer: { id: number; x: number; y: number } | null = null
let resizeCleanup: (() => void) | undefined
let sizeObserver: ResizeObserver | undefined
let sizeRaf = 0
let lastMove = 0
let acceptingFrames = false
const offs = [
  api.onSimulatorDebugProgress((progress) => {
    const job = activeDebug.value
    if (disposed || !job || progress.root !== job.root || progress.deviceId !== job.deviceId) return
    debugMessage.value = progress.message
    if (progress.serviceId) debugServiceId.value = progress.serviceId
  }),
  api.onSimulatorFrame((frame) => { if (acceptingFrames && frame.deviceId === selected.value && !disposed) { image.value = frame; connected.value = frame.deviceId } }),
  api.onSimulatorError((event) => { if (event.deviceId === selected.value && !disposed) { acceptingFrames = false; error.value = event.message; connected.value = ''; busy.value = false; image.value = null; void api.simulatorDisconnect().catch(() => undefined) } })
]
async function refreshProjects() {
  const version = ++projectRequest
  debugProjects.value = []
  if (!debugBusy.value) clearDebug()
  if (!props.conversationRoots.length) { projectsLoading.value = false; return }
  projectsLoading.value = true
  try {
    const projects = await api.simulatorDebugProjects(props.conversationRoots)
    if (disposed || version !== projectRequest) return
    debugProjects.value = projects
  } catch (e) { if (!disposed && version === projectRequest) error.value = (e as Error).message }
  finally { if (version === projectRequest) projectsLoading.value = false }
}
function clearDebug() { debugMessage.value = ''; debugServiceId.value = '' }
async function startDebug() {
  if (debugBusy.value || busy.value || projectsLoading.value || !debugProject.value || !selected.value) return
  const root = debugProject.value.root, deviceId = selected.value, version = projectRequest
  activeDebug.value = { root, deviceId }
  debugBusy.value = true; error.value = ''; clearDebug()
  debugMessage.value = 'Preparando a depuração…'
  try {
    if (connected.value !== deviceId) await connect()
    if (connected.value !== deviceId || disposed || version !== projectRequest) return
    await api.simulatorDebugStart(root, deviceId)
  } catch (e) {
    if (!disposed) { error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); debugMessage.value = 'Falha ao iniciar o app.' }
  } finally {
    debugBusy.value = false; activeDebug.value = null
    if (version !== projectRequest) clearDebug()
  }
}
async function openDebugLog() {
  try { await api.serviceOpenWindow(debugServiceId.value) }
  catch (e) { error.value = (e as Error).message }
}
watch(() => JSON.stringify([props.conversationRoots, platform.value]), () => { void refreshProjects() }, { immediate: true, flush: 'sync' })
async function refresh() {
  loading.value = true
  try {
    const next = await api.simulatorList()
    if (disposed) return
    catalog.value = next
    if (!devices.value.some((d) => d.id === selected.value)) selected.value = devices.value.find((d) => d.running)?.id ?? devices.value[0]?.id ?? ''
  } catch (e) { error.value = String((e as Error).message) }
  finally { loading.value = false }
}
async function disconnect() {
  request++
  acceptingFrames = false
  releasePointer()
  connected.value = ''; image.value = null; busy.value = false
  await api.simulatorDisconnect().catch(() => undefined)
}
async function changePlatform() {
  await disconnect()
  selected.value = devices.value.find((d) => d.running)?.id ?? devices.value[0]?.id ?? ''
  error.value = ''
}
async function changeDevice() { await disconnect(); error.value = ''; zoom.value = 1; clearDebug() }
async function connect() {
  if (!selected.value) return
  const version = ++request
  acceptingFrames = true
  busy.value = true; error.value = ''; image.value = null; connected.value = ''; zoom.value = 1
  try {
    await api.simulatorConnect(selected.value)
    if (version === request && !disposed) connected.value = selected.value
  } catch (e) {
    if (version === request && !disposed) { acceptingFrames = false; error.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); image.value = null; connected.value = '' }
  } finally { if (version === request) busy.value = false }
}
async function stopDevice() {
  const id = selected.value
  await disconnect()
  busy.value = true; error.value = ''
  try { await api.simulatorStop(id); await refresh() }
  catch (e) { error.value = String((e as Error).message) }
  finally { busy.value = false }
}
function input(event: SimulatorInput) {
  if (!connected.value) return
  void api.simulatorInput(event).catch((e) => { error.value = String((e as Error).message) })
}
function point(e: PointerEvent, clampToScreen = false) { return screen.value ? simulatorPoint(e.clientX, e.clientY, screen.value.getBoundingClientRect(), image.value?.touchArea, clampToScreen) : null }
function down(e: PointerEvent) {
  if (e.button !== 0 || pointer || !connected.value) return
  const p = point(e)
  if (!p) return
  e.preventDefault(); screen.value?.focus(); screen.value?.setPointerCapture(e.pointerId)
  pointer = { id: e.pointerId, ...p }
  input({ type: 'touch', phase: 'down', ...p })
}
function move(e: PointerEvent) {
  if (e.pointerId !== pointer?.id) return
  const p = point(e, true)
  if (!p) return
  pointer = { id: e.pointerId, ...p }
  if (performance.now() - lastMove < 30) return
  lastMove = performance.now()
  input({ type: 'touch', phase: 'move', ...p })
}
function up(e: PointerEvent) {
  if (e.pointerId !== pointer?.id) return
  const p = point(e, true)
  if (p) pointer = { id: e.pointerId, ...p }
  releasePointer()
}
function releasePointer() {
  if (!pointer) return
  const p = pointer; pointer = null
  input({ type: 'touch', phase: 'up', x: p.x, y: p.y })
  if (screen.value?.hasPointerCapture(p.id)) screen.value.releasePointerCapture(p.id)
}
function key(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
  const code = macSimulatorKeyCode(e.code)
  if (e.key.length !== 1 && code === undefined) return
  e.preventDefault(); e.stopPropagation()
  input({ type: 'key', key: e.key, code, shift: e.shiftKey })
}
async function copyScreen() {
  if (!image.value) return
  try { await api.copyImage(image.value.image); copied.value = true; setTimeout(() => { copied.value = false }, 1500) }
  catch (e) { error.value = String((e as Error).message) }
}
function saveWidth() { localStorage.setItem('ovseer.simulator.width', String(shownWidth.value)) }
function resizeBy(delta: number) {
  width.value = simulatorPanelWidth(shownWidth.value + delta, availableWidth.value)
  saveWidth()
}
function resize(e: PointerEvent) {
  if (e.button !== 0) return
  resizeCleanup?.()
  const handle = e.currentTarget as HTMLElement
  const startX = e.clientX, startWidth = shownWidth.value
  const move = (event: PointerEvent) => {
    if (event.pointerId !== e.pointerId) return
    if (!event.buttons) return end()
    width.value = simulatorPanelWidth(startWidth + startX - event.clientX, availableWidth.value)
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    handle.removeEventListener('lostpointercapture', end)
    window.removeEventListener('blur', end)
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
    saveWidth()
    resizeCleanup = undefined
  }
  resizeCleanup = end
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
  handle.addEventListener('lostpointercapture', end)
  window.addEventListener('blur', end)
  handle.setPointerCapture(e.pointerId)
}
function close() { emit('close') }
onMounted(() => {
  const container = panel.value?.parentElement
  if (container) availableWidth.value = container.clientWidth
  let nextWidth = availableWidth.value
  let nextViewport = viewportSize.value
  sizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === container) nextWidth = entry.contentRect.width
      if (entry.target === viewport.value) nextViewport = { width: entry.contentRect.width, height: entry.contentRect.height }
    }
    // Medir e alterar o layout em quadros separados evita realimentar o ResizeObserver.
    cancelAnimationFrame(sizeRaf)
    sizeRaf = requestAnimationFrame(() => {
      availableWidth.value = nextWidth
      viewportSize.value = nextViewport
    })
  })
  if (container) sizeObserver.observe(container)
  if (viewport.value) sizeObserver.observe(viewport.value)
  void refresh()
})
onUnmounted(() => { releasePointer(); disposed = true; request++; resizeCleanup?.(); sizeObserver?.disconnect(); cancelAnimationFrame(sizeRaf); offs.forEach((off) => off()); void api.simulatorDisconnect().catch(() => undefined) })
</script>

<template>
  <aside ref="panel" class="simulator-panel" :style="{ width: `${shownWidth}px` }" aria-label="Simuladores">
    <div class="sim-resizer" role="separator" aria-label="Ajustar largura do simulador" aria-orientation="vertical" tabindex="0" @pointerdown.prevent="resize" @keydown.left.prevent="resizeBy(20)" @keydown.right.prevent="resizeBy(-20)" />
    <header class="sim-head">
      <Icon name="smartphone" :size="16" /><strong>Simuladores</strong><span class="spacer" />
      <button type="button" class="ghost icon sim-debug-play" :title="debugTitle" :aria-label="debugTitle" :disabled="busy || debugBusy || projectsLoading || !selected || !debugProject || api.platform === 'win32'" @click="startDebug"><span v-if="debugBusy" class="spinner" /><Icon v-else name="play" :size="16" /></button>
      <button type="button" class="ghost icon" title="Atualizar aparelhos e projetos" :disabled="loading || busy || debugBusy || projectsLoading" @click="refresh(); refreshProjects()"><Icon name="refresh" :size="14" /></button>
      <button type="button" class="ghost icon" title="Fechar simuladores" @click="close"><Icon name="x" :size="15" /></button>
    </header>
    <div class="sim-selectors">
      <label>Plataforma<select v-model="platform" :disabled="busy || debugBusy" @change="changePlatform"><option value="ios">iOS</option><option value="android">Android</option></select></label>
      <label class="sim-device">Aparelho<select v-model="selected" :disabled="busy || debugBusy || !devices.length" @change="changeDevice"><option v-if="!devices.length" value="">Nenhum aparelho</option><option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} · {{ d.runtime }}{{ d.running ? ' · ligado' : '' }}</option></select></label>
    </div>
    <div class="sim-status">
      <small>{{ busy ? 'Iniciando e conectando…' : connected ? `${device?.runtime} · conectado` : device?.runtime ?? platform.toUpperCase() }}</small>
      <button v-if="connected" type="button" class="ghost small" :disabled="debugBusy" @click="disconnect">Desconectar</button>
      <button v-else type="button" class="primary small" :disabled="busy || debugBusy || !selected" @click="connect">{{ busy ? 'Conectando…' : device?.running ? 'Conectar' : 'Iniciar' }}</button>
      <button v-if="connected || device?.running" type="button" class="ghost icon small" title="Desligar aparelho" :disabled="busy || debugBusy" @click="stopDevice"><Icon name="power" :size="14" /></button>
    </div>
    <div v-if="debugMessage" class="sim-debug-status" role="status"><small>{{ debugMessage }}</small><button v-if="debugServiceId" type="button" class="ghost small" @click="openDebugLog">Ver log</button></div>
    <p v-if="error" class="sim-error" role="alert">{{ error }}</p>
    <div ref="viewport" class="sim-viewport" @contextmenu.prevent>
      <div v-if="image" class="sim-image-wrap" :style="imageWrapStyle">
        <img ref="screen" :src="image.image" :width="image.width" :height="image.height" :style="imageStyle" class="sim-screen" :class="{ 'native-skin': platform === 'ios' }" :alt="`Tela de ${device?.name ?? 'simulador'}`" tabindex="0" draggable="false" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="releasePointer" @lostpointercapture="releasePointer" @keydown="key" @blur="releasePointer" />
      </div>
      <div v-else class="sim-empty">
        <span v-if="busy || loading" class="spinner" /><Icon v-else name="smartphone" :size="36" />
        <strong>{{ busy ? 'Preparando o aparelho' : loading ? 'Buscando aparelhos' : devices.length ? 'Seu app ao lado da conversa' : 'Nenhum aparelho disponível' }}</strong>
        <p>{{ busy ? 'A primeira inicialização pode levar alguns minutos.' : catalog.issues[platform] ?? (devices.length ? 'Escolha um aparelho e conecte para interagir com ele aqui.' : platform === 'ios' ? 'Adicione um simulador iOS no Xcode e atualize a lista.' : 'Crie um aparelho virtual no Android Studio e atualize a lista.') }}</p>
      </div>
    </div>
    <footer class="sim-tools">
      <span class="sim-tool-group">
      <button v-if="platform === 'android'" type="button" class="ghost icon" title="Voltar" :disabled="!connected" @click="input({ type: 'back' })"><Icon name="undo" :size="16" /></button>
      <button type="button" class="ghost icon" title="Tela inicial do aparelho" :disabled="!connected" @click="input({ type: 'home' })"><Icon name="home" :size="16" /></button>
      <button type="button" class="ghost icon" :title="copied ? 'Captura copiada' : 'Copiar captura da tela'" :disabled="!image" @click="copyScreen"><Icon :name="copied ? 'check' : 'camera'" :size="16" /></button>
      </span>
      <span class="sim-tool-group">
      <button type="button" class="ghost icon" title="Diminuir zoom" :disabled="zoom <= 1" @click="zoom = Math.max(1, zoom - 0.25)"><Icon name="minus" :size="15" /></button>
      <button type="button" class="ghost small" title="Ajustar à área disponível" @click="zoom = 1">{{ zoom === 1 ? 'Ajustar' : `${Math.round(zoom * 100)}%` }}</button>
      <button type="button" class="ghost icon" title="Aumentar zoom" :disabled="!image || zoom >= 2.5" @click="zoom = Math.min(2.5, zoom + 0.25)"><Icon name="plus" :size="15" /></button>
      </span>
    </footer>
    <small v-if="connected" class="sim-hint">Clique na tela para tocar, arrastar ou digitar.</small>
  </aside>
</template>

<style scoped>
.simulator-panel { position: relative; flex: none; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--panel); color: var(--text); }
.sim-head { display: flex; gap: 8px; align-items: center; height: 46px; flex: none; padding: 0 12px; border-bottom: 1px solid var(--border); -webkit-app-region: no-drag; }
.sim-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.sim-head button, .sim-status button { flex: none; }
.spacer { flex: 1; }
.sim-selectors { display: flex; gap: 8px; padding: 12px 12px 6px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: var(--muted); min-width: 0; }
.sim-device { flex: 1; }
.sim-debug-play:not(:disabled) { color: var(--accent); }
.sim-debug-play .spinner { width: 12px; height: 12px; }
.sim-debug-status { display: flex; align-items: center; gap: 6px; padding: 6px 12px; }
.sim-debug-status small { flex: 1; min-width: 0; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.sim-debug-status button { flex: none; }
select { width: 100%; min-width: 0; height: 30px; padding: 0 6px; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.sim-status { display: flex; align-items: center; gap: 8px; padding: 4px 12px 10px; border-bottom: 1px solid var(--border); }
.sim-status small { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--muted); }
.sim-error { margin: 8px; padding: 8px; background: color-mix(in srgb, var(--del) 10%, transparent); color: var(--del); font-size: 11px; line-height: 1.5; border-radius: 6px; overflow-wrap: anywhere; max-height: 140px; overflow: auto; }
.sim-viewport { flex: 1; min-height: 0; overflow: auto; padding: 16px; background: var(--bg); }
.sim-image-wrap { display: flex; align-items: center; justify-content: center; min-height: 0; }
.sim-screen { display: block; flex: none; object-fit: contain; border-radius: 20px; box-shadow: 0 0 0 5px #18181b, 0 0 0 6px #52525b; touch-action: none; user-select: none; outline: none; }
.sim-screen:focus-visible { box-shadow: 0 0 0 5px #18181b, 0 0 0 7px var(--accent); }
.sim-screen.native-skin { border-radius: 0; box-shadow: none; }
.sim-screen.native-skin:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.sim-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; height: 100%; padding: 24px; text-align: center; color: var(--muted); }
.sim-empty strong { font-size: 13px; color: var(--text); font-weight: 500; }
.sim-empty p { font-size: 12px; line-height: 1.6; margin: 0; }
.sim-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); }
.sim-tool-group { display: flex; align-items: center; gap: 3px; }
.sim-hint { text-align: center; color: var(--faint); font-size: 10px; padding: 0 8px 9px; }
.sim-resizer { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 2; touch-action: none; }
.sim-resizer:hover, .sim-resizer:focus-visible { background: var(--accent-soft); }
</style>
