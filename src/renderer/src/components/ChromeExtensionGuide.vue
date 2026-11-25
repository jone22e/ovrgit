<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { ChromeExtensionSetup } from '@shared/types'
import { api } from '../store'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const setup = ref<ChromeExtensionSetup | null>(null)
const error = ref('')
const busy = ref(false)
const copied = ref('')
let timer: ReturnType<typeof setInterval> | undefined
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function refresh() {
  try { setup.value = await api.chromeExtensionSetup() }
  catch (e) { error.value = clean(e) }
}
async function action(kind: 'folder' | 'path') {
  busy.value = true; error.value = ''; copied.value = ''
  try {
    if (kind === 'folder') await api.chromeExtensionPrepare()
    else { await api.chromeExtensionCopyFolder(); copied.value = 'Caminho da pasta copiado.' }
  } catch (e) { error.value = clean(e) }
  finally { busy.value = false }
}
async function close() {
  if (busy.value) return
  try { if (setup.value) await api.chromeExtensionAcknowledge(setup.value.revision); emit('close') }
  catch (e) { error.value = clean(e) }
}
onMounted(() => { void refresh(); timer = setInterval(() => { void refresh() }, 2000) })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <Modal title="Extensão do Chrome incluída no Ovseer" :width="620" @close="close">
    <p>A extensão já vem com esta versão do aplicativo. Não precisa baixar nada separado; falta carregá-la uma vez no Chrome.</p>
    <p class="update-hint"><strong>Já instalou?</strong> Os arquivos da pasta abaixo foram atualizados pelo Ovseer. Em <code>chrome://extensions</code>, encontre <strong>Ovseer</strong> e clique em <strong>Recarregar</strong> (seta circular).</p>
    <ol>
      <li>
        <strong>Escolha a pasta da extensão.</strong>
        <p>Use esta pasta em “Carregar sem compactação”.</p>
        <input v-if="setup" :value="setup.folder" readonly aria-label="Pasta da extensão" @focus="($event.target as HTMLInputElement).select()" />
        <div class="actions"><button :disabled="busy || !setup" @click="action('folder')">Abrir pasta</button><button class="ghost" :disabled="busy || !setup" @click="action('path')">Copiar caminho</button></div>
      </li>
      <li>
        <strong>Carregue no Chrome.</strong>
        <p>Digite <code>chrome://extensions</code> na barra de endereço, ative <strong>Modo do desenvolvedor</strong>, clique em <strong>Carregar sem compactação</strong> e selecione a pasta acima.</p>
      </li>
      <li>
        <strong>A conexão é automática.</strong>
        <p>Mantenha o Ovseer aberto neste computador. A extensão encontra o aplicativo sozinha, sem código nem configuração. No menu de extensões (peça de quebra-cabeça), fixe <strong>Ovseer</strong> para acessar as autorizações.</p>
        <p class="connection" :class="{ connected: setup?.connected }" role="status">{{ setup?.connected ? '✓ Extensão conectada ao Ovseer.' : 'Aguardando conexão da extensão.' }}</p>
      </li>
      <li>
        <strong>Autorize cada conversa e aba.</strong>
        <p>Quando o agente pedir acesso, abra a extensão, escolha a conversa e a aba e clique em <strong>Autorizar aba</strong>. Use <strong>Interromper</strong>, no popup ou na faixa da página, para revogar o controle.</p>
      </li>
    </ol>
    <p v-if="copied" class="copied" role="status">{{ copied }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p class="later">Abra este guia quando precisar em <strong>Configurações → Agentes → Extensão do Chrome</strong>.</p>
    <template #footer><button class="ghost" :disabled="busy" @click="close">Fechar guia</button></template>
  </Modal>
</template>

<style scoped>
p { margin: 0; line-height: 1.55; }
.update-hint { padding: 10px 12px; background: var(--hover); border: 1px solid var(--border); border-radius: 8px; }
ol { margin: 0; padding-left: 22px; display: grid; gap: 16px; }
li { padding-left: 3px; }
li p { margin: 5px 0 8px; color: var(--muted); }
input { box-sizing: border-box; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: 11px monospace; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
button { padding: 7px 10px; border-radius: 6px; }
code { font-size: 12px; user-select: text; color: var(--text); }
.connection, .later { font-size: 11px; color: var(--muted); }
.connected, .copied { color: var(--accent); }
.error { color: var(--del); }
</style>
