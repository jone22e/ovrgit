<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { AgentAction, AgentSnapshot } from '@shared/types'
import { SUBAGENT_STATUS, subagentRows, type SubagentDetail } from '@shared/subagents'
import { api } from '../store'
import AgentCard from './AgentCard.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const props = defineProps<{ a: AgentSnapshot; n: number | null; now: number; selected: boolean; fresh?: boolean; stalled?: boolean; compact?: boolean }>()
const emit = defineEmits<{ pick: []; act: [action: AgentAction]; unread: [] }>()
const expanded = ref(true)
const collapsed = ref(new Set<string>())
const children = computed(() => props.a.subagents ?? [])
const rows = computed(() => subagentRows(children.value, collapsed.value))
const selected = ref<string | null>(null)
const detail = ref<SubagentDetail | null>(null)
const error = ref('')
let request = 0
let detailTimer: ReturnType<typeof setTimeout> | undefined
function toggle(id: string) {
  const next = new Set(collapsed.value)
  next.has(id) ? next.delete(id) : next.add(id)
  collapsed.value = next
}
async function loadDetail() {
  const id = selected.value
  const version = ++request
  if (!id) { detail.value = null; return }
  try {
    const value = await api.agentSubagent(props.a.uid, id)
    if (request !== version) return
    detail.value = value
    error.value = value ? '' : 'Esta execução não está disponível nesta conversa.'
  } catch (e) { if (request === version) error.value = String((e as Error).message ?? e) }
}
watch(selected, () => { clearTimeout(detailTimer); detailTimer = undefined; void loadDetail() })
watch(() => children.value.some((a) => a.id === selected.value), (exists) => { if (selected.value && !exists) selected.value = null })
watch(() => children.value.find((a) => a.id === selected.value)?.updatedAt, () => {
  if (!selected.value || detailTimer) return
  detailTimer = setTimeout(() => { detailTimer = undefined; void loadDetail() }, 150)
})
onUnmounted(() => { request++; clearTimeout(detailTimer) })
function open(id: string) { detail.value = null; error.value = ''; selected.value = id }
const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }))
</script>

