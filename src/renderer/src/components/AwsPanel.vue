<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AwsInstallProgress, AwsStatus } from '@shared/types'
import { api, openTerminalTab, saveSettings, state, toast } from '../store'
import Icon from './Icon.vue'

/**
 * Configurações → AWS: instala o AWS CLI (com o plugin do Session Manager), escolhe o perfil, entra por SSO
 * (abre o navegador) e mostra a sessão. O acompanhamento (avisar quando cair) é ligado aqui.
 */
const status = ref<AwsStatus | null>(null)
const loading = ref(true)
const installing = ref<AwsInstallProgress | null>(null)
const loggingIn = ref(false)
const loginLines = ref<string[]>([])
const busy = ref(false)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval>
const offs: (() => void)[] = []

async function load() {
  loading.value = true
  status.value = await api.awsStatus().catch(() => null)
  loading.value = false
}

async function install() {
  installing.value = { step: 'Preparando…', percent: null }
  try {
    await api.awsInstall()
    toast('AWS CLI instalado.')
    await load()
  } catch (e) {
    toast(clean(e))
  } finally {
    installing.value = null
  }
}

async function setProfile(p: string) {
  await saveSettings({ awsProfile: p })
  await load()
}

async function login() {
  const profile = status.value?.profile ?? ''
  loggingIn.value = true
  loginLines.value = []
  try {
    status.value = await api.awsLogin(profile)
    if (status.value.session?.ok) toast(`Conectado à AWS como ${status.value.session.arn.split('/').pop()}.`)
  } catch (e) {
    toast(clean(e))
  } finally {
    loggingIn.value = false
  }
}

async function logout() {
  busy.value = true
  try {
    status.value = await api.awsLogout(status.value!.profile)
  } finally {
    busy.value = false
  }
}

