<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { commit, generateMessage, ovseerReady, push, reviewWithAi, setMessage, state } from '../store'
import PrStatus from './PrStatus.vue'
import TaskPicker from './TaskPicker.vue'
import Icon from './Icon.vue'

defineEmits<{ feature: []; pull: []; publish: [] }>()

/** send: branch já publicada · publishBranch: há remote, mas a branch não existe nele · publishRepo: sem remote */
const sendMode = computed(() =>
  !state.repo?.hasRemote ? 'publishRepo' : state.repo.published ? 'send' : 'publishBranch'
)

const nSelected = computed(() => state.selected.size)

// a caixa cresce com o texto (até um limite; depois rola)
const box = ref<HTMLTextAreaElement>()
function fit() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  const max = Math.round(window.innerHeight * 0.35)
  el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`
  el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden'
}
watch(() => state.message, () => nextTick(fit))
onMounted(fit)
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
      <label for="commit-msg">O que você fez?</label>
      <div class="msg-box">
      <textarea
        id="commit-msg"
        ref="box"
        :value="state.message"
        rows="2"
        spellcheck="false"
        :placeholder="nSelected ? 'Descreva as alterações… (ou use a IA ao lado)' : 'Marque os arquivos que quer salvar'"
        @input="setMessage(($event.target as HTMLTextAreaElement).value)"
        @keydown="onKey"
      />
      <button
        class="ghost icon ai-msg"
        :class="{ running: state.busy === 'message' }"
        :disabled="(!!state.busy && state.busy !== 'message') || !nSelected"
        :title="state.busy === 'message' ? 'Escrevendo… clique para cancelar' : `A IA escreve a descrição para os ${nSelected} arquivo(s) marcados`"
        @click="generateMessage"
      >
        <span v-if="state.busy === 'message'" class="spinner" />
        <Icon v-else name="sparkles" :size="16" />
      </button>
      </div>
    </div>
    <div class="actions">
      <span v-if="state.repo?.operation" class="op-hint muted">
        Resolva a faixa acima (juntar versões) para voltar a salvar.
      </span>
      <template v-else>
      <button
        class="primary"
        :disabled="!canCommit"
        :title="`Salva uma versão com os ${nSelected} arquivo(s) marcados, no seu computador. Para mandar para o servidor, use Enviar. (commit · ${mod}+Enter)`"
        @click="commit"
      >
        <span v-if="state.busy === 'commit'" class="spinner" />
        <Icon v-else name="commit" />
        Salvar versão<span v-if="nSelected" class="n">{{ nSelected }}</span>
      </button>
      <TaskPicker v-if="ovseerReady" v-model="state.commitTaskId" up />
      <button
        class="ghost review"
        :disabled="!nSelected || !!state.busy"
        title="A IA revisa as alterações marcadas e aponta possíveis problemas antes de salvar"
        @click="reviewWithAi"
      >
        <Icon name="sparkles" :size="14" /> Revisar
      </button>
      </template>
      <span class="gap" />
      <PrStatus />
      <button :disabled="!!state.busy || !state.repo?.branch || !!state.repo?.operation" title="Separa o seu trabalho numa linha própria (branch), atualizada com a versão mais nova do servidor, e envia. Ideal para abrir um Pull Request." @click="$emit('feature')">
        <span v-if="state.busy === 'feature'" class="spinner" />
        <Icon v-else name="feature" />
        Criar Feature
      </button>
      <button
        :disabled="!!state.busy || !!state.repo?.operation || !state.repo?.published"
        :title="state.repo?.published ? 'Traz para o seu computador o que outras pessoas enviaram ao servidor (pull)' : 'Esta linha de trabalho ainda não existe no servidor: envie primeiro'"
        @click="$emit('pull')"
      >
        <span v-if="state.busy === 'pull'" class="spinner" />
        <Icon v-else name="down" />
        Baixar<span v-if="state.repo?.behind" class="n">{{ state.repo.behind }}</span>
      </button>
      <button
        v-if="sendMode === 'send'"
        :disabled="!!state.busy || !!state.repo?.operation"
        title="Manda as versões salvas no seu computador para o servidor, onde a equipe vê (push)"
        @click="push"
      >
        <span v-if="state.busy === 'push'" class="spinner" />
        <Icon v-else name="up" />
        Enviar<span v-if="state.repo?.ahead" class="n">{{ state.repo.ahead }}</span>
      </button>
      <button
        v-else
        class="publish"
        :disabled="!!state.busy || !!state.repo?.operation || !state.repo?.hasCommits"
        :title="
          sendMode === 'publishRepo'
            ? 'Este projeto ainda não está em nenhum servidor: publicar no GitHub ou em outro endereço'
            : `A linha de trabalho ${state.repo?.branch} ainda não está no servidor: enviar pela primeira vez (git push -u)`
        "
        @click="sendMode === 'publishRepo' ? $emit('publish') : push()"
      >
        <span v-if="state.busy === 'push'" class="spinner" />
        <Icon v-else name="cloudUp" />
        {{ sendMode === 'publishRepo' ? 'Publicar' : 'Publicar branch' }}
        <span v-if="state.repo?.unpublished" class="n">{{ state.repo.unpublished }}</span>
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
textarea { font-family: var(--mono); font-size: 12.5px; line-height: 1.5; padding-right: 44px; display: block; min-height: 52px; overflow-y: hidden; }
.msg-box { position: relative; }
.ai-msg { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 30px; height: 30px; color: var(--accent); }
.ai-msg:hover:not(:disabled) { background: var(--accent-soft); }
.ai-msg.running { color: var(--accent); }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gap { flex: 1; }
.op-hint { font-size: 12px; }
.publish { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); color: var(--accent); }
.publish:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 22%, transparent); }
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
