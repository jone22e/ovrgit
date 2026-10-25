<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { VoiceStatus } from '@shared/types'
import Icon from './Icon.vue'

defineEmits<{ close: [] }>()
const api = window.ovseer
const status = ref<VoiceStatus | null>(null)
const token = ref('')
const progress = ref('')
const error = ref('')
const busy = ref(false)
const queued = ref(false)
const offs: (() => void)[] = []
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function refresh() {
  try { status.value = await api.voiceStatus() }
  catch (e) { error.value = clean(e) }
}
async function install() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  progress.value = 'Verificando a instalação…'
  try { status.value = await api.voiceInstall(token.value || undefined) }
  catch (e) { error.value = clean(e); await refresh() }
  finally { token.value = ''; busy.value = false }
}
async function test() {
  error.value = ''
  try { await api.voiceTest() }
  catch (e) { error.value = clean(e) }
}
onMounted(() => {
  void refresh()
  offs.push(api.onVoiceProgress((message) => { progress.value = message }))
  offs.push(api.onVoiceQueue((state) => { if (state.uid === '__test__') queued.value = state.pending > 0 }))
  offs.push(api.onVoiceError((state) => { if (state.uid === '__test__') error.value = state.message }))
})
onUnmounted(() => offs.forEach((off) => off()))
</script>

<template>
  <div class="voice-shade" @click.self="$emit('close')">
    <section class="voice-dialog" role="dialog" aria-modal="true" aria-label="Configurar voz local">
      <header><strong>Voz local · Phonon 40M PT</strong><button class="ghost icon" title="Fechar" @click="$emit('close')"><Icon name="x" :size="16" /></button></header>
      <p>O app instala o Phonon e baixa o modelo uma vez. Depois, as respostas são geradas neste computador, sem enviar texto para um serviço de voz.</p>
      <div v-if="status" class="voice-checks">
        <span>{{ status.platform }} · {{ status.arch }}</span>
        <span>{{ status.installed ? '✓' : '○' }} Phonon instalado</span>
        <span>{{ status.modelReady ? '✓' : '○' }} Modelo q8 em cache</span>
        <span>{{ status.voiceReady ? '✓' : '○' }} Voz Isadora em cache</span>
      </div>
      <p v-if="status && !status.supported" class="voice-error">Voz local desativada neste sistema. O suporte atual é para macOS e Linux ARM64/x64.</p>
      <template v-if="status && !status.ready && status.supported">
        <label for="hf-token">Token do Hugging Face{{ status.modelReady ? ' (opcional)' : ' para o primeiro download' }}</label>
        <input id="hf-token" v-model="token" type="password" autocomplete="off" placeholder="HF_TOKEN" />
        <small>Aceite os termos na <a href="#" @click.prevent="api.openExternal('https://huggingface.co/gradium/phonon-40m-pt')">página do modelo</a> antes do primeiro download. Se HF_TOKEN já estiver no ambiente, deixe vazio. O token digitado é usado só no download e não é salvo pelo Ovseer.</small>
      </template>
      <p class="voice-license">O modelo Phonon 40M PT é CC BY-NC 4.0 e não permite uso comercial. A voz Isadora é do catálogo Apache 2.0. O modelo é baixado separadamente e não entra no pacote do Ovseer.</p>
      <p v-if="progress" class="voice-progress">{{ progress }}</p>
      <p v-if="error" class="voice-error">{{ error }}</p>
      <footer>
        <button v-if="status?.ready" class="ghost" @click="queued ? api.voiceCancel('__test__') : test()">{{ queued ? 'Interromper teste' : 'Testar voz' }}</button>
        <button v-else-if="status?.supported" :disabled="busy" @click="install">{{ busy ? 'Instalando…' : 'Instalar e configurar' }}</button>
        <button class="ghost" @click="$emit('close')">Fechar</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.voice-shade { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; background: #0009; }
.voice-dialog { width: min(460px, calc(100vw - 32px)); padding: 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); color: var(--text); box-shadow: 0 18px 60px #0007; font-size: 12px; }
.voice-dialog header, .voice-dialog footer { display: flex; align-items: center; gap: 8px; }
.voice-dialog header { justify-content: space-between; font-size: 14px; }
.voice-dialog p { line-height: 1.5; }
.voice-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 14px 0; color: var(--muted); }
.voice-dialog label { display: block; margin: 14px 0 5px; }
.voice-dialog input { box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--background); color: var(--text); }
.voice-dialog small { display: block; margin-top: 5px; color: var(--faint); }
.voice-dialog a { color: var(--accent); cursor: pointer; }
.voice-license { padding: 8px; border-radius: 7px; background: var(--hover); color: var(--muted); }
.voice-progress { color: var(--accent); }
.voice-error { color: var(--del); }
.voice-dialog footer { justify-content: flex-end; margin-top: 18px; }
.voice-dialog button { padding: 6px 10px; border-radius: 7px; cursor: pointer; }
</style>
