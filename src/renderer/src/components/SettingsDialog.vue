<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { THEMES } from '@shared/themes'
import { applyTheme } from '../theme'
import type { AiProvider, ProviderStatus } from '@shared/types'
import { api, saveSettings, state } from '../store'
import AccountPanel from './AccountPanel.vue'
import OvseerPanel from './OvseerPanel.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const s = state.settings!

// terminal: salva e aplica na hora (sem depender do botão Salvar)
const termSize = computed(() => state.settings?.terminalFontSize ?? 14)
const termWeight = computed(() => state.settings?.terminalFontWeight ?? 500)
const WEIGHTS = [
  { value: 400, label: 'Normal' },
  { value: 500, label: 'Médio' },
  { value: 600, label: 'Semi-negrito' }
]
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
// Apelidos seguem sempre o modelo mais novo; IDs exatos fixam a versão
const CLAUDE_ALIASES = [
  { id: 'sonnet', label: 'Sonnet: equilíbrio (recomendado)' },
  { id: 'haiku', label: 'Haiku: mais rápido' },
  { id: 'opus', label: 'Opus: mais capaz' },
  { id: 'fable', label: 'Fable: o mais capaz' }
]
// Versões exatas por família, da mais nova para a mais antiga
const CLAUDE_FAMILIES: { family: string; models: { id: string; label: string }[] }[] = [
  {
    family: 'Fable',
    models: [
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-fable-5', label: 'Fable 5' }
    ]
  },
  {
    family: 'Opus',
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
      { id: 'claude-opus-4-1-20250805', label: 'Opus 4.1' },
      { id: 'claude-opus-4-20250514', label: 'Opus 4' }
    ]
  },
  {
    family: 'Sonnet',
    models: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
      { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4' }
    ]
  },
  {
    family: 'Haiku',
    models: [{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }]
  }
]
const CLAUDE_EXACT = CLAUDE_FAMILIES.flatMap((f) => f.models)
const CUSTOM = '__custom__'
const known = new Set(['', ...CLAUDE_ALIASES.map((m) => m.id), ...CLAUDE_EXACT.map((m) => m.id)])
const claudeChoice = ref(known.has(s.claudeModel) ? s.claudeModel : CUSTOM)
const claudeCustom = ref(known.has(s.claudeModel) ? '' : s.claudeModel)
const claudeResolved = computed(() => (claudeChoice.value === CUSTOM ? claudeCustom.value.trim() : claudeChoice.value))
const isAlias = computed(() => CLAUDE_ALIASES.some((m) => m.id === claudeResolved.value))
const codexModel = ref(s.codexModel)
const url = ref(s.ollamaUrl)
const model = ref(s.model)
const models = ref<string[]>([])
const detected = ref<ProviderStatus | null>(null)
const ollamaError = ref('')

const OPTIONS: { id: AiProvider; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude', hint: 'Usa sua assinatura Claude via Claude Code' },
  { id: 'codex', label: 'ChatGPT', hint: 'Usa sua assinatura ChatGPT via Codex CLI' },
  { id: 'ollama', label: 'Ollama', hint: 'Modelo local, nada sai da máquina' },
  { id: 'none', label: 'Sem IA', hint: 'Agrupa por pasta' }
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
  detected.value = await api.detectProviders()
  if (detected.value.ollama) loadModels()
})

function available(id: AiProvider): boolean | null {
  if (!detected.value) return null
  if (id === 'claude') return !!detected.value.claude
  if (id === 'codex') return !!detected.value.codex
  if (id === 'ollama') return detected.value.ollama
  return true
}

async function save() {
  saved = true
  await saveSettings({
    theme: theme.value,
    provider: provider.value,
    claudeModel: claudeResolved.value,
    codexModel: codexModel.value.trim(),
    ollamaUrl: url.value.trim(),
    model: model.value
  })
  emit('close')
}
</script>