<template>
  <div class="agent-branch">
    <AgentCard :a="a" :n="n" :now="now" :selected="props.selected" :fresh="fresh" :stalled="stalled" :compact="compact" @pick="emit('pick')" @act="emit('act', $event)" @unread="emit('unread')">
      <template #children>
        <button v-if="children.length" type="button" class="sub-count" :aria-expanded="expanded" :title="`${children.length} subagente(s) · ${expanded ? 'Recolher' : 'Expandir'}`" :aria-label="`${expanded ? 'Recolher' : 'Expandir'} ${children.length} subagentes de ${a.title}`" @click.stop="expanded = !expanded">
          <Icon name="chevron" :size="11" :class="{ down: expanded }" /><Icon name="branch" :size="12" /><span>{{ children.length }}</span>
        </button>
      </template>
    </AgentCard>
    <ul v-if="expanded && children.length" class="sub-tree" :aria-label="`Subagentes de ${a.title}`">
      <li v-for="row in rows" :key="row.agent.id" :style="{ marginLeft: `${row.depth * 16}px` }">
        <button v-if="children.some((c) => c.parentId === row.agent.id)" type="button" class="sub-toggle" :aria-expanded="!collapsed.has(row.agent.id)" :aria-label="`Expandir ou recolher filhos de ${row.agent.name}`" @click="toggle(row.agent.id)"><Icon name="chevron" :size="11" :class="{ down: !collapsed.has(row.agent.id) }" /></button>
        <span v-else class="sub-toggle-spacer" />
        <button type="button" class="sub-row" :title="`${row.agent.name} · ${SUBAGENT_STATUS[row.agent.status]}`" @click="open(row.agent.id)">
          <span class="sub-dot" :class="row.agent.status" />
          <span class="sub-copy"><strong>{{ row.agent.name }}</strong><small>{{ row.agent.activity || SUBAGENT_STATUS[row.agent.status] }}</small></span>
          <Icon name="chevron" :size="12" class="sub-open" />
        </button>
      </li>
    </ul>
    <Teleport to="body">
    <Modal v-if="selected" :title="detail?.name ?? 'Execução do subagente'" :width="760" @close="selected = null">
      <p class="sub-parent">Subagente de <strong>{{ a.title }}</strong><template v-if="detail"> · {{ SUBAGENT_STATUS[detail.status] }} · {{ detail.provider === 'claude' ? 'Claude' : 'Codex' }}</template></p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="!detail" class="faint">Carregando execução…</p>
      <template v-if="detail">
        <section v-if="detail.prompt"><h4>Pedido do principal</h4><pre class="sub-prompt">{{ detail.prompt }}</pre></section>
        <details v-if="detail.requests?.length"><summary>Outros pedidos do principal</summary><pre v-for="(text, index) in detail.requests" :key="index" class="sub-prompt">{{ text }}</pre></details>
        <section class="sub-transcript">
          <h4>Execução</h4>
          <template v-for="(block, index) in detail.blocks" :key="index">
            <div v-if="block.kind === 'text'" class="md" v-html="md(block.text)" />
            <details v-else-if="block.kind === 'tool'" class="sub-tool">
              <summary>{{ block.title }}<span>{{ block.ok === true ? ' ✓' : block.ok === false ? ' ✗' : '' }}</span></summary>
              <pre v-if="block.detail">{{ block.detail }}</pre><pre v-if="block.output">{{ block.output }}</pre>
            </details>
          </template>
          <p v-if="!detail.blocks.length" class="faint">{{ detail.activity || 'O CLI ainda não enviou mensagens internas deste subagente.' }}</p>
        </section>
        <section v-if="detail.result"><h4>Resultado informado ao principal</h4><div class="md" v-html="md(detail.result)" /></section>
        <small class="faint">Acompanhamento de leitura. A delegação e a integração dos resultados continuam com o agente principal.</small>
      </template>
      <template #footer><button type="button" class="ghost" @click="selected = null">Fechar</button></template>
    </Modal>
    </Teleport>
  </div>
</template>

<style scoped>
.agent-branch { min-width: 0; }
.sub-count { flex: none; display: inline-flex; align-items: center; gap: 3px; height: 24px; padding: 0 5px; border: 0; border-radius: 6px; background: transparent; color: var(--accent); font-size: 11px; cursor: pointer; }
.sub-count:hover { background: var(--hover); }
.down { transform: rotate(90deg); }
.sub-tree { margin: 0 12px 8px 32px; padding: 4px 0 4px 12px; list-style: none; border-left: 1px solid var(--border); }
.sub-tree li { display: flex; align-items: center; min-width: 0; position: relative; }
.sub-tree li::before { content: ''; position: absolute; top: 50%; left: -12px; width: 10px; border-top: 1px solid var(--border); }
.sub-toggle, .sub-toggle-spacer { width: 16px; flex: none; }
.sub-toggle { padding: 0; height: 24px; border: 0; background: transparent; color: var(--muted); }
.sub-row { display: flex; align-items: center; gap: 8px; min-width: 0; width: 100%; padding: 7px 8px; border: 0; border-radius: 7px; text-align: left; background: transparent; cursor: pointer; }
.sub-row:hover { background: var(--hover); }
.sub-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.sub-copy strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.sub-copy small { font-size: 10px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--faint); }
.sub-dot.live { background: var(--accent); box-shadow: 0 0 5px var(--accent); }
.sub-dot.done { background: var(--add); }
.sub-dot.error { background: var(--del); }
.sub-open { flex: none; color: var(--faint); }
.sub-parent { margin: 0; color: var(--muted); font-size: 12px; }
h4 { margin: 8px 0; font-size: 12px; color: var(--muted); }
.sub-prompt, .sub-tool pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 ui-monospace, monospace; max-height: 240px; overflow: auto; }
.sub-tool { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.sub-tool summary { cursor: pointer; }
.sub-transcript { max-height: 50vh; overflow: auto; }
</style>
