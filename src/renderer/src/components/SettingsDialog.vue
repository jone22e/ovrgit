<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { CLAUDE_ALIASES, CLAUDE_EXACT, CLAUDE_FAMILIES } from '@shared/models'
import { THEMES } from '@shared/themes'
import { applyTheme } from '../theme'
import type { AgentEffort, AiProvider, KnownModels, ProviderStatus } from '@shared/types'
import { api, saveSettings, state } from '../store'
import AccountPanel from './AccountPanel.vue'
import Icon from './Icon.vue'
import ModelPicker from './ModelPicker.vue'
import OvseerPanel from './OvseerPanel.vue'
import AwsPanel from './AwsPanel.vue'

/** Configurações: menu lateral com seções, conteúdo largo. Aparência e terminal aplicam na hora; o resto no Salvar. */
const emit = defineEmits<{ close: [] }>()
const s = state.settings!

type Section = 'general' | 'commits' | 'agents' | 'terminal' | 'tasks' | 'aws'
const SECTIONS: { id: Section; label: string; icon: 'settings' | 'sparkles' | 'bot' | 'terminal' | 'task' | 'cloud' }[] = [
  { id: 'general', label: 'Geral', icon: 'settings' },
  { id: 'commits', label: 'IA dos commits', icon: 'sparkles' },
  { id: 'agents', label: 'Agentes', icon: 'bot' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'tasks', label: 'Tarefas', icon: 'task' },
  { id: 'aws', label: 'AWS', icon: 'cloud' }
]
const section = ref<Section>((localStorage.getItem('ovseer.settings.section') as Section) || 'general')
function go(id: Section) {
  section.value = id
  try {
    localStorage.setItem('ovseer.settings.section', id)
  } catch {
    /* só nesta sessão */
  }
}

async function toggleAgents(on: boolean) {
  await api.setWatchAgents(on)
  state.settings = await api.getSettings()
  if (!on) state.agents = []
}

// atualização do app: salva e aplica na hora
const update = computed(() => state.update)
const updateText = computed(() => {
  const u = update.value
  if (!u) return ''
  if (u.status === 'unsupported') return 'Disponível só no app instalado.'
  if (u.status === 'checking') return 'Procurando versão nova…'
  if (u.status === 'available') return `Versão ${u.version} disponível.`
  if (u.status === 'downloading') return `Baixando a versão ${u.version ?? 'nova'}… ${u.percent ?? 0}%`
  if (u.status === 'ready') return `Versão ${u.version} pronta para instalar.`
  if (u.status === 'error') return u.error ?? 'Não foi possível verificar.'
  return u.checkedAt ? 'Você está na versão mais recente.' : ''
})
async function checkUpdate() {
  state.update = await api.updateCheck()
}

// terminal: salva e aplica na hora (sem depender do botão Salvar)
const termSize = computed(() => state.settings?.terminalFontSize ?? 14)
const termWeight = computed(() => state.settings?.terminalFontWeight ?? 500)
const WEIGHTS = [
  { value: 400, label: 'Normal' },
  { value: 500, label: 'Médio' },
  { value: 600, label: 'Semi-negrito' }
]
// fonte da janela do agente: salva na hora, como a do terminal
const agentSize = computed(() => state.settings?.agentFontSize ?? 14)
function setAgentSize(n: number) {
  saveSettings({ agentFontSize: Math.min(Math.max(n, 11), 22) })
}
function setTerminalFont(name: string) {
  saveSettings({ terminalFont: name.trim() || 'Source Code Pro' })
}
function setTerminalSize(n: number) {
  saveSettings({ terminalFontSize: Math.min(Math.max(n, 9), 28) })
}

