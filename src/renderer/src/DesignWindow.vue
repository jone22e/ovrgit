<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AgentAttachment, AgentEffort, CliProvider, KnownModels } from '@shared/types'
import { designScreens, previewDocument, type DesignAction, type DesignWindowState } from '@shared/architect'
import AgentLogo from './components/AgentLogo.vue'
import Icon from './components/Icon.vue'
import ModelPicker from './components/ModelPicker.vue'
import { applyTheme } from './theme'

/**
 * Janela de design do Modo Arquiteto: uma tela à parte da conversa. À esquerda, a conversa com o agente de
 * design (o pedido, o que ele fez, cada revisão e a versão que ela gerou); à direita, a tela do conceito, com as
 * páginas em abas, a largura (Desktop ou Mobile), a ferramenta de selecionar um elemento e o histórico de versões.
 * A conversa do agente é a dona do estado: esta janela mostra o que ela publica e pede o que o usuário faz aqui.
 */
const api = window.ovseer
const uid = new URLSearchParams(location.search).get('uid') ?? ''
const state = ref<DesignWindowState | null>(null)
const known = ref<KnownModels | null>(null)
const localError = ref<string | null>(null)
/** Pede algo à conversa. Vai uma cópia simples: objetos reativos não atravessam para a outra janela */
async function act(a: DesignAction) {
  try {
    await api.designAct(uid, JSON.parse(JSON.stringify(a)))
  } catch (e) {
    localError.value = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  }
}
const offs: (() => void)[] = []

const design = computed(() => state.value?.design ?? null)
const versions = computed(() => design.value?.versions ?? [])
const running = computed(() => !!state.value?.running)
const approved = computed(() => typeof design.value?.approved === 'number')
const done = computed(() => design.value?.approved !== undefined)
const version = computed(() => (design.value ? versions.value[design.value.current] : undefined))
/** O que a tela mostra: a versão em andamento enquanto desenha; senão a versão escolhida */
const html = computed(() => (running.value ? (state.value?.live ?? '') : (version.value?.html ?? '')))
const doc = computed(() => (html.value ? previewDocument(html.value) : ''))
const error = computed(() => localError.value ?? state.value?.error ?? null)

// ---------- IA do design ----------
const provider = ref<CliProvider>('claude')
const model = ref('')
const effort = ref<AgentEffort>('high')
let syncingAi = false
watch(
  () => design.value && [design.value.provider, design.value.model, design.value.effort].join('|'),
  () => {
    if (!design.value) return
    syncingAi = true
    provider.value = design.value.provider
    model.value = design.value.model
    effort.value = design.value.effort as AgentEffort
    nextTick(() => (syncingAi = false))
  },
  { immediate: true }
)
watch([provider, model, effort], () => !syncingAi && act({ type: 'ai', provider: provider.value, model: model.value, effort: effort.value }))

// ---------- páginas (as telas do conceito), em abas ----------
const pageLabel = (s: string) => s.replace(/^\s*\d+\s*[.)\-–:]\s*/, '')
const screens = computed(() => designScreens(html.value))
const page = ref(0)
watch(screens, (s) => page.value >= s.length && (page.value = 0))