<template>
  <Modal title="Configurações" :width="560" @close="emit('close')">
    <div>
      <div class="label">Tema</div>
      <div class="themes">
        <button
          v-for="t in THEMES"
          :key="t.id"
          type="button"
          class="theme"
          :class="{ active: theme === t.id }"
          :title="t.id === 'ovrgit' ? 'Segue o modo claro/escuro do sistema' : t.name"
          @click="pickTheme(t.id)"
        >
          <span
            v-if="t.colors"
            class="swatch"
            :style="{ background: t.colors.bg, borderColor: t.colors.border }"
          >
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

    <div>
      <div class="label">IA usada para agrupar e escrever commits</div>
      <div class="providers">
        <button
          v-for="o in OPTIONS"
          :key="o.id"
          type="button"
          class="provider"
          :class="{ active: provider === o.id }"
          @click="provider = o.id"
        >
          <span class="name">
            {{ o.label }}
            <span v-if="available(o.id) === true && o.id !== 'none'" class="dot ok" title="Encontrado" />
            <span v-else-if="available(o.id) === false" class="dot off" title="Não encontrado" />
          </span>
          <span class="hint">{{ o.hint }}</span>
        </button>
      </div>
    </div>

    <div v-if="provider === 'claude'" class="section">
      <AccountPanel provider="claude" />
      <label for="claude-model">Modelo</label>
      <select id="claude-model" v-model="claudeChoice">
        <optgroup label="Sempre a versão mais recente">
          <option v-for="m in CLAUDE_ALIASES" :key="m.id" :value="m.id">{{ m.label }}</option>
        </optgroup>
        <optgroup v-for="f in CLAUDE_FAMILIES" :key="f.family" :label="`${f.family} · versão fixa`">
          <option v-for="m in f.models" :key="m.id" :value="m.id">{{ m.label }} · {{ m.id }}</option>
        </optgroup>
        <option value="">Padrão da conta</option>
        <option :value="CUSTOM">Outro (digitar o ID)…</option>
      </select>
      <input
        v-if="claudeChoice === CUSTOM"
        v-model="claudeCustom"
        type="text"
        class="mono"
        placeholder="ex.: claude-opus-5-5"
        spellcheck="false"
      />
      <p class="faint">
        Enviado ao Claude Code como <span class="mono">--model {{ claudeResolved || '(padrão)' }}</span>.
        <template v-if="isAlias">O apelido acompanha as versões novas automaticamente.</template>
      </p>
    </div>

    <div v-else-if="provider === 'codex'" class="section">
      <AccountPanel provider="codex" />
      <label for="codex-model">Modelo (opcional)</label>
      <input id="codex-model" v-model="codexModel" type="text" class="mono" placeholder="padrão da conta" spellcheck="false" />
    </div>

    <div v-else-if="provider === 'ollama'" class="section">
      <label for="ollama-url">Endereço do Ollama</label>
      <div class="row">
        <input id="ollama-url" v-model="url" type="text" class="mono" spellcheck="false" @change="loadModels" />
        <button type="button" @click="loadModels">Testar</button>
      </div>
      <p v-if="ollamaError" class="bad">
        Não foi possível conectar ({{ ollamaError }}). Instale em ollama.com e rode <span class="mono">ollama serve</span>.
      </p>
      <p v-else-if="models.length" class="ok">Conectado: {{ models.length }} modelo(s).</p>
      <label for="model">Modelo</label>
      <select v-if="models.length" id="model" v-model="model">
        <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
      </select>
      <input v-else id="model" v-model="model" type="text" class="mono" placeholder="ex.: qwen2.5-coder:7b" spellcheck="false" />
    </div>

    <div>
      <div class="label">Terminal</div>
      <div class="term-card">
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
        <div class="size-row">
          <span>Peso</span>
          <span class="weights">
            <button
              v-for="w in WEIGHTS"
              :key="w.value"
              type="button"
              :class="{ on: termWeight === w.value }"
              :style="{ fontWeight: w.value }"
              @click="saveSettings({ terminalFontWeight: w.value })"
            >
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
      </div>
    </div>

    <div>
      <div class="label">Tarefas</div>
      <OvseerPanel />
    </div>

    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" @click="save">Salvar</button>
    </template>
  </Modal>
</template>

<style scoped>
.label, label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.term-card { display: flex; flex-direction: column; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); }
.size-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.weights { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.weights button { height: 28px; border: 0; background: transparent; padding: 0 10px; font-family: 'Source Code Pro', var(--mono); font-size: 12.5px; }
.weights button.on { background: var(--accent-soft); color: var(--accent); }
.stepper { display: flex; align-items: center; gap: 6px; }
.stepper .icon { width: 32px; height: 32px; font-size: 16px; font-weight: 600; }
.stepper .val { width: 44px; height: 32px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); font-variant-numeric: tabular-nums; }
.themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.theme {
  height: auto; padding: 6px; flex-direction: column; align-items: stretch; gap: 6px; font-weight: 500; font-size: 12px;
}
.theme.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.swatch {
  display: flex; flex-direction: column; justify-content: space-between; height: 46px; border-radius: 6px;
  border: 1px solid; overflow: hidden;
}
.swatch .bar { height: 14px; display: flex; align-items: center; padding: 0 6px; }
.swatch .pill { width: 22px; height: 5px; border-radius: 3px; }
.swatch .dots { display: flex; gap: 4px; padding: 0 6px 7px; }
.swatch .dots i { width: 7px; height: 7px; border-radius: 50%; }
.swatch.system { flex-direction: row; border-color: var(--border); }
.half { flex: 1; display: flex; align-items: flex-end; padding: 0 6px 8px; }
.half.light { background: #f6f5f8; }
.half.dark { background: #15131a; }
.half .pill { background: #a974f8; }
.theme-name { text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.providers { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.provider {
  height: auto; padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  white-space: normal;
}
.provider.active { border-color: var(--accent); background: var(--accent-soft); }
.provider .name { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.provider .hint { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.dot { width: 7px; height: 7px; border-radius: 50%; }
.dot.ok { background: var(--add); }
.dot.off { background: var(--faint); }
.section { display: flex; flex-direction: column; gap: 6px; }
.section label { margin: 6px 0 0; }
.row { display: flex; gap: 8px; }
p { margin: 0; font-size: 12px; }
.path { display: block; margin-top: 2px; font-size: 11px; word-break: break-all; }
.ok { color: var(--add); }
.bad { color: var(--del); }
</style>
