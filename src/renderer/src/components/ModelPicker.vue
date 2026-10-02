<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { CLAUDE_ALIASES, CLAUDE_EXACT, CLAUDE_FAMILIES, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, PROVIDERS, effortsFor, modelLabel } from '@shared/models'
import type { AgentEffort, CliProvider, KnownModels, ModelInfo } from '@shared/types'
import AgentLogo from './AgentLogo.vue'
import Icon from './Icon.vue'

/**
 * Seletor de modelo e esforço do agente. Como chip (abre um painel flutuante, estilo app do Codex)
 * ou embutido num formulário (`inline`). O provedor só muda quando `providers` está ligado
 * (antes da primeira mensagem: a sessão de um CLI não é legível pelo outro).
 */
const props = defineProps<{
  inline?: boolean
  providers?: boolean
  /** Conversa já iniciada: mostra o provedor, mas não deixa trocar */
  lockProvider?: boolean
  disabled?: boolean
  /** Só o modelo (sem o controle de esforço) */
  noEffort?: boolean
  known?: KnownModels | null
  /** Último modelo/esforço usado em cada IA (quem chama guarda entre sessões) */
  defaults?: Partial<Record<CliProvider, { model: string; effort: AgentEffort }>>
}>()
const provider = defineModel<CliProvider>('provider', { required: true })
const model = defineModel<string>('model', { required: true })
const effort = defineModel<AgentEffort>('effort', { required: true })

const open = ref(false)
const root = ref<HTMLElement>()
const CUSTOM = '__custom__'

/** Catálogo do provedor atual: o do Codex vem do próprio CLI; o do Claude é a lista fixa do app. */
const catalog = computed<ModelInfo[]>(() =>
  provider.value === 'codex'
    ? (props.known?.codexCatalog ?? [])
    : provider.value === 'agy'
      ? (props.known?.agyCatalog ?? [])
      : [...CLAUDE_ALIASES.map((m) => ({ id: m.id, label: m.label.split(':')[0], description: m.label.split(': ')[1] })), ...CLAUDE_EXACT]
)
const selected = computed(() => catalog.value.find((m) => m.id === model.value))

// níveis de esforço: os que o modelo escolhido aceita (catálogo), senão os padrões do provedor
const efforts = computed(() => effortsFor(provider.value, selected.value))
const effortIndex = computed(() => Math.max(0, efforts.value.findIndex((e) => e.id === effort.value)))
const effortLabel = computed(() => efforts.value[effortIndex.value]?.label ?? '')
function setEffortIndex(i: number) {
  effort.value = efforts.value[Math.min(Math.max(i, 0), efforts.value.length - 1)].id
}
// modelo que não aceita o nível atual: vai para o padrão dele ou o mais próximo
watch(efforts, (list) => {
  if (!list.some((e) => e.id === effort.value)) {
    const def = selected.value?.defaultEffort
    effort.value = def && list.some((e) => e.id === def) ? def : list[Math.min(effortIndex.value, list.length - 1)].id
  }
})
const isClaudeId = (id: string) => /^claude|^(sonnet|opus|haiku|fable)$/.test(id)
// cada IA lembra o último modelo e esforço usados nela; no primeiro uso vale o padrão (Claude: Sonnet; ChatGPT: conta)
/** Modelo válido para a IA (vazio = padrão da conta); um id de outra IA é descartado. O Antigravity serve vários fornecedores. */
const fits = (p: CliProvider, id: string | undefined) => id !== undefined && (!id || p === 'agy' || (p === 'claude') === isClaudeId(id))
const validEffort = (p: CliProvider, e: AgentEffort | undefined) => (e && EFFORTS[p].some((x) => x.id === e) ? e : DEFAULT_EFFORT[p])
const rememberedFor = (p: CliProvider) => ({
  model: fits(p, props.defaults?.[p]?.model) ? props.defaults![p]!.model : DEFAULT_MODEL[p],
  effort: validEffort(p, props.defaults?.[p]?.effort)
})
const remembered: Record<CliProvider, { model: string; effort: AgentEffort }> = {
  claude: rememberedFor('claude'),
  codex: rememberedFor('codex'),
  agy: rememberedFor('agy')
}
// modelo do outro provedor (ex.: reaberto com dados trocados) não vale
if (!fits(provider.value, model.value)) model.value = remembered[provider.value].model
remembered[provider.value] = { model: model.value, effort: effort.value }
watch(provider, (p, old) => {
  if (fits(old, model.value)) remembered[old] = { model: model.value, effort: effort.value }
  customMode.value = false
  custom.value = ''
  model.value = remembered[p].model
  effort.value = validEffort(p, remembered[p].effort)
})