// ---------- largura e ferramenta de selecionar ----------
const width = ref<'desktop' | 'mobile'>('desktop')
const selecting = ref(false)
const target = ref<{ label: string; ref: string } | null>(null)
const frame = ref<HTMLIFrameElement>()
const HELPER = 'data-ovseer-helper'
const frameDoc = () => frame.value?.contentDocument ?? null
const KIND: Record<string, string> = {
  button: 'Botão', a: 'Link', input: 'Campo', select: 'Seletor', textarea: 'Campo', table: 'Tabela', th: 'Cabeçalho', td: 'Célula', tr: 'Linha',
  h1: 'Título', h2: 'Título', h3: 'Subtítulo', h4: 'Subtítulo', p: 'Texto', img: 'Imagem', svg: 'Ícone', nav: 'Menu', aside: 'Barra lateral', header: 'Cabeçalho', footer: 'Rodapé',
  section: 'Seção', label: 'Rótulo', li: 'Item', ul: 'Lista', form: 'Formulário'
}
function describe(el: Element): { label: string; ref: string } {
  const tag = el.tagName.toLowerCase()
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const screen = el.closest('section[data-tela]')?.getAttribute('data-tela')
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
  return {
    label: KIND[tag] ?? 'Elemento',
    ref: `<${tag}${cls ? ` class="${cls}"` : ''}>${text ? ` com o texto "${text}"` : ''}${screen ? ` (tela "${screen}")` : ''}`
  }
}
let hovered: Element | null = null
function onFrameOver(e: Event) {
  if (!selecting.value) return
  hovered?.removeAttribute('data-ovseer-hover')
  hovered = e.target as Element
  hovered.setAttribute('data-ovseer-hover', '')
}
function onFrameClick(e: Event) {
  // a tela é um mockup: nenhum link navega e nenhum formulário envia
  e.preventDefault()
  if (!selecting.value) return
  e.stopPropagation()
  frameDoc()?.querySelectorAll('[data-ovseer-picked]').forEach((x) => x.removeAttribute('data-ovseer-picked'))
  const el = e.target as Element
  el.setAttribute('data-ovseer-picked', '')
  target.value = describe(el)
  box.value?.focus()
}
/** Estilos que a janela põe na tela: só a página da aba aparece; no modo de seleção, o contorno do elemento */
function applyHelpers() {
  const d = frameDoc()
  if (!d) return
  d.querySelectorAll(`[${HELPER}]`).forEach((x) => x.remove())
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8875a'
  const sections = [...d.querySelectorAll('section[data-tela]')]
  sections.forEach((s, i) => (i === page.value ? s.setAttribute('data-ovseer-active', '') : s.removeAttribute('data-ovseer-active')))
  const st = d.createElement('style')
  st.setAttribute(HELPER, '')
  st.textContent =
    (sections.length > 1 ? 'section[data-tela]:not([data-ovseer-active]) { display: none !important; }' : '') +
    (selecting.value ? `* { cursor: default !important; } [data-ovseer-hover] { outline: 2px solid ${accent}99 !important; outline-offset: 2px; }` : '') +
    `[data-ovseer-picked] { outline: 2px solid ${accent} !important; outline-offset: 2px; }`
  d.head?.appendChild(st)
}
function onFrameLoad() {
  const d = frameDoc()
  if (!d) return
  d.addEventListener('click', onFrameClick, true)
  d.addEventListener('submit', (e) => e.preventDefault(), true)
  d.addEventListener('mouseover', onFrameOver, true)
  applyHelpers()
}
watch([page, selecting], applyHelpers)
function clearTarget() {
  target.value = null
  frameDoc()?.querySelectorAll('[data-ovseer-picked], [data-ovseer-hover]').forEach((x) => {
    x.removeAttribute('data-ovseer-picked')
    x.removeAttribute('data-ovseer-hover')
  })
}
function toggleSelect() {
  if (running.value || done.value || !version.value) return
  selecting.value = !selecting.value
  if (!selecting.value) clearTarget()
}
// outra versão na tela, ou uma nova sendo desenhada: a seleção não vale mais
watch([() => design.value?.current, running], () => {
  selecting.value = false
  target.value = null
})

// ---------- histórico de versões ----------
const historyOpen = ref(false)
const historyRoot = ref<HTMLElement>()
const historyRows = computed(() =>
  versions.value
    .map((v, i) => ({ i, title: v.note ? v.note : 'Criação do conceito', sub: `${i === versions.value.length - 1 ? 'Atual' : `Versão ${i + 1}`}${design.value?.approved === i ? ' · aprovada' : ''}` }))
    .reverse()
)
function showVersion(i: number) {
  historyOpen.value = false
  act({ type: 'select', index: i })
}
const onDocDown = (e: MouseEvent) => {
  if (historyOpen.value && historyRoot.value && !historyRoot.value.contains(e.target as Node)) historyOpen.value = false
}

