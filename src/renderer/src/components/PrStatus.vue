<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, loadPr, mergePr, state } from '../store'
import Icon from './Icon.vue'

/** Selo do Pull Request da linha atual, com o andamento e as ações em linguagem simples. */
const open = ref(false)
const root = ref<HTMLElement>()
const pr = computed(() => state.pr)

const stateLabel = computed(() =>
  !pr.value ? '' : { open: 'Em revisão', draft: 'Rascunho', merged: 'Juntado', closed: 'Fechado' }[pr.value.state]
)
const checksLabel = computed(
  () =>
    ({ none: 'Sem verificações automáticas', pending: 'Verificações rodando…', passing: 'Verificações passaram', failing: 'Verificações falharam' })[
      pr.value?.checks ?? 'none'
    ]
)
const reviewLabel = computed(
  () => ({ pending: 'Aguardando aprovação', approved: 'Aprovado', changes: 'Pediram mudanças' })[pr.value?.review ?? 'pending']
)
const tone = computed(() => {
  const p = pr.value
  if (!p) return ''
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.checks === 'failing' || p.review === 'changes' || p.conflicts) return 'bad'
  if (p.review === 'approved' && p.checks !== 'pending') return 'good'
  return 'wait'
})

function toggle() {
  open.value = !open.value
  if (open.value) loadPr(true)
}
const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div v-if="pr" ref="root" class="pr">
    <button class="chip" :class="tone" :title="`PR #${pr.number}: ${pr.title}`" @click="toggle">
      <Icon name="branch" :size="13" /> PR #{{ pr.number }} · {{ stateLabel }}
      <span v-if="pr.state === 'open' || pr.state === 'draft'" class="dots">
        <i :class="pr.checks" :title="checksLabel" />
        <i :class="pr.review" :title="reviewLabel" />
      </span>
    </button>
    <div v-if="open" class="pop">
      <strong class="t">{{ pr.title }}</strong>
      <ul>
        <li><span class="d" :class="pr.state" /> {{ stateLabel }} em <span class="mono">{{ pr.base }}</span></li>
        <template v-if="pr.state === 'open' || pr.state === 'draft'">
          <li><span class="d" :class="pr.checks" /> {{ checksLabel }}</li>
          <li><span class="d" :class="pr.review" /> {{ reviewLabel }}</li>
          <li v-if="pr.conflicts"><span class="d failing" /> Tem conflito com a {{ pr.base }}: baixe a {{ pr.base }} e resolva</li>
        </template>
      </ul>
      <div class="acts">
        <button class="small" @click="api.openExternal(pr.url)"><Icon name="external" :size="13" /> Ver no GitHub</button>
        <span class="grow" />
        <button
          v-if="pr.state === 'open'"
          class="small primary"
          :disabled="pr.conflicts || !!state.busy"
          :title="pr.conflicts ? 'Resolva o conflito antes' : 'Junta este trabalho na linha principal'"
          @click="(open = false), mergePr()"
        >
          Juntar na {{ pr.base }}
        </button>
      </div>
    </div>
  </div>
  <button
    v-else-if="state.repo?.published && state.repo.branch && !['main', 'master', 'develop'].includes(state.repo.branch)"
    class="ask-review"
    :disabled="!!state.busy || state.repo.ahead > 0"
    :title="state.repo.ahead > 0 ? 'Envie suas versões antes de pedir revisão' : 'Pede para a equipe revisar esta linha de trabalho (Pull Request)'"
    @click="state.showPrDialog = true"
  >
    <Icon name="branch" :size="14" /> Pedir revisão
  </button>
</template>

<style scoped>
.pr { position: relative; }
.chip { gap: 7px; font-size: 12.5px; }
.chip.good { border-color: color-mix(in srgb, var(--add) 50%, var(--border)); color: var(--add); }
.chip.bad { border-color: color-mix(in srgb, var(--del) 50%, var(--border)); color: var(--del); }
.chip.wait { border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); }
.chip.merged { color: var(--hunk); }
.dots { display: inline-flex; gap: 3px; }
.dots i, .d { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); display: inline-block; }
.passing, .approved, .merged.d { background: var(--add) !important; }
.failing, .changes, .closed.d { background: var(--del) !important; }
.pending { background: var(--mod) !important; }
.none { background: var(--faint) !important; }
.open.d, .draft.d { background: var(--accent) !important; }
.pop {
  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 46; width: 320px; padding: 12px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  display: flex; flex-direction: column; gap: 8px;
}
.t { font-size: 13px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
li { display: flex; align-items: center; gap: 8px; }
.acts { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.grow { flex: 1; }
.ask-review { gap: 6px; }
</style>