/** Modelos do seletor, por grupo: catálogo do provedor; ids vistos nas sessões que não estão nele vão em "outros". */
const groups = computed(() => {
  // ids de um provedor não entram na lista do outro (ex.: "claude-…" no Codex)
  const inCatalog = new Set(catalog.value.map((m) => m.id))
  const recent = (props.known?.[provider.value] ?? []).filter((id) => id && fits(provider.value, id) && !inCatalog.has(id))
  const out: { label: string; items: { id: string; label: string }[] }[] = []
  if (provider.value === 'claude') {
    out.push({ label: 'Sempre a versão mais recente', items: CLAUDE_ALIASES.map((m) => ({ id: m.id, label: m.label.split(':')[0] })) })
    for (const f of CLAUDE_FAMILIES) out.push({ label: `${f.family} · versão fixa`, items: f.models })
  } else if (catalog.value.length) {
    out.push({ label: provider.value === 'codex' ? 'Modelos do Codex' : 'Modelos do Antigravity', items: catalog.value })
  }
  if (recent.length) out.push({ label: 'Outros usados recentemente', items: recent.map((id) => ({ id, label: modelLabel(provider.value, id) })) })
  return out
})
const knownIds = computed(() => new Set(['', ...groups.value.flatMap((g) => g.items.map((i) => i.id))]))
const customMode = ref(false)
const custom = ref('')
const choice = computed({
  get: () => (customMode.value || !knownIds.value.has(model.value) ? CUSTOM : model.value),
  set: (v: string) => {
    if (v === CUSTOM) {
      customMode.value = true
      custom.value = ''
      model.value = ''
    } else {
      customMode.value = false
      custom.value = ''
      model.value = v
    }
  }
})
/** Digitação no campo "Outro": só aqui o texto vira modelo (nunca por observador, para não realimentar valores velhos) */
function onCustomInput(e: Event) {
  custom.value = (e.target as HTMLInputElement).value
  model.value = custom.value.trim()
}
// o modelo pode mudar por fora (troca de IA, último usado): o campo "Outro" segue o estado real
watch(
  [model, knownIds],
  ([m, ids]) => {
    // valor ainda da outra IA (o v-model do pai propaga no próximo ciclo): ignora
    if (!m || !fits(provider.value, m)) return
    if (ids.has(m)) {
      customMode.value = false
      custom.value = ''
    } else {
      customMode.value = true
      if (custom.value.trim() !== m) custom.value = m
    }
  },
  { immediate: true }
)

const label = computed(() => modelLabel(provider.value, model.value, catalog.value))

