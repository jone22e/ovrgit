<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AgentEffort, CliProvider, KnownModels } from '@shared/types'
import { designScreens, previewDocument, type ArchState } from '@shared/architect'
import Icon from './Icon.vue'
import ModelPicker from './ModelPicker.vue'

/**
 * Modo de design do Modo Arquiteto: um painel ao lado da conversa, à parte dela. No espírito do Claude Design:
 * uma tela (o mockup em HTML, isolado e sem scripts) com uma barra de ferramentas por cima. O layout é
 * refinado por conversa (o campo de revisão), por comentário num elemento (clica no elemento e diz o que mudar)
 * ou por edição direta do texto; as versões ficam num menu, e a largura da tela tem nome (Desktop, Tablet,
 * Celular). O design tem a sua própria IA. Quem usa faz os pedidos; aqui é só a tela.
 */
const props = defineProps<{
  design: NonNullable<ArchState['design']>
  /** Uma versão está sendo desenhada agora */
  running: boolean
  /** HTML parcial da versão em andamento (a prévia acompanha) */
  live: string
  /** O que a IA do design está fazendo agora ("Lendo styles.css") */
  activity: string
  error: string | null
  known: KnownModels | null
}>()
const emit = defineEmits<{
  revise: [note: string]
  retry: []
  approve: []
  skip: []
  cancel: []
  close: []
  select: [index: number]
  ai: [provider: CliProvider, model: string, effort: AgentEffort]
  /** Texto editado direto na tela: vira uma versão nova, sem passar pela IA */
  edited: [html: string]
}>()

const provider = ref<CliProvider>(props.design.provider)
const model = ref(props.design.model)
const effort = ref<AgentEffort>(props.design.effort as AgentEffort)
watch([provider, model, effort], () => emit('ai', provider.value, model.value, effort.value))

const BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', width: 0 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Celular', width: 390 }
] as const
const breakpoint = ref<(typeof BREAKPOINTS)[number]['id']>('desktop')
const frameWidth = computed(() => BREAKPOINTS.find((b) => b.id === breakpoint.value)?.width || 0)

const note = ref('')
const approved = computed(() => typeof props.design.approved === 'number')
const done = computed(() => props.design.approved !== undefined)
const version = computed(() => props.design.versions[props.design.current])
/** O que a tela mostra: a versão em andamento enquanto desenha; senão a versão escolhida */
const html = computed(() => (props.running ? props.live : (version.value?.html ?? '')))
const doc = computed(() => (html.value ? previewDocument(html.value) : ''))
const screens = computed(() => designScreens(html.value))
const lines = computed(() => (props.live ? props.live.split('\n').length : 0))
/** Só a pasta e o nome do arquivo salvo (o caminho inteiro fica na dica) */
const shortFile = computed(() => (props.design.file ?? '').split(/[\\/]/).slice(-2).join('/'))

