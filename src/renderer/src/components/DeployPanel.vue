<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { DeployAuthSetup, DeployAuthStatus } from '@shared/types'
import { api, toast } from '../store'
import Icon from './Icon.vue'

/**
 * Configurações → Deploy: verificação em duas etapas com o aplicativo autenticador do telefone (Google
 * Authenticator, Authy, 1Password…). Ativar mostra um QR code e pede o primeiro código para confirmar;
 * depois disso, iniciar ou retomar um deploy e liberar a trava compartilhada exigem o código, em todos os
 * projetos. Desativar também pede o código.
 */
const status = ref<DeployAuthStatus | null>(null)
const setup = ref<DeployAuthSetup | null>(null)
const code = ref('')
const disabling = ref(false)
const busy = ref(false)
const codeInput = ref<HTMLInputElement>()
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function load() {
  status.value = await api.deployAuthStatus().catch(() => null)
}

async function begin() {
  busy.value = true
  try {
    setup.value = await api.deployAuthBegin()
    code.value = ''
    setTimeout(() => codeInput.value?.focus(), 50)
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = false
  }
}

async function confirm() {
  if (!/^\d{6}$/.test(code.value.replace(/\s/g, ''))) return
  busy.value = true
  try {
    status.value = await api.deployAuthConfirm(code.value.replace(/\s/g, ''))
    setup.value = null
    code.value = ''
    toast('Verificação em duas etapas ativada.')
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = false
  }
}

async function disable() {
  if (!/^\d{6}$/.test(code.value.replace(/\s/g, ''))) return
  busy.value = true
  try {
    status.value = await api.deployAuthDisable(code.value.replace(/\s/g, ''))
    disabling.value = false
    code.value = ''
    toast('Verificação em duas etapas desativada.')
  } catch (e) {
    toast(cleanErr(e))
  } finally {
    busy.value = false
  }
}

function cancel() {
  setup.value = null
  disabling.value = false
  code.value = ''
}

onMounted(load)
</script>

<template>
  <div class="deploy-panel">
    <div class="row-head">
      <div>
        <strong>Verificação em duas etapas</strong>
        <p v-if="!status">Verificando…</p>
        <p v-else-if="status.enabled">
          <span class="ok">Ativada</span> · iniciar ou retomar um deploy e liberar a trava compartilhada pedem o código do aplicativo autenticador, em todos os projetos.
        </p>
        <p v-else>
          Desativada. Com ela ativada, o botão Deploy só inicia, retoma ou libera a trava depois de você digitar o código de 6 dígitos do aplicativo autenticador do telefone.
        </p>
      </div>
      <template v-if="status && !setup && !disabling">
        <button v-if="status.enabled" type="button" @click="disabling = true; code = ''">Desativar</button>
        <button v-else type="button" class="primary" :disabled="busy" @click="begin"><Icon name="shield" :size="13" /> Ativar</button>
      </template>
    </div>

    <!-- ativação: QR + chave + primeiro código -->
    <div v-if="setup" class="setup">
      <div class="qr" v-html="setup.qrSvg" />
      <div class="steps">
        <p><strong>1.</strong> Abra o aplicativo autenticador no telefone (Google Authenticator, Authy, 1Password…) e leia o QR code.</p>
        <p><strong>2.</strong> Se não der para ler, cadastre a chave manualmente: <span class="mono key">{{ setup.secret }}</span></p>
        <p><strong>3.</strong> Digite o código que apareceu para confirmar:</p>
        <form class="row" @submit.prevent="confirm">
          <input ref="codeInput" v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="mono code" placeholder="000 000" spellcheck="false" />
          <button type="submit" class="primary" :disabled="busy || !/^\d{6}$/.test(code.replace(/\s/g, ''))">Concluir ativação</button>
          <button type="button" :disabled="busy" @click="cancel">Cancelar</button>
        </form>
        <p class="faint">A chave fica guardada criptografada pelo sistema, só neste computador. Em outro computador, ative de novo lendo o mesmo QR ou gerando outro.</p>
      </div>
    </div>

    <!-- desativação: pede o código -->
    <form v-if="disabling" class="row disable" @submit.prevent="disable">
      <label>Código do autenticador para desativar</label>
      <input v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="mono code" placeholder="000 000" spellcheck="false" />
      <button type="submit" :disabled="busy || !/^\d{6}$/.test(code.replace(/\s/g, ''))">Desativar</button>
      <button type="button" :disabled="busy" @click="cancel">Cancelar</button>
    </form>
  </div>
</template>

<style scoped>
.deploy-panel { display: flex; flex-direction: column; gap: 14px; }
.row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.row-head strong { display: block; font-size: 13.5px; }
.row-head p { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.45; max-width: 560px; }
.row-head button { flex: none; white-space: nowrap; }
.ok { color: var(--add); }
.setup { display: flex; gap: 18px; align-items: flex-start; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); }
.qr { flex: none; width: 180px; height: 180px; padding: 6px; background: #fff; border-radius: 8px; }
.qr :deep(svg) { width: 100%; height: 100%; display: block; }
.steps { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.steps p { margin: 0; font-size: 12.5px; line-height: 1.5; }
.steps .faint { font-size: 11.5px; }
.key { font-size: 12.5px; letter-spacing: 0.04em; user-select: all; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.code { width: 110px; font-size: 15px; letter-spacing: 0.12em; text-align: center; }
.disable label { font-size: 12px; color: var(--muted); }
</style>
