<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { macSimulatorKeyCode, simulatorPoint, type SimulatorCatalog, type SimulatorFrame, type SimulatorInput, type SimulatorPlatform } from '@shared/simulator'
import Icon from './Icon.vue'

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
const copied = ref(false)
const screen = ref<HTMLImageElement>()
const panel = ref<HTMLElement>()
const zoom = ref(1)
const width = ref(Math.max(280, Math.min(520, Number(localStorage.getItem('ovseer.simulator.width')) || 400)))
const devices = computed(() => catalog.value.devices.filter((d) => d.platform === platform.value))
const device = computed(() => devices.value.find((d) => d.id === selected.value))
let disposed = false
let request = 0
let pointer: { id: number; x: number; y: number } | null = null
let resizeCleanup: (() => void) | undefined
let lastMove = 0
let acceptingFrames = false
const offs = [
  api.onSimulatorFrame((frame) => { if (acceptingFrames && frame.deviceId === selected.value && !disposed) { image.value = frame; connected.value = frame.deviceId } }),
  api.onSimulatorError((event) => { if (event.deviceId === selected.value && !disposed) { acceptingFrames = false; error.value = event.message; connected.value = ''; busy.value = false; image.value = null; void api.simulatorDisconnect().catch(() => undefined) } })
]
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
async function changeDevice() { await disconnect(); error.value = ''; zoom.value = 1 }
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
function point(e: PointerEvent) { return screen.value ? simulatorPoint(e.clientX, e.clientY, screen.value.getBoundingClientRect()) : null }
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
  const p = point(e)
  if (!p) return
  pointer = { id: e.pointerId, ...p }
  if (performance.now() - lastMove < 30) return
  lastMove = performance.now()
  input({ type: 'touch', phase: 'move', ...p })
}
function up(e: PointerEvent) {
  if (e.pointerId !== pointer?.id) return
  const p = point(e)
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
function resizeBy(delta: number) { width.value = Math.max(220, Math.min(window.innerWidth - 220, width.value + delta)) }
function resize(e: PointerEvent) {
  if (e.button !== 0) return
  const startX = e.clientX, startWidth = panel.value?.getBoundingClientRect().width ?? width.value
  const move = (event: PointerEvent) => { width.value = Math.max(240, Math.min(window.innerWidth - 220, startWidth + startX - event.clientX)) }
  const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); localStorage.setItem('ovseer.simulator.width', String(width.value)); resizeCleanup = undefined }
  resizeCleanup?.(); resizeCleanup = end
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end)
}
function close() { emit('close') }
onMounted(() => { void refresh() })
onUnmounted(() => { releasePointer(); disposed = true; request++; resizeCleanup?.(); offs.forEach((off) => off()); void api.simulatorDisconnect().catch(() => undefined) })
</script>