// tema: prévia ao vivo; se sair sem salvar, volta ao tema salvo
const theme = ref(s.theme)
let saved = false
function pickTheme(id: string) {
  theme.value = id
  applyTheme(id)
}
onUnmounted(() => {
  if (!saved) applyTheme(state.settings?.theme)
})
const provider = ref<AiProvider>(s.provider)
const CUSTOM = '__custom__'
const known = new Set(['', ...CLAUDE_ALIASES.map((m) => m.id), ...CLAUDE_EXACT.map((m) => m.id)])
const claudeChoice = ref(known.has(s.claudeModel) ? s.claudeModel : CUSTOM)
const claudeCustom = ref(known.has(s.claudeModel) ? '' : s.claudeModel)
const claudeResolved = computed(() => (claudeChoice.value === CUSTOM ? claudeCustom.value.trim() : claudeChoice.value))
const isAlias = computed(() => CLAUDE_ALIASES.some((m) => m.id === claudeResolved.value))
const codexModel = ref(s.codexModel)
const agyModel = ref(s.agyModel ?? '')
// o seletor de modelo pede um esforço; aqui não é usado
const dummyEffort = ref<AgentEffort>('high')
// provedor fixo de cada seletor (o botão de escolher a IA já está acima)
const commitCodex = ref<'codex'>('codex')
const commitAgy = ref<'agy'>('agy')
const knownModels = ref<KnownModels | null>(null)
const agentInstructions = ref(s.agentInstructions ?? '')
const url = ref(s.ollamaUrl)
const model = ref(s.model)
const models = ref<string[]>([])
const detected = ref<ProviderStatus | null>(null)
const ollamaError = ref('')

const OPTIONS: { id: AiProvider; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude', hint: 'Usa sua assinatura Claude via Claude Code' },
  { id: 'codex', label: 'ChatGPT', hint: 'Usa sua assinatura ChatGPT via Codex CLI' },
  { id: 'agy', label: 'Antigravity', hint: 'Usa sua conta Google via Antigravity CLI' },
  { id: 'ollama', label: 'Ollama', hint: 'Modelo local, nada sai da máquina' }
]

async function loadModels() {
  ollamaError.value = ''
  try {
    await saveSettings({ ollamaUrl: url.value.trim() })
    models.value = await api.listModels()
    if (!model.value && models.value.length) model.value = models.value[0]
  } catch (e) {
    models.value = []
    ollamaError.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  }
}