/** Sem perfil configurado: `aws configure sso` é interativo, então vai para o terminal integrado */
function configure() {
  openTerminalTab({ kind: 'local', command: 'aws configure sso' })
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** Linha do login que vale a pena mostrar: a URL e o código a conferir */
const loginHint = computed(() => {
  const code = loginLines.value.find((l) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(l.trim()))
  const url = loginLines.value.find((l) => /^https?:\/\//.test(l.trim()))
  return { code: code?.trim(), url: url?.trim() }
})
const expiresIn = computed(() => {
  const s = status.value?.session
  if (!s?.ok || !s.expiresAt) return ''
  const ms = s.expiresAt - now.value
  if (ms <= 0) return 'expirada'
  const h = Math.floor(ms / 3600_000)
  const m = Math.round((ms % 3600_000) / 60_000)
  return h ? `expira em ${h} h ${m} min` : `expira em ${m} min`
})
const who = computed(() => {
  const s = status.value?.session
  return s?.ok ? s.arn.replace(/^arn:aws:(sts|iam)::\d+:(assumed-role|user|role)\//, '') : ''
})

onMounted(() => {
  load()
  tick = setInterval(() => (now.value = Date.now()), 30_000)
  offs.push(api.onAwsInstallProgress((p) => (installing.value = p)))
  offs.push(api.onAwsLoginOutput((line) => loginLines.value.push(line)))
  offs.push(api.onAwsChanged((s) => (status.value = s)))
})
onUnmounted(() => {
  clearInterval(tick)
  offs.forEach((f) => f())
})
</script>

<template>
  <div class="aws">
    <!-- instalação -->
    <div class="row-head">
      <div>
        <strong>AWS CLI</strong>
        <p v-if="loading">Procurando o AWS CLI…</p>
        <p v-else-if="status?.installed">
          <span class="ok">Instalado</span> · versão {{ status.installed }}
          <template v-if="status.sessionManager"> · Session Manager <span class="ok">ok</span></template>
          <template v-else> · <span class="bad">plugin do Session Manager não encontrado</span></template>
        </p>
        <p v-else>Não encontrado. O instalador oficial da AWS baixa o CLI e o plugin do Session Manager; o sistema pede sua senha para instalar.</p>
      </div>
      <button v-if="!loading && (!status?.installed || !status.sessionManager)" type="button" class="primary" :disabled="!!installing" @click="install">
        <span v-if="installing" class="spinner" />
        {{ status?.installed ? 'Instalar o Session Manager' : 'Instalar AWS CLI' }}
      </button>
      <button v-else-if="!loading" type="button" :disabled="loading" @click="load">Verificar</button>
    </div>
    <p v-if="installing" class="progress faint">
      {{ installing.step }}<template v-if="installing.percent !== null"> · {{ installing.percent }}%</template>
    </p>

    <template v-if="status?.installed">
      <!-- perfil -->
      <div class="field">
        <label for="aws-profile">Perfil</label>
        <div class="row">
          <select v-if="status.profiles.length" id="aws-profile" :value="status.profile" @change="setProfile(($event.target as HTMLSelectElement).value)">
            <option v-for="p in status.profiles" :key="p" :value="p">{{ p }}{{ p === 'default' ? ' (padrão)' : '' }}</option>
          </select>
          <input v-else id="aws-profile" type="text" class="mono" disabled placeholder="nenhum perfil ainda" />
          <button type="button" title="Abre o terminal com 'aws configure sso' para criar um perfil por SSO (IAM Identity Center)" @click="configure">Perfil por SSO…</button>
        </div>
        <p v-if="!status.profiles.length" class="faint">Sem perfil, "Entrar na AWS" usa a conta do console (<span class="mono">aws login</span>) e cria o perfil padrão.</p>
        <p v-if="status.profile && status.auth === 'static'" class="faint">Este perfil usa chaves fixas: não há login a fazer, só a chave no ~/.aws/credentials.</p>
        <p v-else-if="status.profile" class="faint">Entra pelo navegador com <span class="mono">{{ status.auth === 'sso' ? 'aws sso login' : 'aws login' }}</span>.</p>
      </div>

      <!-- sessão -->
      <div class="row-head">
        <div>
          <strong>Sessão</strong>
          <p v-if="!status.profile">Entre com a conta do console da AWS pelo navegador.</p>
          <p v-else-if="status.session?.ok">
            <span class="ok">Conectado</span> · {{ who }} · conta {{ status.session.account }}<template v-if="expiresIn"> · {{ expiresIn }}</template>
          </p>
          <p v-else-if="status.session" class="bad">{{ status.session.error }}</p>
          <p v-else>Sem informação da sessão.</p>
        </div>
        <div class="acts">
          <template v-if="!status.profile || status.auth !== 'static'">
            <button v-if="loggingIn" type="button" @click="api.awsCancelLogin()"><span class="spinner" /> Esperando o navegador… cancelar</button>
            <button v-else-if="!status.session?.ok" type="button" class="primary" @click="login"><Icon name="external" :size="13" /> Entrar na AWS</button>
            <template v-else>
              <button type="button" :disabled="busy" @click="login">Entrar de novo</button>
              <button type="button" :disabled="busy" @click="logout">Sair</button>
            </template>
          </template>
          <button v-else-if="status.profile" type="button" :disabled="loading" @click="load">Verificar</button>
        </div>
      </div>
      <p v-if="loggingIn && (loginHint.code || loginHint.url)" class="login-hint">
        O navegador abriu para você entrar.
        <template v-if="loginHint.code"> Confira o código <kbd>{{ loginHint.code }}</kbd> na página.</template>
        <template v-if="loginHint.url"> Se não abriu: <a @click.prevent="api.openExternal(loginHint.url!)">{{ loginHint.url }}</a></template>
      </p>

      <label class="switch-row">
        <div>
          <strong>Avisar quando a sessão cair</strong>
          <p>Confere a sessão a cada 5 minutos. Se ela expirar, ou estiver a 15 minutos de expirar, você recebe um aviso para entrar de novo.</p>
        </div>
        <input type="checkbox" class="switch" :checked="state.settings?.awsWatch !== false" @change="saveSettings({ awsWatch: ($event.target as HTMLInputElement).checked })" />
      </label>
    </template>
  </div>
</template>

<style scoped>
.aws { display: flex; flex-direction: column; gap: 14px; }
.row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.row-head strong, .switch-row strong { display: block; font-size: 13.5px; }
.row-head p, .switch-row p { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.45; max-width: 560px; }
.row-head button, .acts button { flex: none; white-space: nowrap; }
.acts { display: flex; gap: 6px; flex: none; }
.field { display: flex; flex-direction: column; gap: 6px; max-width: 560px; }
.field label { font-size: 12px; color: var(--muted); }
.field .faint { margin: 0; font-size: 12px; }
.row { display: flex; gap: 8px; }
.row select, .row input { flex: 1; min-width: 0; }
.ok { color: var(--add); }
.bad { color: var(--del); }
.progress { margin: -6px 0 0; font-size: 12.5px; }
.login-hint { margin: -4px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.login-hint kbd { font-family: var(--mono); font-size: 12px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
.login-hint a { color: var(--accent); cursor: pointer; }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; cursor: pointer; }
.switch { appearance: none; width: 38px; height: 22px; border-radius: 11px; background: var(--faint); position: relative; flex: none; cursor: pointer; transition: background 0.15s; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(16px); }
.spinner { width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
