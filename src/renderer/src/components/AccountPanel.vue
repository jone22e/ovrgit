<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { AuthStatus, CliProvider } from '@shared/types'
import { api } from '../store'
import Icon from './Icon.vue'

const props = defineProps<{ provider: CliProvider }>()

const LABEL: Record<CliProvider, { name: string; account: string; install: string; installHint: string }> = {
  claude: {
    name: 'Claude Code',
    account: 'conta Claude',
    install: 'https://claude.com/claude-code',
    installHint: 'Instale o Claude Code (claude.com/claude-code) e reabra esta tela.'
  },
  codex: {
    name: 'Codex CLI',
    account: 'conta ChatGPT',
    install: 'https://github.com/openai/codex',
    installHint: 'Instale com "npm i -g @openai/codex" e reabra esta tela.'
  }
}

const status = ref<AuthStatus | null>(null)
const loggingIn = ref(false)
const url = ref<string | null>(null)
const code = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function load() {
  status.value = null
  error.value = null
  status.value = await api.authStatus(props.provider)
}

async function login() {
  error.value = null
  url.value = null
  code.value = ''
  loggingIn.value = true
  await api.authLogin(props.provider)
}

async function sendCode() {
  if (!code.value.trim()) return
  await api.authSendCode(code.value)
  code.value = ''
}

async function cancel() {
  loggingIn.value = false
  await api.authCancel()
}

async function logout() {
  busy.value = true
  try {
    status.value = await api.authLogout(props.provider)
  } finally {
    busy.value = false
  }
}

const off = api.onAuthEvent((e) => {
  if (!loggingIn.value) return
  if (e.type === 'url') url.value = e.url
  else if (e.type === 'done') {
    loggingIn.value = false
    if (e.status) status.value = e.status
    if (!e.ok) error.value = e.error ?? 'Não foi possível entrar.'
  }
})

onMounted(load)
onUnmounted(() => {
  off()
  if (loggingIn.value) api.authCancel()
})
watch(
  () => props.provider,
  () => {
    if (loggingIn.value) cancel()
    load()
  }
)
</script>

<template>
  <div class="account">
    <div v-if="!status" class="row faint"><span class="spinner" /> Verificando {{ LABEL[provider].name }}…</div>

    <template v-else-if="!status.installed">
      <p class="bad">{{ LABEL[provider].name }} não encontrado.</p>
      <p class="faint">{{ LABEL[provider].installHint }}</p>
      <div class="row">
        <button class="small" @click="api.openExternal(LABEL[provider].install)">
          <Icon name="external" :size="13" /> Como instalar
        </button>
        <button class="small ghost" @click="load">Verificar de novo</button>
      </div>
    </template>

    <template v-else-if="loggingIn">
      <p><span class="spinner inline" /> Conclua o login da sua {{ LABEL[provider].account }} no navegador.</p>
      <div class="row">
        <button v-if="url" class="small" @click="api.openExternal(url)">
          <Icon name="external" :size="13" /> Abrir navegador de novo
        </button>
        <button class="small ghost" @click="cancel">Cancelar</button>
      </div>
      <p class="faint">Se a página mostrar um código, cole aqui:</p>
      <form class="row" @submit.prevent="sendCode">
        <input v-model="code" type="text" class="mono" placeholder="código de autorização" spellcheck="false" />
        <button class="small primary" type="submit" :disabled="!code.trim()">Enviar</button>
      </form>
    </template>

    <template v-else>
      <div class="row">
        <span class="dot" :class="status.loggedIn ? 'ok' : 'off'" />
        <span v-if="status.loggedIn">
          Conectado<span v-if="status.detail" class="muted"> · {{ status.detail }}</span>
        </span>
        <span v-else class="muted">Não conectado</span>
        <span class="spacer" />
        <button v-if="status.loggedIn" class="small ghost" :disabled="busy" @click="logout">Sair</button>
        <button v-else class="small primary" @click="login">Entrar com a {{ LABEL[provider].account }}</button>
      </div>
      <p v-if="!status.loggedIn" class="faint">
        O login usa sua assinatura, sem API key. O navegador vai abrir para você autorizar.
      </p>
    </template>

    <p v-if="error" class="bad">{{ error }}</p>
  </div>
</template>

<style scoped>
.account {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2);
}
.row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
p { margin: 0; font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--add); }
.dot.off { background: var(--faint); }
.bad { color: var(--del); }
.inline { display: inline-block; vertical-align: -2px; margin-right: 4px; width: 12px; height: 12px; }
input { height: 28px; font-size: 12px; }
</style>
