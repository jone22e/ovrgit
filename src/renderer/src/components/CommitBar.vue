<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { analyze, cancelAnalysis, commit, generateMessage, hasPlan, ovseerReady, push, reviewWithAi, setMessage, state } from '../store'
import PrStatus from './PrStatus.vue'
import TaskPicker from './TaskPicker.vue'
import Icon from './Icon.vue'

const emit = defineEmits<{ feature: []; pull: []; publish: [] }>()

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
const mod = window.ovseer.platform === 'darwin' ? '⌘' : 'Ctrl'

// com arquivos marcados, o envio vira "Salvar e enviar"; o menu da setinha permite apenas salvar
const saveAndSend = computed(() => nSelected.value > 0 && !state.repo?.operation && sendMode.value !== 'publishRepo')
const menuOpen = ref(false)
const split = ref<HTMLElement>()
const onDoc = (e: MouseEvent) => {
  if (menuOpen.value && split.value && !split.value.contains(e.target as Node)) menuOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
function saveOnly() {
  menuOpen.value = false
  commit()
}
/** "Criar Feature" mora no menu da setinha do botão de enviar (com ou sem arquivos marcados) */
const canFeature = computed(() => !state.busy && !!state.repo?.branch && !state.repo?.operation)
function feature() {
  menuOpen.value = false
  emit('feature')
}

// envio: o botão enche como uma barra de progresso colorida. O git não informa quanto falta, então a barra anda
// por etapas (salvar até ~40%, enviar até ~92%, sempre desacelerando) e completa quando termina: verde se deu
// certo, vermelho se falhou
type SendPhase = 'idle' | 'run' | 'ok' | 'fail'
const sendPhase = ref<SendPhase>('idle')
const sendP = ref(0)
let sendTarget = 0
let sendFrame = 0
let sendEnd: ReturnType<typeof setTimeout> | undefined
let resultBefore: typeof state.result = null
function sendLoop() {
  sendP.value += (sendTarget - sendP.value) * (sendTarget === 1 ? 0.25 : 0.02)
  sendFrame = sendTarget === 1 && sendP.value > 0.995 ? 0 : requestAnimationFrame(sendLoop)
  if (!sendFrame) sendP.value = 1
}
function sendTo(target: number) {
  clearTimeout(sendEnd)
  if (sendPhase.value !== 'run') {
    sendPhase.value = 'run'
    sendP.value = 0
    resultBefore = state.result
  }
  sendTarget = Math.max(sendTarget, target)
  if (!sendFrame) sendFrame = requestAnimationFrame(sendLoop)
}
watch(
  () => state.busy,
  (b) => {
    if (b === 'commit') sendTo(0.4)
    else if (b === 'push') sendTo(0.92)
    else if (!b && sendPhase.value === 'run')
      // entre salvar e enviar o estado fica livre por um instante: só termina se o envio não começar logo
      sendEnd = setTimeout(() => {
        if (state.busy) return
        const failed = !!state.error || (state.result !== resultBefore && state.result?.ok === false)
        sendPhase.value = failed ? 'fail' : 'ok'
        sendTarget = 1
        if (!sendFrame) sendFrame = requestAnimationFrame(sendLoop)
        sendEnd = setTimeout(() => {
          sendPhase.value = 'idle'
          sendP.value = sendTarget = 0
        }, 1100)
      }, 120)
  }
)
onUnmounted(() => {
  cancelAnimationFrame(sendFrame)
  clearTimeout(sendEnd)
})
const sendClass = computed(() => (sendPhase.value === 'idle' ? {} : { sending: true, [sendPhase.value]: true }))
const sendStyle = computed(() => ({ '--p': sendP.value.toFixed(4) }))

// análise detalhada: cronômetro na dica enquanto roda; clique cancela
const elapsed = ref(0)
let tick: ReturnType<typeof setInterval> | undefined
watch(
  () => state.busy === 'analyze',
  (on) => {
    clearInterval(tick)
    elapsed.value = 0
    if (on) tick = setInterval(() => (elapsed.value = Math.round((Date.now() - state.analyzeStartedAt) / 1000)), 500)
  }
)
onUnmounted(() => clearInterval(tick))
const nFiles = computed(() => state.repo?.files.length ?? 0)
const detailedTitle = computed(() =>
  state.busy === 'analyze'
    ? `Analisando… ${elapsed.value}s · clique para cancelar`
    : hasPlan.value
      ? `Análise detalhada: pedir à IA uma nova separação das alterações em versões (${mod}+I)`
      : `Análise detalhada: a IA organiza suas alterações em versões separadas por assunto (${mod}+I)`
)
function detailed() {
  if (state.busy === 'analyze') cancelAnalysis()
  else analyze(hasPlan.value)
}

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
      <div class="ai-btns">
        <button
          class="ghost icon ai-msg"
          :disabled="(!!state.busy && state.busy !== 'message') || !nSelected"
          :title="state.busy === 'message' ? 'Escrevendo… clique para cancelar' : `Análise rápida: a IA escreve a descrição para os ${nSelected} arquivo(s) marcados`"
          @click="generateMessage"
        >
          <span v-if="state.busy === 'message'" class="spinner" />
          <Icon v-else name="zap" :size="16" />
        </button>
        <button
          class="ghost icon ai-msg"
          :disabled="(!!state.busy && state.busy !== 'analyze') || !nFiles || !!state.repo?.operation"
          :title="detailedTitle"
          @click="detailed"
        >
          <span v-if="state.busy === 'analyze'" class="spinner" />
          <Icon v-else name="layers" :size="16" />
        </button>
      </div>
      </div>
    </div>
    <div class="actions">
      <span v-if="state.repo?.operation" class="op-hint muted">
        Resolva a faixa acima (juntar versões) para voltar a salvar.
      </span>
      <template v-else>
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
      <button
        :disabled="!!state.busy || !!state.repo?.operation || !state.repo?.published"
        :title="state.repo?.published ? 'Traz para o seu computador o que outras pessoas enviaram ao servidor (pull)' : 'Esta linha de trabalho ainda não existe no servidor: envie primeiro'"
        @click="$emit('pull')"
      >
        <span v-if="state.busy === 'pull'" class="spinner" />
        <Icon v-else name="down" />
        Baixar<span v-if="state.repo?.behind" class="n">{{ state.repo.behind }}</span>
      </button>
      <div v-if="saveAndSend" ref="split" class="split">
        <button
          class="primary main"
          :class="sendClass"
          :style="sendStyle"
          :disabled="!canCommit"
          :title="`Salva uma versão com os ${nSelected} arquivo(s) marcados e já manda para o servidor (commit + push)`"
          @click="commit(true)"
        >
          <span v-if="sendPhase !== 'idle'" class="fill" />
          <span v-if="state.busy === 'commit' || state.busy === 'push'" class="spinner" />
          <Icon v-else name="up" />
          {{ sendMode === 'send' ? 'Salvar e enviar' : 'Salvar e publicar' }}<span class="n">{{ nSelected }}</span>
        </button>
        <button class="primary icon more" :disabled="!!state.busy" title="Outras opções" @click="menuOpen = !menuOpen">
          <Icon name="chevron" :size="14" class="caret" />
        </button>
        <div v-if="menuOpen" class="menu">
          <button class="ghost item" :disabled="!canCommit" title="Guarda a versão só no seu computador, sem enviar" @click="saveOnly">
            <Icon name="commit" :size="14" />
            <span>Apenas salvar</span>
            <kbd class="faint">{{ mod }}+Enter</kbd>
          </button>
          <button class="ghost item" :disabled="!canFeature" title="Separa o seu trabalho numa branch própria, atualizada com o servidor, e envia" @click="feature">
            <Icon name="feature" :size="14" />
            <span>Criar Feature…</span>
            <kbd class="faint">{{ mod }}+⇧F</kbd>
          </button>
        </div>
      </div>
      <button
        v-else-if="nSelected && sendMode === 'publishRepo'"
        class="primary"
        :disabled="!canCommit"
        :title="`Salva uma versão com os ${nSelected} arquivo(s) marcados, no seu computador (commit · ${mod}+Enter)`"
        @click="commit()"
      >
        <span v-if="state.busy === 'commit'" class="spinner" />
        <Icon v-else name="commit" />
        Salvar versão<span class="n">{{ nSelected }}</span>
      </button>
      <template v-if="!saveAndSend">
      <div v-if="sendMode === 'send'" ref="split" class="split">
        <button
          class="main"
          :class="sendClass"
          :style="sendStyle"
          :disabled="!!state.busy || !!state.repo?.operation"
          title="Manda as versões salvas no seu computador para o servidor, onde a equipe vê (push)"
          @click="push"
        >
          <span v-if="sendPhase !== 'idle'" class="fill" />
          <span v-if="state.busy === 'push'" class="spinner" />
          <Icon v-else name="up" />
          Enviar<span v-if="state.repo?.ahead" class="n">{{ state.repo.ahead }}</span>
        </button>
        <button class="icon more plain" :disabled="!!state.busy" title="Outras opções" @click="menuOpen = !menuOpen">
          <Icon name="chevron" :size="14" class="caret" />
        </button>
        <div v-if="menuOpen" class="menu">
          <button class="ghost item" :disabled="!canFeature" title="Separa o seu trabalho numa branch própria, atualizada com o servidor, e envia" @click="feature">
            <Icon name="feature" :size="14" />
            <span>Criar Feature…</span>
            <kbd class="faint">{{ mod }}+⇧F</kbd>
          </button>
        </div>
      </div>
      <button
        v-else
        class="publish"
        :class="sendClass"
        :style="sendStyle"
        :disabled="!!state.busy || !!state.repo?.operation || !state.repo?.hasCommits"
        :title="
          sendMode === 'publishRepo'
            ? 'Este projeto ainda não está em nenhum servidor: publicar no GitHub ou em outro endereço'
            : `A linha de trabalho ${state.repo?.branch} ainda não está no servidor: enviar pela primeira vez (git push -u)`
        "
        @click="sendMode === 'publishRepo' ? $emit('publish') : push()"
      >
        <span v-if="sendPhase !== 'idle'" class="fill" />
        <span v-if="state.busy === 'push'" class="spinner" />
        <Icon v-else name="cloudUp" />
        {{ sendMode === 'publishRepo' ? 'Publicar' : 'Publicar branch' }}
        <span v-if="state.repo?.unpublished" class="n">{{ state.repo.unpublished }}</span>
      </button>
      </template>
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
textarea { font-family: var(--mono); font-size: 12.5px; line-height: 1.5; padding-right: 76px; display: block; min-height: 52px; overflow-y: hidden; }
.msg-box { position: relative; }
.ai-btns { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; }
.ai-msg { width: 30px; height: 30px; color: var(--accent); }
.ai-msg:hover:not(:disabled) { background: var(--accent-soft); }
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
.split { position: relative; display: inline-flex; }
.split .main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.split .more {
  width: 28px; border-top-left-radius: 0; border-bottom-left-radius: 0;
  border-left-color: color-mix(in srgb, var(--on-accent) 35%, var(--accent));
}
.split .more.plain { border-left-color: var(--border); }
.caret { transform: rotate(-90deg); }
.menu .item:disabled { opacity: 0.5; }
.menu {
  position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 60; width: 260px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.menu .item { width: 100%; justify-content: flex-start; }
.menu .item span { flex: 1; text-align: left; }
.menu kbd { font-family: var(--mono); font-size: 11px; }
/* envio em andamento: o botão vira barra de progresso nas cores do tema (trilho suave, faixa na cor de destaque
   com um brilho que corre por ela) */
.sending, .sending:disabled {
  position: relative; overflow: hidden; isolation: isolate; opacity: 1;
  background: var(--accent-soft); border-color: var(--accent); color: var(--text);
}
.sending .fill {
  position: absolute; inset: 0; z-index: -1; pointer-events: none;
  transform-origin: left; transform: scaleX(var(--p, 0));
  background:
    linear-gradient(100deg, transparent 30%, color-mix(in srgb, #fff 35%, transparent) 50%, transparent 70%) 0 0 / 250% 100% no-repeat,
    linear-gradient(90deg, var(--accent-strong), var(--accent));
  animation: send-shine 1.4s linear infinite;
}
.sending.ok .fill { background: var(--add); animation: none; }
.sending.fail .fill { background: var(--del); animation: none; }
.sending.ok, .sending.fail { color: #fff; border-color: transparent; }
@keyframes send-shine { from { background-position: 150% 0, 0 0; } to { background-position: -150% 0, 0 0; } }
@media (prefers-reduced-motion: reduce) { .sending .fill { animation: none; } }
</style>