onMounted(async () => {
  ;[detected.value, knownModels.value] = await Promise.all([api.detectProviders(), api.knownModels().catch(() => null)])
  if (detected.value.ollama) loadModels()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('close')

function available(id: AiProvider): boolean | null {
  if (!detected.value) return null
  if (id === 'claude') return !!detected.value.claude
  if (id === 'codex') return !!detected.value.codex
  if (id === 'agy') return !!detected.value.agy
  if (id === 'ollama') return detected.value.ollama
  return true
}

/** Pendências que só entram no Salvar (aparência e terminal aplicam na hora) */
const dirty = computed(
  () =>
    theme.value !== s.theme ||
    provider.value !== s.provider ||
    claudeResolved.value !== s.claudeModel ||
    codexModel.value.trim() !== s.codexModel ||
    agyModel.value.trim() !== (s.agyModel ?? '') ||
    agentInstructions.value.trim() !== (s.agentInstructions ?? '').trim() ||
    url.value.trim() !== s.ollamaUrl ||
    model.value !== s.model
)

async function save() {
  saved = true
  await saveSettings({
    theme: theme.value,
    provider: provider.value,
    claudeModel: claudeResolved.value,
    codexModel: codexModel.value.trim(),
    agyModel: agyModel.value.trim(),
    agentInstructions: agentInstructions.value.trim().slice(0, 20000),
    ollamaUrl: url.value.trim(),
    model: model.value
  })
  emit('close')
}
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <aside class="nav">
        <div class="nav-title">Configurações</div>
        <button v-for="sec in SECTIONS" :key="sec.id" type="button" class="nav-item" :class="{ on: section === sec.id }" @click="go(sec.id)">
          <Icon :name="sec.icon" :size="15" />
          {{ sec.label }}
        </button>
      </aside>

      <div class="main">
        <button class="ghost icon close" title="Fechar (Esc)" @click="emit('close')"><Icon name="x" :size="16" /></button>

        <div class="content">
          <!-- Geral -->
          <template v-if="section === 'general'">
            <h2>Aparência</h2>
            <div class="block">
              <div class="row-head">
                <div>
                  <strong>Tema</strong>
                  <p>O padrão segue o modo claro/escuro do sistema. Os demais fixam a paleta e as cores do terminal.</p>
                </div>
              </div>
              <div class="themes">
                <button
                  v-for="t in THEMES"
                  :key="t.id"
                  type="button"
                  class="theme"
                  :class="{ active: theme === t.id }"
                  :title="t.id === 'ovseer' ? 'Segue o modo claro/escuro do sistema' : t.name"
                  @click="pickTheme(t.id)"
                >
                  <span v-if="t.colors" class="swatch" :style="{ background: t.colors.bg, borderColor: t.colors.border }">
                    <span class="bar" :style="{ background: t.colors.panel }">
                      <span class="pill" :style="{ background: t.colors.accent }" />
                    </span>
                    <span class="dots">
                      <i :style="{ background: t.colors.add }" /><i :style="{ background: t.colors.del }" />
                      <i :style="{ background: t.colors.mod }" /><i :style="{ background: t.colors.hunk }" />
                    </span>
                  </span>
                  <span v-else class="swatch system">
                    <span class="half light"><span class="pill" /></span>
                    <span class="half dark"><span class="pill" /></span>
                  </span>
                  <span class="theme-name">{{ t.name }}</span>
                </button>
              </div>
            </div>

            <h2>Atualização</h2>
            <div class="block">
              <div class="row-head">
                <div>
                  <strong>Ovseer {{ update?.current }}</strong>
                  <p :class="{ bad: update?.status === 'error' }">{{ updateText }}</p>
                </div>
                <button v-if="update?.status === 'ready'" type="button" class="primary" @click="api.updateInstall()">Reiniciar e atualizar</button>
                <button v-else-if="update?.status === 'available'" type="button" @click="api.updateDownload()">Baixar</button>
                <button
                  v-else
                  type="button"
                  :disabled="!update || ['unsupported', 'checking', 'downloading'].includes(update.status)"
                  @click="checkUpdate"
                >
                  Verificar agora
                </button>
              </div>
              <label class="switch-row">
                <div>
                  <strong>Atualizar automaticamente</strong>
                  <p>Procura versões novas ao abrir o app, a cada 30 minutos e ao voltar a ele, e baixa em segundo plano. A instalação acontece ao reiniciar.</p>
                </div>
                <input type="checkbox" class="switch" :checked="state.settings?.autoUpdate !== false" @change="saveSettings({ autoUpdate: ($event.target as HTMLInputElement).checked })" />
              </label>
            </div>
          </template>

          <!-- IA dos commits -->
          <template v-else-if="section === 'commits'">
            <h2>IA dos commits</h2>
            <div class="block">
              <div class="row-head">
                <div>
                  <strong>Qual IA agrupa as alterações e escreve as mensagens</strong>
                  <p>Só para "Analisar com IA", a mensagem de commit, a revisão e a resolução de conflitos. Não afeta os agentes.</p>
                </div>
              </div>
              <div class="providers">
                <button v-for="o in OPTIONS" :key="o.id" type="button" class="provider" :class="{ active: provider === o.id }" @click="provider = o.id">
                  <span class="name">
                    {{ o.label }}
                    <span v-if="available(o.id) === true" class="dot ok" title="Encontrado" />
                    <span v-else-if="available(o.id) === false" class="dot off" title="Não encontrado" />
                  </span>
                  <span class="hint">{{ o.hint }}</span>
                </button>
              </div>
              <p class="tip">
                <Icon name="zap" :size="14" />
                <span>
                  Aqui um modelo rápido e barato costuma bastar: agrupar arquivos e escrever mensagens de commit não pede muito
                  raciocínio, e a resposta chega em segundos. Guarde os modelos mais fortes para os agentes.
                </span>
              </p>
            </div>

            <div v-if="provider === 'claude'" class="block">
              <AccountPanel provider="claude" />
              <div class="field">
                <label for="claude-model">Modelo</label>
                <select id="claude-model" v-model="claudeChoice">
                  <optgroup label="Sempre a versão mais recente">
                    <option v-for="m in CLAUDE_ALIASES" :key="m.id" :value="m.id">{{ m.label }}</option>
                  </optgroup>
                  <optgroup v-for="f in CLAUDE_FAMILIES" :key="f.family" :label="`${f.family} · versão fixa`">
                    <option v-for="m in f.models" :key="m.id" :value="m.id">{{ m.label }}</option>
                  </optgroup>
                  <option value="">Padrão da conta</option>
                  <option :value="CUSTOM">Outro (digitar o ID)…</option>
                </select>
                <input v-if="claudeChoice === CUSTOM" v-model="claudeCustom" type="text" class="mono" placeholder="ex.: claude-opus-5-5" spellcheck="false" />
                <p v-if="isAlias" class="faint">O apelido acompanha as versões novas automaticamente.</p>
              </div>
            </div>

            <div v-else-if="provider === 'codex'" class="block">
              <AccountPanel provider="codex" />
              <div class="field">
                <ModelPicker v-model:provider="commitCodex" v-model:model="codexModel" v-model:effort="dummyEffort" inline no-effort :known="knownModels" />
              </div>
            </div>

            <div v-else-if="provider === 'agy'" class="block">
              <AccountPanel provider="agy" />
              <div class="field">
                <ModelPicker v-model:provider="commitAgy" v-model:model="agyModel" v-model:effort="dummyEffort" inline no-effort :known="knownModels" />
              </div>
            </div>

            <div v-else-if="provider === 'ollama'" class="block">
              <div class="field">
                <label for="ollama-url">Endereço do Ollama</label>
                <div class="row">
                  <input id="ollama-url" v-model="url" type="text" class="mono" spellcheck="false" @change="loadModels" />
                  <button type="button" @click="loadModels">Testar</button>
                </div>
                <p v-if="ollamaError" class="bad">
                  Não foi possível conectar ({{ ollamaError }}). Instale em ollama.com e rode <span class="mono">ollama serve</span>.
                </p>
                <p v-else-if="models.length" class="ok">Conectado: {{ models.length }} modelo(s).</p>
              </div>
              <div class="field">
                <label for="model">Modelo</label>
                <select v-if="models.length" id="model" v-model="model">
                  <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
                </select>
                <input v-else id="model" v-model="model" type="text" class="mono" placeholder="ex.: qwen2.5-coder:7b" spellcheck="false" />
              </div>
            </div>
          </template>

          <!-- Agentes -->
          <template v-else-if="section === 'agents'">
            <h2>Agentes</h2>
            <div class="block">
              <div class="row-head">
                <div>
                  <strong>Instruções personalizadas</strong>
                  <p>Vale para toda janela de agente, no Claude, no ChatGPT e no Antigravity, em todos os projetos. Estilo, regras do time, o que evitar.</p>
                </div>
              </div>
              <textarea
                v-model="agentInstructions"
                rows="8"
                placeholder="Ex.: Responda sempre em português. Antes de alterar código, rode os testes da pasta afetada. Nunca faça commit."
                spellcheck="true"
              />
            </div>
            <div class="block">
              <div class="field">
                <label>Fonte da conversa</label>
                <input
                  :value="state.settings?.agentFont"
                  type="text"
                  placeholder="Padrão do sistema"
                  spellcheck="false"
                  list="agent-fonts"
                  @change="saveSettings({ agentFont: ($event.target as HTMLInputElement).value.trim() })"
                />
                <datalist id="agent-fonts">
                  <option value="Inter" />
                  <option value="Helvetica Neue" />
                  <option value="Segoe UI" />
                  <option value="Roboto" />
                  <option value="Georgia" />
                  <option value="Source Code Pro" />
                </datalist>
              </div>
              <div class="size-row">
                <span>Tamanho do texto</span>
                <span class="stepper">
                  <button type="button" class="icon" :disabled="agentSize <= 11" @click="setAgentSize(agentSize - 1)">−</button>
                  <span class="val">{{ agentSize }}</span>
                  <button type="button" class="icon" :disabled="agentSize >= 22" @click="setAgentSize(agentSize + 1)">+</button>
                </span>
              </div>
              <p class="faint">Vazio usa a fonte do sistema. Janelas de agente abertas aplicam ao receber o foco.</p>
            </div>
            <div class="block">
              <label class="switch-row">
                <div>
                  <strong>Avisar quando um agente termina</strong>
                  <p>Mostra um aviso quando um agente aberto pelo Ovseer termina a tarefa e atualiza a lista de alterações do projeto.</p>
                </div>
                <input type="checkbox" class="switch" :checked="state.settings?.watchAgents !== false" @change="toggleAgents(($event.target as HTMLInputElement).checked)" />
              </label>
            </div>
            <div class="block">
              <div class="row-head">
                <div>
                  <strong>Contas</strong>
                  <p>Login dos CLIs usados pelos agentes: Claude Code, Codex e Antigravity.</p>
                </div>
              </div>
              <AccountPanel provider="claude" />
              <AccountPanel provider="codex" />
              <AccountPanel provider="agy" />
            </div>
          </template>

          <!-- Terminal -->
          <template v-else-if="section === 'terminal'">
            <h2>Terminal</h2>
            <div class="block">
              <div class="field">
                <label>Fonte</label>
                <input
                  :value="state.settings?.terminalFont"
                  type="text"
                  placeholder="Source Code Pro"
                  spellcheck="false"
                  list="terminal-fonts"
                  @change="setTerminalFont(($event.target as HTMLInputElement).value)"
                />
                <datalist id="terminal-fonts">
                  <option value="Source Code Pro" />
                  <option value="Menlo" />
                  <option value="SF Mono" />
                  <option value="Consolas" />
                  <option value="Cascadia Mono" />
                  <option value="JetBrains Mono" />
                  <option value="Fira Code" />
                </datalist>
              </div>
              <div class="size-row">
                <span>Peso</span>
                <span class="weights">
                  <button v-for="w in WEIGHTS" :key="w.value" type="button" :class="{ on: termWeight === w.value }" :style="{ fontWeight: w.value }" @click="saveSettings({ terminalFontWeight: w.value })">
                    {{ w.label }}
                  </button>
                </span>
              </div>
              <div class="size-row">
                <span>Tamanho do texto</span>
                <span class="stepper">
                  <button type="button" class="icon" :disabled="termSize <= 9" @click="setTerminalSize(termSize - 1)">−</button>
                  <span class="val">{{ termSize }}</span>
                  <button type="button" class="icon" :disabled="termSize >= 28" @click="setTerminalSize(termSize + 1)">+</button>
                </span>
              </div>
              <p class="faint">Aplica na hora em todas as abas do terminal.</p>
            </div>
          </template>

          <!-- AWS -->
          <template v-else-if="section === 'aws'">
            <h2>AWS</h2>
            <div class="block"><AwsPanel /></div>
          </template>

          <!-- Tarefas -->
          <template v-else>
            <h2>Tarefas</h2>
            <div class="block"><OvseerPanel /></div>
          </template>
        </div>

        <footer class="foot">
          <span v-if="dirty" class="faint pending-note">Há alterações não salvas.</span>
          <span class="spacer" />
          <button @click="emit('close')">Cancelar</button>
          <button class="primary" @click="save">Salvar</button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 50; padding: 24px;
  display: flex; align-items: center; justify-content: center; animation: fade 0.12s ease-out;
}
.dialog {
  width: min(960px, 100%); height: min(680px, 100%); display: flex; overflow: hidden;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  animation: pop 0.14s ease-out;
}
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { transform: scale(0.97); opacity: 0; } }

