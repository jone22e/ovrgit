<script setup lang="ts">
import { computed } from 'vue'
import { closeReview, fileMap, selectFile, state } from '../store'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const r = computed(() => state.review!)
const LABEL = { high: 'Importante', medium: 'Atenção', low: 'Detalhe' } as const
const sorted = computed(() => {
  const order = { high: 0, medium: 1, low: 2 }
  return [...r.value.findings].sort((a, b) => order[a.severity] - order[b.severity])
})
const hasHigh = computed(() => r.value.findings.some((f) => f.severity === 'high'))

function open(file: string) {
  const f = fileMap.value.get(file)
  if (f) selectFile(f)
}
</script>

<template>
  <Modal
    v-if="state.review"
    :title="r.source === 'check' ? 'Antes de salvar, dê uma olhada' : r.findings.length ? 'Revisão da IA' : 'Revisão da IA: tudo certo'"
    :width="560"
    @close="closeReview(false)"
  >
    <p v-if="!r.findings.length" class="ok"><Icon name="check" :size="16" /> Nenhum problema encontrado nas alterações marcadas.</p>
    <p v-else class="muted intro">
      {{ r.source === 'check' ? 'Encontramos pontos que costumam dar dor de cabeça depois de salvos:' : 'Pontos que a IA sugere olhar antes de salvar:' }}
    </p>
    <ul class="list">
      <li v-for="(f, i) in sorted" :key="i" :class="f.severity">
        <span class="sev">{{ LABEL[f.severity] }}</span>
        <div class="txt">
          <button class="file mono" :title="'Ver o arquivo'" @click="open(f.file)">{{ f.file }}<template v-if="f.line">:{{ f.line }}</template></button>
          <p>{{ f.message }}</p>
        </div>
      </li>
    </ul>
    <template #footer>
      <template v-if="r.source === 'check'">
        <button class="primary" @click="closeReview(false)">Voltar e corrigir</button>
        <button :class="{ danger: hasHigh }" @click="closeReview(true)">Salvar mesmo assim</button>
      </template>
      <button v-else class="primary" @click="closeReview(false)">Fechar</button>
    </template>
  </Modal>
</template>

<style scoped>
.intro { margin: -4px 0 0; font-size: 12.5px; }
.ok { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--add); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 50vh; overflow: auto; }
li { display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; background: var(--panel-2); border-left: 3px solid var(--faint); }
li.high { border-left-color: var(--del); }
li.medium { border-left-color: var(--mod); }
.sev { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); flex: none; width: 74px; padding-top: 2px; }
li.high .sev { color: var(--del); }
li.medium .sev { color: var(--mod); }
.txt { min-width: 0; }
.file { height: auto; padding: 0; border: 0; background: none; color: var(--accent); font-size: 12px; font-weight: 600; word-break: break-all; text-align: left; }
.file:hover { text-decoration: underline; background: none !important; }
.txt p { margin: 2px 0 0; font-size: 13px; line-height: 1.5; }
.danger { color: var(--del); }
</style>