// ---------- lista de modelos com busca ----------
const listOpen = ref(false)
const selRoot = ref<HTMLElement>()
const listEl = ref<HTMLElement>()
const searchEl = ref<HTMLInputElement>()
const query = ref('')
const listIndex = ref(0)
const listStyle = ref<Record<string, string>>({})
const plainText = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const descOf = (id: string) => catalog.value.find((m) => m.id === id)?.description ?? CLAUDE_ALIASES.find((m) => m.id === id)?.label.split(': ')[1]
/** Grupos filtrados pela busca (nome, id ou descrição; palavras em qualquer ordem) */
const filteredGroups = computed(() => {
  const words = plainText(query.value).split(/\s+/).filter(Boolean)
  if (!words.length) return groups.value
  return groups.value
    .map((g) => ({ label: g.label, items: g.items.filter((m) => words.every((w) => plainText(`${m.label} ${m.id} ${descOf(m.id) ?? ''}`).includes(w))) }))
    .filter((g) => g.items.length)
})
const flatIds = computed(() => filteredGroups.value.flatMap((g) => g.items.map((m) => m.id)))
const flatIndex = (id: string) => flatIds.value.indexOf(id)
/** Índices das duas opções fixas do fim ("Padrão da conta", "Outro") */
const extraIndex = (n: number) => flatIds.value.length + n
function placeList() {
  const r = selRoot.value?.getBoundingClientRect()
  if (!r) return
  const below = window.innerHeight - r.bottom - 12
  const up = below < 260 && r.top > below
  listStyle.value = {
    left: `${r.left}px`,
    width: `${r.width}px`,
    ...(up ? { bottom: `${window.innerHeight - r.top + 6}px`, maxHeight: `${Math.min(420, r.top - 12)}px` } : { top: `${r.bottom + 6}px`, maxHeight: `${Math.min(420, below)}px` })
  }
}
function toggleList() {
  listOpen.value = !listOpen.value
  if (!listOpen.value) return
  query.value = ''
  listIndex.value = customMode.value ? extraIndex(1) : model.value ? Math.max(0, flatIndex(model.value)) : extraIndex(0)
  placeList()
  nextTick(() => {
    searchEl.value?.focus()
    listEl.value?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' })
  })
}
function pick(id: string) {
  choice.value = id
  listOpen.value = false
}
function onListKey(e: KeyboardEvent) {
  const n = flatIds.value.length + 2
  if (e.key === 'Escape') return (listOpen.value = false)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    listIndex.value = (listIndex.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    nextTick(() => listEl.value?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const i = listIndex.value
    pick(i < flatIds.value.length ? flatIds.value[i] : i === extraIndex(0) ? '' : CUSTOM)
  }
}
watch(query, () => (listIndex.value = 0))
watch(listOpen, (o) => {
  if (o) window.addEventListener('resize', placeList)
  else window.removeEventListener('resize', placeList)
})

const onDoc = (e: MouseEvent) => {
  const t = e.target as Node
  if (listOpen.value && !selRoot.value?.contains(t) && !listEl.value?.contains(t)) {
    listOpen.value = false
    return
  }
  if (open.value && root.value && !root.value.contains(t) && !listEl.value?.contains(t)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="picker" :class="{ inline }">
    <button v-if="!inline" type="button" class="chip" :class="{ on: open }" :disabled="disabled" title="Modelo e esforço" @click="open = !open">
      <AgentLogo :source="provider" :size="12" />
      <span class="chip-model ellipsis">{{ label }}</span>
      <span class="chip-effort">{{ effortLabel }}</span>
      <Icon name="chevron" :size="12" class="chev" />
    </button>

    <div v-if="inline || open" class="panel" :class="{ pop: !inline }">
      <div v-if="providers" class="providers">
        <button
          v-for="p in PROVIDERS"
          :key="p.id"
          type="button"
          class="prov"
          :class="{ active: provider === p.id }"
          :disabled="lockProvider && provider !== p.id"
          :title="lockProvider && provider !== p.id ? 'A conversa já começou com outro provedor. Abra um agente novo para trocar.' : undefined"
          @click="provider = p.id"
        >
          <AgentLogo :source="p.id" :size="14" />
          {{ p.label }}
        </button>
      </div>
      <p v-if="providers && lockProvider" class="faint hint lock">Conversa já iniciada: para usar o outro provedor, abra um agente novo.</p>

      <label class="lbl">Modelo</label>
      <!-- seletor de modelo: botão com o atual; a lista (com busca) vai para o body para não ser cortada -->
      <div ref="selRoot" class="sel-wrap">
        <button type="button" class="sel" :class="{ on: listOpen }" @click="toggleList">
          <span class="sel-name ellipsis">{{ customMode ? 'Outro (digitar o ID)' : model ? label : 'Padrão da conta' }}</span>
          <Icon name="chevron" :size="12" class="sel-chev" />
        </button>
        <Teleport to="body">
          <div v-if="listOpen" ref="listEl" class="mlist" :style="listStyle" role="listbox">
            <label class="mlist-search">
              <Icon name="search" :size="13" class="faint" />
              <input ref="searchEl" v-model="query" type="text" placeholder="Buscar modelo" spellcheck="false" autocomplete="off" @keydown="onListKey" />
            </label>
            <div class="mlist-items">
              <template v-for="g in filteredGroups" :key="g.label">
                <h6>{{ g.label }}</h6>
                <button
                  v-for="m in g.items"
                  :key="m.id"
                  type="button"
                  class="ghost mrow"
                  :class="{ cur: flatIndex(m.id) === listIndex, sel: !customMode && model === m.id }"
                  @mouseenter="listIndex = flatIndex(m.id)"
                  @click="pick(m.id)"
                >
                  <span class="mrow-name ellipsis">{{ m.label }}</span>
                  <Icon v-if="!customMode && model === m.id" name="check" :size="13" class="ok" />
                </button>
              </template>
              <p v-if="!filteredGroups.length" class="faint none">Nenhum modelo com esse nome.</p>
              <hr class="sep" />
              <button type="button" class="ghost mrow" :class="{ cur: listIndex === extraIndex(0), sel: !customMode && !model }" @mouseenter="listIndex = extraIndex(0)" @click="pick('')">
                <span class="mrow-name ellipsis">Padrão da conta</span>
                <Icon v-if="!customMode && !model" name="check" :size="13" class="ok" />
              </button>
              <button type="button" class="ghost mrow" :class="{ cur: listIndex === extraIndex(1), sel: customMode }" @mouseenter="listIndex = extraIndex(1)" @click="pick(CUSTOM)">
                <span class="mrow-name ellipsis">Outro (digitar o ID)…</span>
                <Icon v-if="customMode" name="check" :size="13" class="ok" />
              </button>
            </div>
          </div>
        </Teleport>
      </div>
      <input
        v-if="customMode"
        :value="custom"
        @input="onCustomInput"
        type="text"
        class="mono custom"
        :placeholder="provider === 'claude' ? 'ex.: claude-opus-5-5' : provider === 'agy' ? 'ex.: gemini-3.8-flash-high' : 'ex.: gpt-5.6-sol'"
        spellcheck="false"
      />

      <div v-if="!noEffort" class="eff-head">
        <span class="lbl">Esforço</span>
        <strong class="eff-name">{{ effortLabel }}</strong>
      </div>
      <div v-if="!noEffort" class="slider">
        <input
          type="range"
          :min="0"
          :max="efforts.length - 1"
          :value="effortIndex"
          :style="{ '--pct': `${(effortIndex / (efforts.length - 1)) * 100}%` }"
          @input="setEffortIndex(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="dots">
          <button
            v-for="(e, i) in efforts"
            :key="e.id"
            type="button"
            class="dot"
            :class="{ on: i <= effortIndex, cur: i === effortIndex }"
            :title="e.label"
            @click="setEffortIndex(i)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; min-width: 0; }
.picker.inline { display: block; }
.chip { height: 30px; padding: 0 8px 0 10px; gap: 7px; border-radius: 999px; font-size: 12px; max-width: 100%; }
.chip.on { background: var(--hover); }
.chip-model { font-weight: 600; min-width: 0; }
.chip-effort { color: var(--muted); font-weight: 400; flex: none; }
.chev { transform: rotate(-90deg); color: var(--faint); }
.panel { display: flex; flex-direction: column; gap: 8px; }
.panel.pop {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30; width: min(380px, calc(100vw - 32px)); padding: 14px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  animation: rise 0.12s ease-out;
}
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
.providers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 4px; }
.prov { height: 34px; gap: 6px; padding: 0 8px; font-weight: 600; min-width: 0; font-size: 12.5px; }
.prov span, .prov { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prov.active { border-color: var(--accent); background: var(--accent-soft); }
.lbl { font-size: 11.5px; color: var(--muted); }
.sel-wrap { position: relative; }
.sel { width: 100%; height: 36px; padding: 0 10px 0 12px; justify-content: space-between; gap: 8px; text-align: left; }
.sel.on { border-color: var(--accent); }
.sel-name { font-size: 13px; font-weight: 600; }
.sel-chev { transform: rotate(90deg); color: var(--faint); flex: none; }
/* a lista vive no body (Teleport): posição fixa a partir do botão */
.mlist {
  position: fixed; z-index: 80; display: flex; flex-direction: column; overflow: hidden;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4); animation: rise 0.1s ease-out;
}
.mlist-search { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-bottom: 1px solid var(--border); flex: none; }
.mlist-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0; font-size: 13px; color: var(--text); }
.mlist-search input:focus { box-shadow: none; }
.mlist-items { overflow: auto; padding: 6px; min-height: 0; }
.mlist h6 { margin: 8px 8px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.mrow { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 10px; border-radius: 8px; justify-content: flex-start; color: var(--text); text-align: left; }
.mrow.cur { background: var(--hover); }
.mrow.sel .mrow-name { color: var(--accent); }
.mrow-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; }
.mrow .ok { color: var(--accent); flex: none; }
.mlist .sep { border: 0; border-top: 1px solid var(--border); margin: 6px 4px; }
.mlist .none { margin: 10px 10px 8px; font-size: 12.5px; }
.custom { height: 32px; font-size: 12.5px; }
.eff-head { display: flex; align-items: baseline; justify-content: space-between; margin-top: 4px; }
.eff-name { font-size: 13px; color: var(--accent); }
.slider { position: relative; height: 28px; }
.slider input[type='range'] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 28px; margin: 0; background: transparent; cursor: pointer;
  position: relative; z-index: 2;
}
.slider input[type='range']::-webkit-slider-runnable-track {
  height: 8px; border-radius: 999px;
  background: linear-gradient(to right, var(--accent) var(--pct), var(--panel-2) var(--pct));
}
.slider input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none; width: 22px; height: 22px; margin-top: -7px; border-radius: 50%;
  background: #fff; border: 1px solid rgba(0, 0, 0, 0.15); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.dots { position: absolute; inset: 0 10px; display: flex; justify-content: space-between; align-items: center; pointer-events: none; }
.dot { width: 6px; height: 6px; padding: 0; border: 0; border-radius: 50%; background: var(--faint); pointer-events: auto; opacity: 0.8; }
.dot.on { background: var(--on-accent); opacity: 0.7; }
.dot.cur { opacity: 0; }
.hint { margin: 2px 0 0; font-size: 11px; line-height: 1.4; }
.hint.lock { margin: -4px 0 2px; }
.hint.desc { margin: -2px 0 0 2px; }
</style>