// ---------- conversa com o agente de design ----------
const note = ref('')
const box = ref<HTMLTextAreaElement>()
const log = ref<HTMLElement>()
const SUGGESTIONS = ['Reescrever textos', 'Mais contraste', 'Mais compacto']
// anexos: os mesmos caminhos do campo da conversa (os arquivos ficam guardados para a janela do agente `uid`)
type Shown = AgentAttachment & { preview?: string }
const pending = reactive<Shown[]>([])
const attachError = ref<string | null>(null)
const dragging = ref(false)
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const isImage = (type: string, name: string) => /^image\//.test(type) || /\.(png|jpe?g|gif|webp)$/i.test(name)
const PREVIEW_MAX = 25 * 1024 * 1024
function pushPending(a: Shown) {
  if (pending.some((x) => x.path === a.path)) return
  if (pending.length >= 20) return void (attachError.value = 'Máximo de 20 anexos por mensagem.')
  pending.push(a)
}
async function pickFiles() {
  attachError.value = null
  try {
    for (const a of await api.agentPickFiles(uid)) {
      pushPending(a)
      const added = pending.find((x) => x.path === a.path)
      if (added && added.kind === 'image' && !added.preview) api.agentImage(a.path).then((url) => url && (added.preview = url)).catch(() => undefined)
    }
  } catch (e) {
    attachError.value = clean(e)
  }
}
/** Arquivos arrastados (têm caminho) ou colados (só bytes): os sem caminho são guardados pelo app */
async function addFiles(files: File[]) {
  attachError.value = null
  for (const f of files) {
    try {
      const preview = isImage(f.type, f.name) && f.size <= PREVIEW_MAX ? URL.createObjectURL(new Blob([await f.arrayBuffer()], { type: f.type || 'image/png' })) : undefined
      const real = api.filePath(f)
      if (real) pushPending({ ...(await api.agentKeepFile(uid, real)), preview })
      else {
        const name = f.name && f.name !== 'image.png' ? f.name : `colado-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
        pushPending({ ...(await api.agentSaveBlob(uid, { name, type: f.type, data: await f.arrayBuffer() })), preview })
      }
    } catch (e) {
      attachError.value = clean(e)
    }
  }
}
function removePending(i: number) {
  const [a] = pending.splice(i, 1)
  if (a?.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
}
function onDrop(e: DragEvent) {
  dragging.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length && canRevise.value) addFiles(files)
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
  if (!files.length) return
  e.preventDefault()
  addFiles(files)
}
/** Dá para pedir uma revisão: há uma versão, nada rodando e o conceito ainda em aberto */
const canRevise = computed(() => !running.value && !done.value && versions.value.length > 0)
function send(text = note.value) {
  const t = text.trim()
  if ((!t && !pending.length) || !canRevise.value) return
  // a prévia é só desta tela; o pedido vai para a outra janela sem ela
  const attachments = pending.splice(0, pending.length).map(({ preview: _p, ...a }) => a)
  act({ type: 'revise', note: t || (attachments.length === 1 ? 'Use o arquivo anexado como referência.' : 'Use os arquivos anexados como referência.'), target: target.value ?? undefined, attachments })
  note.value = ''
  attachError.value = null
  selecting.value = false
  target.value = null
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
/** "+" nas abas: uma página nova é um pedido ao agente */
function newPage() {
  if (running.value || done.value) return
  note.value = 'Crie também a tela: '
  nextTick(() => box.value?.focus())
}
const status = computed(() => (running.value ? 'Desenhando…' : approved.value ? 'Aprovado' : design.value?.approved === 'skipped' ? 'Pulado' : versions.value.length ? 'Pronto' : 'Aguardando'))
watch(
  () => [versions.value.length, running.value, state.value?.activity.length],
  () => nextTick(() => log.value && (log.value.scrollTop = log.value.scrollHeight))
)

onMounted(async () => {
  document.addEventListener('mousedown', onDocDown)
  const s = await api.getSettings().catch(() => null)
  applyTheme(s?.theme)
  offs.push(api.onSettingsChanged((x) => applyTheme(x.theme)))
  offs.push(api.onDesignState((u, st) => u === uid && (state.value = st)))
  state.value = await api.designState(uid).catch(() => null)
  api.knownModels().then((k) => (known.value = k)).catch(() => undefined)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocDown)
  offs.forEach((f) => f())
})
</script>

<template>
  <div class="dw">
    <!-- conversa com o agente de design -->
    <aside class="chat">
      <header class="chat-head">
        <span class="mark"><AgentLogo :source="provider" :size="14" /></span>
        <strong>Agente de design</strong>
        <small class="status" :class="{ live: running }">{{ status }}</small>
      </header>

      <div ref="log" class="log">
        <p v-if="!state" class="faint empty">Abrindo o design…</p>
        <template v-else>
          <div class="bubble user">{{ state.request || 'Conceito visual do que foi pedido.' }}</div>
          <template v-for="(v, i) in versions" :key="i">
            <template v-if="i > 0">
              <small v-if="v.target" class="at">@{{ v.target }}</small>
              <div class="bubble user">{{ v.note }}</div>
            </template>
            <div v-if="v.attachments?.length" class="sent-atts">
              <span v-for="a in v.attachments" :key="a.path" class="att" :title="a.path"><Icon :name="a.kind === 'image' ? 'panel' : 'paperclip'" :size="11" /> <span class="ellipsis">{{ a.name }}</span></span>
            </div>
            <ul v-if="v.activity?.length" class="acts">
              <li v-for="(a, n) in v.activity" :key="n">{{ a }}</li>
            </ul>
            <p class="say">{{ v.summary || (i ? 'Revisão aplicada.' : 'Primeira versão do conceito pronta. Clique em Selecionar e depois num elemento da tela para pedir mudanças nele.') }}</p>
            <div v-if="i === 0 && designScreens(v.html).length > 1" class="pages">
              <button v-for="(s, n) in designScreens(v.html)" :key="s" type="button" class="ghost chip" @click="showVersion(i), (page = n)"><Icon name="panel" :size="11" /> {{ pageLabel(s) }}</button>
            </div>
            <button type="button" class="ghost chip see" :disabled="running || design?.current === i" @click="showVersion(i)">
              {{ design?.current === i && !running ? (i === versions.length - 1 ? 'Versão atual' : 'Em exibição') : 'Ver esta versão' }}
            </button>
          </template>
          <!-- versão em andamento -->
          <template v-if="running">
            <template v-if="versions.length">
              <small v-if="state.target" class="at">@{{ state.target }}</small>
              <div class="bubble user">{{ state.note }}</div>
            </template>
            <div v-if="state.attachments.length" class="sent-atts">
              <span v-for="a in state.attachments" :key="a.path" class="att" :title="a.path"><Icon :name="a.kind === 'image' ? 'panel' : 'paperclip'" :size="11" /> <span class="ellipsis">{{ a.name }}</span></span>
            </div>
            <ul v-if="state.activity.length" class="acts">
              <li v-for="(a, n) in state.activity" :key="n">{{ a }}</li>
            </ul>
            <p class="say working"><span class="ring" /> Desenhando{{ state.live ? ` · ${state.live.split('\n').length} linhas` : '…' }}</p>
          </template>
          <p v-if="error" class="err">{{ error }} <button type="button" class="ghost link" @click="(localError = null), act({ type: 'retry' })">Tentar de novo</button></p>
          <p v-if="done" class="say ok"><Icon :name="approved ? 'check' : 'forward'" :size="12" /> {{ approved ? `Conceito aprovado (versão ${(design!.approved as number) + 1}). O plano completo segue na conversa.` : 'Conceito pulado.' }}</p>
        </template>
      </div>

      <footer v-if="state && !done" class="chat-foot">
        <div v-if="versions.length && !running" class="sugs">
          <button v-for="s in SUGGESTIONS" :key="s" type="button" class="ghost chip" @click="send(s)">{{ s }}</button>
        </div>
        <div class="composer" :class="{ off: running || !versions.length, drop: dragging }" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
          <div v-if="dragging" class="drop-hint"><Icon name="paperclip" :size="13" /> Solte para anexar</div>
          <div v-if="pending.length" class="pending">
            <template v-for="(a, i) in pending" :key="a.path">
              <span v-if="a.preview" class="thumb" :title="a.name">
                <img :src="a.preview" :alt="a.name" />
                <button type="button" class="thumb-rm" title="Remover" @click.stop="removePending(i)"><Icon name="x" :size="10" /></button>
              </span>
              <span v-else class="att" :title="a.path">
                <Icon :name="a.kind === 'image' ? 'panel' : 'paperclip'" :size="11" /> <span class="ellipsis">{{ a.name }}</span>
                <button type="button" class="ghost rm" title="Remover" @click="removePending(i)"><Icon name="x" :size="10" /></button>
              </span>
            </template>
          </div>
          <p v-if="attachError" class="err small-err">{{ attachError }}</p>
          <span v-if="target" class="tag" :title="target.ref">@ {{ target.label }} <button type="button" class="ghost rm" title="Tirar o elemento" @click="clearTarget"><Icon name="x" :size="10" /></button></span>
          <textarea
            ref="box"
            v-model="note"
            rows="1"
            :placeholder="target ? `Peça uma mudança em ${target.label}…` : versions.length ? 'Peça uma mudança no design…' : 'As revisões ficam disponíveis depois da primeira versão'"
            :disabled="running || !versions.length"
            maxlength="4000"
            @keydown="onKey"
            @paste="onPaste"
          />
          <div class="row">
            <button type="button" class="ghost icon attach" title="Anexar arquivos (ou arraste/cole aqui)" :disabled="!canRevise" @click="pickFiles"><Icon name="paperclip" :size="14" /></button>
            <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" providers no-fast :disabled="running" :known="known" />
            <span class="spacer" />
            <button v-if="running" type="button" class="icon send stop" title="Interromper" @click="act({ type: 'cancel' })"><Icon name="stop" :size="14" /></button>
            <button v-else type="button" class="icon send primary" title="Enviar (Enter)" :disabled="(!note.trim() && !pending.length) || !versions.length" @click="send()"><Icon name="up" :size="15" /></button>
          </div>
        </div>
      </footer>
    </aside>

    <!-- a tela do conceito -->
    <main class="canvas">
      <nav class="tabs">
        <template v-if="screens.length">
          <button v-for="(s, i) in screens" :key="s" type="button" class="tab" :class="{ on: page === i }" @click="page = i">{{ pageLabel(s) }}</button>
        </template>
        <span v-else class="tab on">Conceito</span>
        <button v-if="!done" type="button" class="tab plus" title="Pedir uma tela nova ao agente" :disabled="running" @click="newPage"><Icon name="plus" :size="12" /></button>
      </nav>

      <div class="tools">
        <span class="seg" role="group" aria-label="Largura da tela">
          <button type="button" :class="{ on: width === 'desktop' }" @click="width = 'desktop'"><Icon name="monitor" :size="13" /> Desktop</button>
          <button type="button" :class="{ on: width === 'mobile' }" @click="width = 'mobile'"><Icon name="panel" :size="13" /> Mobile</button>
        </span>
        <button v-if="!done" type="button" class="tool" :class="{ on: selecting }" :disabled="running || !version" title="Clique num elemento da tela para pedir uma mudança nele" @click="toggleSelect"><Icon name="compose" :size="13" /> Selecionar</button>
        <span class="spacer" />
        <template v-if="state && !done">
          <button type="button" class="ghost small" :disabled="running" title="Segue para o plano sem conceito visual" @click="act({ type: 'skip' })">Pular conceito</button>
          <button type="button" class="small primary" :disabled="running || !version" title="Aprova a versão em exibição e segue para o plano completo" @click="act({ type: 'approve' })"><Icon name="check" :size="12" /> Aprovar conceito</button>
        </template>
        <div ref="historyRoot" class="history">
          <button type="button" class="tool" :class="{ on: historyOpen }" :disabled="!versions.length || running" @click="historyOpen = !historyOpen"><Icon name="history" :size="13" /> Histórico</button>
          <div v-if="historyOpen" class="menu">
            <button v-for="r in historyRows" :key="r.i" type="button" class="ghost item" :class="{ cur: design?.current === r.i }" @click="showVersion(r.i)">
              <span class="dot" />
              <span class="item-t"><strong>{{ r.title }}</strong><small>{{ r.sub }}</small></span>
            </button>
          </div>
        </div>
      </div>

      <div class="stage" :class="width">
        <!-- isolado: sem scripts e sem cargas de fora (ver previewDocument); a janela só lê os cliques da seleção -->
        <iframe v-if="doc" ref="frame" class="frame" sandbox="allow-same-origin" :srcdoc="doc" title="Conceito visual" @load="onFrameLoad" />
        <div v-else class="blank">
          <template v-if="running"><span class="ring" /><strong>Desenhando o conceito…</strong><small class="faint">A tela aparece assim que o HTML começar a chegar.</small></template>
          <template v-else-if="error"><strong>Não deu para desenhar</strong><small class="faint">{{ error }}</small><button type="button" class="small" @click="(localError = null), act({ type: 'retry' })">Tentar de novo</button></template>
          <template v-else-if="state"><strong>Sem conceito ainda</strong><button type="button" class="small primary" @click="act({ type: 'retry' })">Desenhar o conceito</button></template>
        </div>
        <div v-if="selecting && !target" class="float"><Icon name="compose" :size="12" /> Clique no elemento que você quer mudar</div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.dw { display: grid; grid-template-columns: minmax(280px, 320px) minmax(0, 1fr); height: 100vh; background: var(--bg); color: var(--text); }
.spacer { flex: 1 1 auto; }
/* ---- conversa ---- */
.chat { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.chat-head { flex: none; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px; border-bottom: 1px solid var(--border); }
.mark { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--accent-soft); flex: none; }
.chat-head strong { font-size: 13px; font-weight: 600; flex: 1; min-width: 0; }
.status { font-size: 11.5px; color: var(--faint); }
.status.live { color: var(--accent); }
.log { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 1.5; }
.empty { margin: auto; }
.bubble.user { align-self: flex-end; max-width: 88%; padding: 8px 12px; border-radius: 12px 12px 4px 12px; background: var(--panel-2); border: 1px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; margin-top: 6px; }
.at { align-self: flex-end; margin: 8px 2px -4px; font-family: var(--mono); font-size: 11px; color: var(--accent); }
/* o que o agente fez no caminho: linhas discretas com um fio à esquerda */
.acts { list-style: none; margin: 4px 0 0; padding: 0 0 0 10px; border-left: 2px solid var(--border); display: flex; flex-direction: column; gap: 2px; font-family: var(--mono); font-size: 11px; color: var(--faint); }
.say { margin: 0; color: var(--text); user-select: text; }
.say.working { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.say.ok { display: flex; align-items: flex-start; gap: 6px; color: var(--add); margin-top: 6px; }
.err { margin: 0; color: var(--del); font-size: 12.5px; }
.pages { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 26px; padding: 0 10px; gap: 6px; border-radius: 8px; border: 1px solid var(--border); font-size: 12px; font-weight: 500; color: var(--text); }
.chip:hover:not(:disabled) { background: var(--hover); }
.chip.see { align-self: flex-start; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.chip.see:disabled { opacity: 1; color: var(--faint); cursor: default; }
.chat-foot { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; }
.sugs { display: flex; flex-wrap: wrap; gap: 6px; }
.sugs .chip { border-radius: 999px; color: var(--muted); }
.sugs .chip:hover { color: var(--text); }
.composer { display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 6px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg); }
.composer:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.composer.off { opacity: 0.65; }
.tag { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 4px 0 8px; border-radius: 6px; font-family: var(--mono); font-size: 11px; color: var(--accent); background: var(--accent-soft); }
.tag .rm { width: 16px; height: 16px; padding: 0; color: inherit; }
.composer textarea { border: 0; background: transparent; padding: 2px 0; font-size: 13px; line-height: 1.45; resize: none; max-height: 120px; field-sizing: content; width: 100%; }
.composer textarea:focus { box-shadow: none; }
.composer .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.send { width: 28px; height: 28px; border-radius: 50%; flex: none; }
/* anexos: os mesmos elementos do campo da conversa */
.composer.drop { border-color: var(--accent); background: var(--accent-soft); }
.drop-hint { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 2px; color: var(--accent); font-weight: 600; font-size: 12px; }
.attach { width: 28px; height: 28px; border-radius: 50%; color: var(--muted); flex: none; }
.pending, .sent-atts { display: flex; flex-wrap: wrap; gap: 6px; }
.sent-atts { justify-content: flex-end; }
.att { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 6px 0 7px; max-width: 220px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--border); font-size: 11.5px; color: var(--muted); }
.att .rm { width: 16px; height: 16px; padding: 0; color: var(--faint); flex: none; }
.thumb { position: relative; display: block; width: 52px; height: 52px; flex: none; border-radius: 9px; overflow: hidden; border: 1px solid var(--border); background: var(--panel-2); }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-rm { position: absolute; top: 3px; right: 3px; width: 17px; height: 17px; padding: 0; border-radius: 50%; border: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); color: #fff; cursor: pointer; }
.small-err { font-size: 12px; }
.send.stop { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
/* ---- tela ---- */
.canvas { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.tabs { flex: none; display: flex; align-items: stretch; gap: 2px; height: 40px; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--panel); overflow-x: auto; }
.tab { position: relative; display: inline-flex; align-items: center; padding: 0 14px; border: 0; background: transparent; color: var(--muted); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.tab:hover:not(:disabled) { color: var(--text); }
.tab.on { color: var(--text); }
.tab.on::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 1px; background: var(--accent); }
.tab.plus { padding: 0 10px; color: var(--faint); }
.tools { flex: none; display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--panel); min-width: 0; }
.seg { display: inline-flex; padding: 3px; border-radius: 9px; background: var(--bg); border: 1px solid var(--border); flex: none; }
.seg button { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 12px; font-weight: 500; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--panel-2); color: var(--text); }
.tool { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 12px; font-weight: 500; flex: none; }
.tool:hover:not(:disabled) { background: var(--hover); }
.tool.on { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.tools .small { height: 30px; gap: 6px; flex: none; }
.history { position: relative; flex: none; }
.menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 290px; max-height: 340px; overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); }
.item { justify-content: flex-start; align-items: flex-start; gap: 10px; height: auto; padding: 8px 10px; text-align: left; white-space: normal; color: var(--text); }
.item.cur { background: var(--hover); }
.item .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); margin-top: 6px; flex: none; }
.item.cur .dot { background: var(--accent); }
.item-t { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.item-t strong { font-size: 12.5px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.item-t small { font-size: 11px; color: var(--muted); }
/* o fundo pontilhado da mesa de trabalho; a tela fica centrada, na largura escolhida */
.stage { position: relative; flex: 1; min-height: 0; display: flex; justify-content: center; padding: 28px; overflow: auto; background-color: var(--bg); background-image: radial-gradient(color-mix(in srgb, var(--faint) 35%, transparent) 1px, transparent 1px); background-size: 18px 18px; }
.frame { flex: 1; width: 100%; height: 100%; max-width: 1280px; border: 0; border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); }
.stage.mobile .frame { flex: none; width: 390px; max-width: 100%; }
.blank { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; max-width: 320px; font-size: 13px; }
.blank small { font-size: 12px; line-height: 1.4; }
.blank .small { margin-top: 6px; }
.float { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 14px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); font-size: 12px; pointer-events: none; white-space: nowrap; }
.ring { width: 14px; height: 14px; border-radius: 50%; flex: none; box-sizing: border-box; border: 2.5px solid color-mix(in srgb, var(--faint) 30%, transparent); border-top-color: var(--accent); border-right-color: var(--accent); animation: dw-turn 1s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes dw-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
</style>
