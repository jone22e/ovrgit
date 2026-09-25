<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AiProvider, ProviderStatus } from '@shared/types'
import { api, saveSettings, state } from '../store'
import AccountPanel from './AccountPanel.vue'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const s = state.settings!
const provider = ref<AiProvider>(s.provider)
const claudeModel = ref(s.claudeModel)
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
  await saveSettings({
    provider: provider.value,
    claudeModel: claudeModel.value.trim(),
    codexModel: codexModel.value.trim(),
    ollamaUrl: url.value.trim(),
    model: model.value
  })
  emit('close')
}
</script>

<template>
  <Modal title="Configurações" :width="520" @close="emit('close')">
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
      <select id="claude-model" v-model="claudeModel">
        <option value="sonnet">Sonnet (recomendado)</option>
        <option value="haiku">Haiku (mais rápido)</option>
        <option value="opus">Opus (mais capaz)</option>
        <option value="">Padrão da conta</option>
      </select>
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

    <template #footer>
      <button @click="emit('close')">Cancelar</button>
      <button class="primary" @click="save">Salvar</button>
    </template>
  </Modal>
</template>

<style scoped>
.label, label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
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
