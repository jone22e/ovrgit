<script setup lang="ts">
import { computed } from 'vue'
import { commit, generateMessage, push, setMessage, state } from '../store'
import Icon from './Icon.vue'

defineEmits<{ feature: []; pull: [] }>()

const nSelected = computed(() => state.selected.size)
const canCommit = computed(() => nSelected.value > 0 && state.message.trim() !== '' && !state.busy)
const mod = window.ovrgit.platform === 'darwin' ? '⌘' : 'Ctrl'

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    if (canCommit.value) commit()
  }
}
</script>

<template>
  <footer class="bar">
    <div class="msg">
      <label for="commit-msg">Mensagem do commit</label>
      <div class="msg-box">
      <textarea
        id="commit-msg"
        :value="state.message"
        rows="2"
        spellcheck="false"
        :placeholder="nSelected ? 'Descreva as alterações…' : 'Selecione arquivos para commitar'"
        @input="setMessage(($event.target as HTMLTextAreaElement).value)"
        @keydown="onKey"
      />
      <button
        class="ghost icon ai-msg"
        :class="{ running: state.busy === 'message' }"
        :disabled="(!!state.busy && state.busy !== 'message') || !nSelected"
        :title="state.busy === 'message' ? 'Gerando… clique para cancelar' : `Gerar mensagem com IA para ${nSelected} arquivo(s) selecionado(s)`"
        @click="generateMessage"
      >
        <span v-if="state.busy === 'message'" class="spinner" />
        <Icon v-else name="sparkles" :size="16" />
      </button>
      </div>
    </div>
    <div class="actions">
      <span v-if="state.repo?.operation" class="op-hint muted">
        Commits ficam bloqueados até concluir ou abortar o {{ state.repo.operation }} (faixa acima).
      </span>
      <template v-else>
      <button class="primary" :disabled="!canCommit" :title="`Commitar ${nSelected} arquivo(s) (${mod}+Enter)`" @click="commit">
        <span v-if="state.busy === 'commit'" class="spinner" />
        <Icon v-else name="commit" />
        Commit<span v-if="nSelected" class="n">{{ nSelected }}</span>
      </button>
      </template>
      <span class="gap" />
      <button :disabled="!!state.busy || !state.repo?.branch || !!state.repo?.operation" title="Mover o trabalho local para uma branch de feature" @click="$emit('feature')">
        <span v-if="state.busy === 'feature'" class="spinner" />
        <Icon v-else name="feature" />
        Criar Feature
      </button>
      <button :disabled="!!state.busy || !!state.repo?.operation" title="Baixar alterações do remoto (git pull)" @click="$emit('pull')">
        <span v-if="state.busy === 'pull'" class="spinner" />
        <Icon v-else name="down" />
        Baixar<span v-if="state.repo?.behind" class="n">{{ state.repo.behind }}</span>
      </button>
      <button :disabled="!!state.busy || !!state.repo?.operation" title="Enviar commits para o remoto (git push)" @click="push">
        <span v-if="state.busy === 'push'" class="spinner" />
        <Icon v-else name="up" />
        Enviar<span v-if="state.repo?.ahead" class="n">{{ state.repo.ahead }}</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.bar {
  flex: none;
  border-top: 1px solid var(--border);
  background: var(--panel);
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); margin-bottom: 5px; }
textarea { font-family: var(--mono); font-size: 12.5px; line-height: 1.5; padding-right: 44px; display: block; }
.msg-box { position: relative; }
.ai-msg { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 30px; height: 30px; color: var(--accent); }
.ai-msg:hover:not(:disabled) { background: var(--accent-soft); }
.ai-msg.running { color: var(--accent); }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gap { flex: 1; }
.op-hint { font-size: 12px; }
@media (max-width: 620px) {
  .bar { padding: 10px; gap: 8px; }
  .actions { gap: 6px; }
  .actions button { padding: 0 10px; }
  .gap { flex-basis: 100%; height: 0; }
}
.n {
  font-size: 11px; font-weight: 700; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(127, 127, 127, 0.18);
}
.primary .n { background: rgba(255, 255, 255, 0.25); }
</style>