<template>
  <aside ref="panel" class="simulator-panel" :style="{ width: `${width}px` }" aria-label="Simuladores">
    <div class="sim-resizer" role="separator" aria-label="Ajustar largura do simulador" aria-orientation="vertical" tabindex="0" @pointerdown.prevent="resize" @keydown.left.prevent="resizeBy(20)" @keydown.right.prevent="resizeBy(-20)" />
    <header class="sim-head">
      <Icon name="smartphone" :size="16" /><strong>Simuladores</strong><span class="spacer" />
      <button type="button" class="ghost icon" title="Atualizar aparelhos" :disabled="loading || busy" @click="refresh"><Icon name="refresh" :size="14" /></button>
      <button type="button" class="ghost icon" title="Fechar simuladores" @click="close"><Icon name="x" :size="15" /></button>
    </header>
    <div class="sim-selectors">
      <label>Plataforma<select v-model="platform" :disabled="busy" @change="changePlatform"><option value="ios">iOS</option><option value="android">Android</option></select></label>
      <label class="sim-device">Aparelho<select v-model="selected" :disabled="busy || !devices.length" @change="changeDevice"><option v-if="!devices.length" value="">Nenhum aparelho</option><option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} · {{ d.runtime }}{{ d.running ? ' · ligado' : '' }}</option></select></label>
    </div>
    <div class="sim-status">
      <small>{{ busy ? 'Iniciando e conectando…' : connected ? `${device?.runtime} · conectado` : device?.runtime ?? platform.toUpperCase() }}</small>
      <button v-if="connected" type="button" class="ghost small" @click="disconnect">Desconectar</button>
      <button v-else type="button" class="primary small" :disabled="busy || !selected" @click="connect">{{ busy ? 'Conectando…' : device?.running ? 'Conectar' : 'Iniciar' }}</button>
      <button v-if="connected || device?.running" type="button" class="ghost icon small" title="Desligar aparelho" :disabled="busy" @click="stopDevice"><Icon name="power" :size="14" /></button>
    </div>
    <p v-if="error" class="sim-error" role="alert">{{ error }}</p>
    <div class="sim-viewport" @contextmenu.prevent>
      <div v-if="image" class="sim-image-wrap" :style="{ width: `${zoom * 100}%`, height: zoom === 1 ? '100%' : 'auto' }">
        <img ref="screen" :src="image.image" :width="image.width" :height="image.height" class="sim-screen" :class="{ 'native-skin': platform === 'ios', zoomed: zoom > 1 }" :alt="`Tela de ${device?.name ?? 'simulador'}`" tabindex="0" draggable="false" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="releasePointer" @lostpointercapture="releasePointer" @keydown="key" @blur="releasePointer" />
      </div>
      <div v-else class="sim-empty">
        <span v-if="busy || loading" class="spinner" /><Icon v-else name="smartphone" :size="36" />
        <strong>{{ busy ? 'Preparando o aparelho' : loading ? 'Buscando aparelhos' : devices.length ? 'Seu app ao lado da conversa' : 'Nenhum aparelho disponível' }}</strong>
        <p>{{ busy ? 'A primeira inicialização pode levar alguns minutos.' : catalog.issues[platform] ?? (devices.length ? 'Escolha um aparelho e conecte para interagir com ele aqui.' : platform === 'ios' ? 'Adicione um simulador iOS no Xcode e atualize a lista.' : 'Crie um aparelho virtual no Android Studio e atualize a lista.') }}</p>
      </div>
    </div>
    <footer class="sim-tools">
      <button v-if="platform === 'android'" type="button" class="ghost icon" title="Voltar" :disabled="!connected" @click="input({ type: 'back' })"><Icon name="undo" :size="16" /></button>
      <button type="button" class="ghost icon" title="Tela inicial do aparelho" :disabled="!connected" @click="input({ type: 'home' })"><Icon name="home" :size="16" /></button>
      <button type="button" class="ghost icon" :title="copied ? 'Captura copiada' : 'Copiar captura da tela'" :disabled="!image" @click="copyScreen"><Icon :name="copied ? 'check' : 'camera'" :size="16" /></button>
      <span class="spacer" /><button type="button" class="ghost icon" title="Diminuir zoom" :disabled="zoom <= 1" @click="zoom = Math.max(1, zoom - 0.25)"><Icon name="minus" :size="15" /></button>
      <button type="button" class="ghost small" title="Ajustar à área disponível" @click="zoom = 1">{{ zoom === 1 ? 'Ajustar' : `${Math.round(zoom * 100)}%` }}</button>
      <button type="button" class="ghost icon" title="Aumentar zoom" :disabled="!image || zoom >= 2.5" @click="zoom = Math.min(2.5, zoom + 0.25)"><Icon name="plus" :size="15" /></button>
    </footer>
    <small v-if="connected" class="sim-hint">Clique na tela para tocar, arrastar ou digitar.</small>
  </aside>
</template>

<style scoped>
.simulator-panel { position: relative; flex: none; display: flex; flex-direction: column; min-width: 220px; max-width: 60%; min-height: 0; border-left: 1px solid var(--border); background: var(--panel); color: var(--text); }
.sim-head { display: flex; gap: 8px; align-items: center; height: 46px; flex: none; padding: 0 12px; border-bottom: 1px solid var(--border); -webkit-app-region: no-drag; }
.sim-head strong { font-size: 12px; font-weight: 600; }
.spacer { flex: 1; }
.sim-selectors { display: flex; gap: 8px; padding: 12px 12px 6px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: var(--muted); min-width: 0; }
.sim-device { flex: 1; }
select { width: 100%; min-width: 0; height: 30px; padding: 0 6px; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.sim-status { display: flex; align-items: center; gap: 8px; padding: 4px 12px 10px; border-bottom: 1px solid var(--border); }
.sim-status small { flex: 1; font-size: 11px; color: var(--muted); }
.sim-error { margin: 8px; padding: 8px; background: color-mix(in srgb, var(--del) 10%, transparent); color: var(--del); font-size: 11px; line-height: 1.5; border-radius: 6px; overflow-wrap: anywhere; max-height: 140px; overflow: auto; }
.sim-viewport { flex: 1; min-height: 0; overflow: auto; padding: 16px; background: var(--bg); }
.sim-image-wrap { display: flex; align-items: center; justify-content: center; min-height: 0; }
.sim-screen { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; border-radius: 20px; box-shadow: 0 0 0 5px #18181b, 0 0 0 6px #52525b; touch-action: none; user-select: none; outline: none; }
.sim-screen.zoomed { width: 100%; max-height: none; }
.sim-screen:focus-visible { box-shadow: 0 0 0 5px #18181b, 0 0 0 7px var(--accent); }
.sim-screen.native-skin { box-shadow: none; }
.sim-screen.native-skin:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.sim-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; height: 100%; padding: 24px; text-align: center; color: var(--muted); }
.sim-empty strong { font-size: 13px; color: var(--text); font-weight: 500; }
.sim-empty p { font-size: 12px; line-height: 1.6; margin: 0; }
.sim-tools { display: flex; align-items: center; gap: 3px; padding: 8px 10px; border-top: 1px solid var(--border); }
.sim-hint { text-align: center; color: var(--faint); font-size: 10px; padding: 0 8px 9px; }
.sim-resizer { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 2; touch-action: none; }
.sim-resizer:hover, .sim-resizer:focus-visible { background: var(--accent-soft); }
</style>