// ---------- versões: um menu com o que cada uma mudou ----------
const versionsOpen = ref(false)
const versionsRoot = ref<HTMLElement>()
const when = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
function pickVersion(i: number) {
  versionsOpen.value = false
  emit('select', i)
}
const onDoc = (e: MouseEvent) => {
  if (versionsOpen.value && versionsRoot.value && !versionsRoot.value.contains(e.target as Node)) versionsOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onUnmounted(() => document.removeEventListener('mousedown', onDoc))

// ---------- ferramentas sobre a tela: comentar num elemento e editar o texto ----------
type Tool = 'comment' | 'edit' | null
const tool = ref<Tool>(null)
const frame = ref<HTMLIFrameElement>()
/** Elemento escolhido para o comentário, descrito para a IA e para o usuário */
const target = ref<{ label: string; ref: string } | null>(null)
const HELPER = 'data-ovseer-helper'
const frameDoc = () => frame.value?.contentDocument ?? null
const KIND: Record<string, string> = {
  button: 'botão', a: 'link', input: 'campo', select: 'seletor', textarea: 'campo', table: 'tabela', th: 'cabeçalho da tabela', td: 'célula', tr: 'linha da tabela',
  h1: 'título', h2: 'título', h3: 'título', h4: 'título', p: 'texto', img: 'imagem', svg: 'ícone', nav: 'menu', aside: 'barra lateral', header: 'cabeçalho', footer: 'rodapé',
  section: 'seção', label: 'rótulo', li: 'item da lista', ul: 'lista', form: 'formulário'
}
function describe(el: Element): { label: string; ref: string } {
  const tag = el.tagName.toLowerCase()
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const screen = el.closest('section[data-tela]')?.getAttribute('data-tela')
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
  const kind = KIND[tag] ?? 'elemento'
  return {
    label: text ? `${kind} «${text}»` : kind,
    ref: `<${tag}${cls ? ` class="${cls}"` : ''}>${text ? ` com o texto "${text}"` : ''}${screen ? ` (tela "${screen}")` : ''}`
  }
}
let hovered: Element | null = null
function onFrameOver(e: Event) {
  if (tool.value !== 'comment') return
  hovered?.removeAttribute('data-ovseer-hover')
  hovered = e.target as Element
  hovered.setAttribute('data-ovseer-hover', '')
}
function onFrameClick(e: Event) {
  // a tela é um mockup: nenhum link navega e nenhum formulário envia
  e.preventDefault()
  if (tool.value !== 'comment') return
  e.stopPropagation()
  frameDoc()?.querySelectorAll('[data-ovseer-picked]').forEach((x) => x.removeAttribute('data-ovseer-picked'))
  const el = e.target as Element
  el.setAttribute('data-ovseer-picked', '')
  target.value = describe(el)
}
/** A cada carga da tela: bloqueia a navegação e reaplica a ferramenta em uso */
function onFrameLoad() {
  const d = frameDoc()
  if (!d) return
  d.addEventListener('click', onFrameClick, true)
  d.addEventListener('submit', (e) => e.preventDefault(), true)
  d.addEventListener('mouseover', onFrameOver, true)
  applyTool()
}
function applyTool() {
  const d = frameDoc()
  if (!d) return
  d.querySelectorAll(`[${HELPER}]`).forEach((x) => x.remove())
  d.designMode = tool.value === 'edit' ? 'on' : 'off'
  if (tool.value === 'comment') {
    const st = d.createElement('style')
    st.setAttribute(HELPER, '')
    st.textContent = '* { cursor: crosshair !important; } [data-ovseer-hover] { outline: 2px solid #7c5cff !important; outline-offset: 1px; } [data-ovseer-picked] { outline: 2px solid #7c5cff !important; outline-offset: 1px; box-shadow: 0 0 0 4px rgba(124, 92, 255, 0.25) !important; }'
    d.head?.appendChild(st)
  }
}
function setTool(t: Tool) {
  if (props.running || done.value) return
  if (tool.value === 'edit' && t !== 'edit') discardEdit()
  tool.value = tool.value === t ? null : t
  if (tool.value !== 'comment') clearTarget()
  applyTool()
}
function clearTarget() {
  target.value = null
  const d = frameDoc()
  d?.querySelectorAll('[data-ovseer-picked], [data-ovseer-hover]').forEach((x) => {
    x.removeAttribute('data-ovseer-picked')
    x.removeAttribute('data-ovseer-hover')
  })
}
/** Edição direta: o HTML da tela, sem o que a prévia acrescentou, vira uma versão nova */
function saveEdit() {
  const d = frameDoc()
  if (!d) return
  d.designMode = 'off'
  d.querySelectorAll(`[${HELPER}], meta[http-equiv="Content-Security-Policy"]`).forEach((x) => x.remove())
  d.querySelectorAll('[data-ovseer-picked], [data-ovseer-hover]').forEach((x) => {
    x.removeAttribute('data-ovseer-picked')
    x.removeAttribute('data-ovseer-hover')
  })
  const out = `<!doctype html>\n${d.documentElement.outerHTML}`
  tool.value = null
  if (out.replace(/\s+/g, '') !== (version.value?.html ?? '').replace(/\s+/g, '')) emit('edited', out)
}
/** Sai da edição sem guardar: a tela volta ao HTML da versão */
function discardEdit() {
  const f = frame.value
  if (f && doc.value) f.srcdoc = doc.value
}
// trocar de versão ou começar a desenhar solta a ferramenta
watch([() => props.design.current, () => props.running], () => {
  tool.value = null
  target.value = null
})

function send() {
  const t = note.value.trim()
  if (!t || props.running) return
  // comentário num elemento: a IA recebe qual elemento é
  const full = target.value ? `Sobre o elemento ${target.value.ref}: ${t}` : t
  note.value = ''
  tool.value = null
  target.value = null
  emit('revise', full)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <aside class="design">
    <header class="d-head">
      <span class="d-title"><Icon name="layers" :size="14" /> Design</span>
      <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" providers :disabled="running" :known="known" />
      <span class="spacer" />
      <!-- versões: a atual no botão; o menu lista todas, com o que cada uma mudou -->
      <div v-if="design.versions.length || running" ref="versionsRoot" class="d-versions">
        <button type="button" class="ghost d-ver" :class="{ on: versionsOpen }" :disabled="running || design.versions.length < 2" title="Versões do conceito" @click="versionsOpen = !versionsOpen">
          <Icon name="history" :size="12" />
          {{ running ? `Versão ${design.versions.length + 1}` : `Versão ${design.current + 1} de ${design.versions.length}` }}
          <Icon v-if="design.versions.length > 1 && !running" name="chevron" :size="10" class="chev" />
        </button>
        <div v-if="versionsOpen" class="d-menu">
          <button v-for="(v, i) in design.versions" :key="i" type="button" class="ghost d-item" :class="{ cur: design.current === i }" @click="pickVersion(i)">
            <span class="d-item-n">v{{ i + 1 }}</span>
            <span class="d-item-t">
              <strong>{{ v.note ? v.note : 'Primeira versão' }}</strong>
              <small>{{ when(v.at) }}{{ design.approved === i ? ' · aprovada' : '' }}</small>
            </span>
            <Icon v-if="design.current === i" name="check" :size="12" class="ok" />
          </button>
        </div>
      </div>
      <button type="button" class="ghost icon d-close" title="Fechar o painel de design (o conceito continua guardado)" @click="emit('close')"><Icon name="x" :size="13" /></button>
    </header>

    <!-- barra de ferramentas da tela: como refinar (comentar, editar) e em que largura ver -->
    <div class="d-tools">
      <template v-if="!done">
        <button type="button" class="ghost d-tool" :class="{ on: tool === 'comment' }" :disabled="running || !version" title="Clique num elemento da tela e diga o que mudar nele" @click="setTool('comment')">
          <Icon name="compose" :size="13" /> Comentar
        </button>
        <button type="button" class="ghost d-tool" :class="{ on: tool === 'edit' }" :disabled="running || !version" title="Edite os textos direto na tela" @click="setTool('edit')">
          <Icon name="pencil" :size="13" /> Editar texto
        </button>
        <template v-if="tool === 'edit'">
          <button type="button" class="small primary d-save" @click="saveEdit">Salvar como nova versão</button>
          <button type="button" class="ghost small" @click="setTool(null)">Descartar</button>
        </template>
      </template>
      <span class="spacer" />
      <span class="d-seg" role="group" aria-label="Largura da tela">
        <button v-for="b in BREAKPOINTS" :key="b.id" type="button" :class="{ on: breakpoint === b.id }" :title="b.width ? `${b.width} px` : 'Largura inteira'" @click="breakpoint = b.id">{{ b.label }}</button>
      </span>
    </div>

    <div class="stage" :class="{ narrow: frameWidth }">
      <!-- isolado: sem scripts e sem cargas de fora (ver previewDocument); o painel só lê os cliques para os comentários -->
      <iframe v-if="doc" ref="frame" class="frame" :style="frameWidth ? { width: `${frameWidth}px` } : undefined" sandbox="allow-same-origin" :srcdoc="doc" title="Conceito visual" @load="onFrameLoad" />
      <div v-else class="blank">
        <template v-if="running">
          <span class="d-ring" />
          <strong>Desenhando o conceito…</strong>
          <small class="faint">{{ activity || 'A tela aparece assim que o HTML começar a chegar.' }}</small>
        </template>
        <template v-else-if="error">
          <Icon name="alert" :size="18" class="bad" />
          <strong>Não deu para desenhar</strong>
          <small class="faint">{{ error }}</small>
          <button type="button" class="small" @click="emit('retry')">Tentar de novo</button>
        </template>
        <template v-else>
          <strong>Sem conceito ainda</strong>
          <button type="button" class="small primary" @click="emit('retry')">Desenhar o conceito</button>
        </template>
      </div>
      <div v-if="running && doc" class="live">
        <span class="d-ring" /> Desenhando · {{ lines }} linhas<template v-if="activity"> · {{ activity }}</template>
        <button type="button" class="ghost stop" title="Interromper" @click="emit('cancel')"><Icon name="stop" :size="11" /></button>
      </div>
      <div v-else-if="tool === 'comment' && !target" class="live hint"><Icon name="compose" :size="12" /> Clique no elemento que você quer mudar</div>
      <div v-else-if="tool === 'edit'" class="live hint"><Icon name="pencil" :size="12" /> Clique num texto e digite; depois salve como nova versão</div>
    </div>

    <p v-if="screens.length > 1" class="screens faint">{{ screens.length }} telas: {{ screens.join(' · ') }}</p>
    <p v-if="error && doc" class="d-err">{{ error }} <button type="button" class="ghost link" @click="emit('retry')">Tentar de novo</button></p>

    <footer class="d-foot">
      <template v-if="!done">
        <div class="revise" :class="{ off: running || !design.versions.length }">
          <span v-if="target" class="d-target" :title="target.ref">
            <Icon name="compose" :size="11" /> <span class="ellipsis">Sobre: {{ target.label }}</span>
            <button type="button" class="ghost rm" title="Tirar o elemento: vira uma revisão geral" @click="clearTarget"><Icon name="x" :size="10" /></button>
          </span>
          <div class="revise-row">
            <textarea
              v-model="note"
              rows="1"
              :placeholder="target ? 'O que mudar neste elemento' : design.versions.length ? 'Peça uma revisão do layout' : 'As revisões ficam disponíveis depois da primeira versão'"
              :disabled="running || !design.versions.length"
              maxlength="4000"
              @keydown="onKey"
            />
            <button type="button" class="icon send primary" title="Pedir a revisão (Enter)" :disabled="running || !note.trim()" @click="send"><Icon name="up" :size="15" /></button>
          </div>
        </div>
        <div class="d-acts">
          <button v-if="running" type="button" class="small" @click="emit('cancel')"><Icon name="stop" :size="11" /> Interromper</button>
          <button type="button" class="ghost small" :disabled="running" title="Segue para o plano sem conceito visual" @click="emit('skip')">Pular conceito</button>
          <button type="button" class="small primary" :disabled="running || !version || tool === 'edit'" title="Aprova a versão em exibição e segue para o plano completo" @click="emit('approve')">
            <Icon name="check" :size="12" /> Aprovar {{ version ? `versão ${design.current + 1}` : 'conceito' }}
          </button>
        </div>
      </template>
      <p v-else class="d-done">
        <Icon :name="approved ? 'check' : 'forward'" :size="13" />
        <span :title="design.file">{{ approved ? `Conceito aprovado (versão ${(design.approved as number) + 1})${design.file ? `, salvo em ${shortFile}` : ''}.` : 'Conceito pulado.' }}</span>
      </p>
    </footer>
  </aside>
</template>

<style scoped>
.design { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--panel); }
.d-head { flex: none; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 14px; min-width: 0; }
.d-title { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; flex: none; }
.spacer { flex: 1 1 auto; }
/* versões: botão com a atual e um menu com todas */
.d-versions { position: relative; flex: none; }
.d-ver { height: 28px; padding: 0 10px; gap: 6px; border-radius: 8px; font-size: 12px; font-weight: 500; color: var(--muted); }
.d-ver:disabled { opacity: 1; cursor: default; }
.d-ver:not(:disabled):hover, .d-ver.on { color: var(--text); background: var(--hover); }
.d-ver .chev { transform: rotate(90deg); color: var(--faint); }
.d-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 300px; max-height: 320px; overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); }
.d-item { justify-content: flex-start; align-items: flex-start; gap: 10px; height: auto; padding: 8px 10px; text-align: left; white-space: normal; color: var(--text); }
.d-item.cur { background: var(--accent-soft); }
.d-item-n { font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--muted); padding-top: 1px; flex: none; }
.d-item-t { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.d-item-t strong { font-size: 12.5px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.d-item-t small { font-size: 11px; color: var(--muted); }
.d-item .ok { color: var(--accent); flex: none; margin-top: 2px; }
.d-close { width: 26px; height: 26px; color: var(--muted); flex: none; }
/* barra de ferramentas da tela */
.d-tools { flex: none; display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); min-width: 0; }
.d-tool { height: 28px; padding: 0 10px; gap: 6px; border-radius: 8px; font-size: 12px; font-weight: 500; color: var(--muted); flex: none; }
.d-tool:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.d-tool.on { color: var(--accent); background: var(--accent-soft); }
.d-save { height: 28px; margin-left: 6px; }
.d-tools .small { height: 28px; flex: none; }
.d-seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--panel); border: 1px solid var(--border); flex: none; }
.d-seg button { height: 22px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 11.5px; font-weight: 500; }
.d-seg button:hover { color: var(--text); }
.d-seg button.on { background: var(--panel-2); color: var(--text); font-weight: 600; }
/* a tela: o mockup sobre um fundo neutro; em Tablet e Celular, uma coluna na largura escolhida, centrada */
.stage { position: relative; flex: 1; min-height: 0; display: flex; justify-content: center; padding: 14px; background: var(--bg); overflow: auto; }
.frame { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: #fff; flex: none; max-width: 100%; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18); }
.stage:not(.narrow) .frame { flex: 1; }
.blank { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; max-width: 320px; font-size: 13px; }
.blank small { font-size: 12px; line-height: 1.4; }
.blank .small { margin-top: 6px; }
.bad { color: var(--del); }
.live { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px 0 12px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); font-size: 12px; color: var(--muted); white-space: nowrap; max-width: calc(100% - 40px); overflow: hidden; pointer-events: auto; }
.live.hint { padding: 0 14px; color: var(--text); pointer-events: none; }
.live .stop { width: 22px; height: 22px; padding: 0; border-radius: 50%; color: var(--muted); flex: none; }
.d-ring { width: 14px; height: 14px; border-radius: 50%; flex: none; box-sizing: border-box; border: 2.5px solid color-mix(in srgb, var(--faint) 30%, transparent); border-top-color: var(--accent); border-right-color: var(--accent); animation: d-turn 1s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes d-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .d-ring { animation: none; } }
.screens { flex: none; margin: 0; padding: 8px 14px 0; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.d-err { flex: none; margin: 0; padding: 6px 14px 0; font-size: 12px; color: var(--del); }
.d-foot { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; }
.revise { display: flex; flex-direction: column; gap: 6px; padding: 6px 6px 6px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg); }
.revise:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.revise.off { opacity: 0.6; }
.revise-row { display: flex; align-items: flex-end; gap: 6px; }
.revise textarea { flex: 1; min-width: 0; border: 0; background: transparent; padding: 4px 0; font-size: 13px; line-height: 1.4; resize: none; max-height: 110px; field-sizing: content; }
.revise textarea:focus { box-shadow: none; }
/* elemento escolhido para o comentário */
.d-target { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 24px; padding: 0 4px 0 8px; margin-top: 2px; border-radius: 8px; font-size: 11.5px; font-weight: 500; color: var(--accent); background: var(--accent-soft); }
.d-target .rm { width: 18px; height: 18px; padding: 0; color: inherit; flex: none; }
.send { width: 28px; height: 28px; border-radius: 50%; flex: none; }
.d-acts { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.d-acts .small { height: 28px; gap: 6px; }
.d-done { margin: 0; display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
</style>