.nav { width: 200px; flex: none; padding: 16px 10px; border-right: 1px solid var(--border); background: var(--bg); display: flex; flex-direction: column; gap: 2px; }
.nav-title { font-size: 11.5px; color: var(--muted); padding: 4px 10px 10px; }
.nav-item { justify-content: flex-start; gap: 10px; height: 34px; padding: 0 10px; border: 0; background: transparent; border-radius: 8px; font-weight: 500; color: var(--text); }
.nav-item:hover { background: var(--hover); }
.nav-item.on { background: var(--hover); font-weight: 600; }
.nav-item.on svg { color: var(--accent); }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.close { position: absolute; top: 12px; right: 12px; z-index: 1; }
.content { flex: 1; overflow-y: auto; padding: 24px 32px 16px; display: flex; flex-direction: column; gap: 18px; }
h2 { margin: 0; font-size: 16px; }
.block { display: flex; flex-direction: column; gap: 12px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
.block:last-child { border-bottom: 0; }
.row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.row-head strong, .switch-row strong { display: block; font-size: 13.5px; }
.row-head p, .switch-row p { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.45; max-width: 560px; }
.field { display: flex; flex-direction: column; gap: 6px; max-width: 560px; }
.field label, label.plain { font-size: 12px; color: var(--muted); }
.row { display: flex; gap: 8px; }
p { margin: 0; font-size: 12px; }
.ok { color: var(--add); }
.bad { color: var(--del); }
textarea { font-size: 12.5px; line-height: 1.45; max-width: 640px; }

.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; cursor: pointer; }
.switch { appearance: none; width: 38px; height: 22px; border-radius: 11px; background: var(--faint); position: relative; flex: none; cursor: pointer; transition: background 0.15s; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(16px); }

.themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 8px; }
.theme { height: auto; padding: 6px; flex-direction: column; align-items: stretch; gap: 6px; font-weight: 500; font-size: 12px; }
.theme.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.swatch { display: flex; flex-direction: column; justify-content: space-between; height: 46px; border-radius: 6px; border: 1px solid; overflow: hidden; }
.swatch .bar { height: 14px; display: flex; align-items: center; padding: 0 6px; }
.swatch .pill { width: 22px; height: 5px; border-radius: 3px; }
.swatch .dots { display: flex; gap: 4px; padding: 0 6px 7px; }
.swatch .dots i { width: 7px; height: 7px; border-radius: 50%; }
.swatch.system { flex-direction: row; border-color: var(--border); }
.half { flex: 1; display: flex; align-items: flex-end; padding: 0 6px 8px; }
.half.light { background: #f6f5f8; }
.half.dark { background: #1e1e1e; }
.half .pill { background: #a974f8; }
.theme-name { text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.providers { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.tip {
  display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 9px 12px; border-radius: 10px;
  background: var(--accent-soft); color: var(--text); font-size: 12.5px; line-height: 1.45;
}
.tip svg { flex: none; color: var(--accent); margin-top: 2px; }
.provider { height: auto; padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; white-space: normal; }
.provider.active { border-color: var(--accent); background: var(--accent-soft); }
.provider .name { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.provider .hint { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.dot { width: 7px; height: 7px; border-radius: 50%; }
.dot.ok { background: var(--add); }
.dot.off { background: var(--faint); }

.size-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; max-width: 560px; }
.weights { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.weights button { height: 28px; border: 0; background: transparent; padding: 0 10px; font-family: 'Source Code Pro', var(--mono); font-size: 12.5px; }
.weights button.on { background: var(--accent-soft); color: var(--accent); }
.stepper { display: flex; align-items: center; gap: 6px; }
.stepper .icon { width: 32px; height: 32px; font-size: 16px; font-weight: 600; }
.stepper .val { width: 44px; height: 32px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); font-variant-numeric: tabular-nums; }

.foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border); flex: none; }
.spacer { flex: 1; }
.pending-note { font-size: 12px; }
@media (max-width: 720px) {
  .nav { width: 56px; padding: 12px 6px; }
  .nav-title, .nav-item span { display: none; }
  .nav-item { justify-content: center; padding: 0; font-size: 0; }
  .providers { grid-template-columns: 1fr 1fr; }
}
</style>
