<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  AgentAttachment, AgentBlock, AgentChatEvent, AgentEffort, AgentMode, AgentTurn, AgentWindowInfo, CliProvider, FileRepo, GridPlacement, GridSize, KnownModels, Settings
} from '@shared/types'
import { DEFAULT_EFFORT, DEFAULT_MODEL, MODES, PROVIDER_LABEL, catalogOf, modelLabel } from '@shared/models'
import { GRID_DEFAULT, normalizeGrid } from '@shared/grid'
import { formatAnswers, splitQuestions, type AgentQuestion } from '@shared/questions'
import AgentLogo from './components/AgentLogo.vue'
import Icon from './components/Icon.vue'
import Modal from './components/Modal.vue'
import ModelPicker from './components/ModelPicker.vue'
import WindowGrid from './components/WindowGrid.vue'
import { applyTheme } from './theme'

/**
 * Janela exclusiva de um agente: só a conversa. Cada mensagem roda o CLI (Claude Code ou Codex)
 * continuando a mesma sessão; modelo e esforço podem mudar entre uma mensagem e outra.
 */
const api = window.ovseer
const uid = new URLSearchParams(location.search).get('uid') ?? ''

type Block = AgentBlock
type ToolBlock = Extract<Block, { kind: 'tool' }>
type FilesBlock = Extract<Block, { kind: 'files' }>

interface Turn extends AgentTurn {
  attachments: Shown[]
}

/** Blocos como aparecem: ferramentas seguidas viram um único grupo discreto (como nos apps do Claude e do Codex) */
type DisplayBlock = Exclude<Block, { kind: 'tool' }> | { kind: 'tools'; key: string; items: ToolBlock[] }

/** Anexo com prévia (imagens coladas/arrastadas têm os bytes aqui; as escolhidas pelo diálogo, só o caminho) */
interface Shown extends AgentAttachment {
  preview?: string
}

const info = ref<AgentWindowInfo | null>(null)
const turns = reactive<Turn[]>([])
const pending = reactive<Shown[]>([])
/** Arrasto de arquivos sobre a janela. `dragleave` dispara ao passar para um elemento filho, então o estado
 * é um contador de entradas e saídas; se ele ficar preso (o arrasto foi cancelado fora da janela),
 * o próximo movimento do mouse sem botão pressionado limpa. */
const dragging = ref(false)
let dragDepth = 0
function onDragEnter() {
  dragDepth++
  dragging.value = true
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function dragReset() {
  dragDepth = 0
  dragging.value = false
}
const attachError = ref<string | null>(null)
const draft = ref('')
const running = ref(false)
const sessionId = ref<string | null>(null)
const known = ref<KnownModels | null>(null)
/** Último modelo/esforço de cada IA, guardado pelo diálogo "Novo agente" (mesma origem: compartilhado) */
const pickerDefaults = (() => {
  try {
    const p = JSON.parse(localStorage.getItem('ovseer.agent.prefs') ?? '{}') as { model?: Record<string, string>; effort?: Record<string, AgentEffort> }
    return Object.fromEntries(
      (['claude', 'codex', 'agy'] as CliProvider[]).map((k) => [k, { model: p.model?.[k] ?? DEFAULT_MODEL[k], effort: p.effort?.[k] ?? DEFAULT_EFFORT[k] }])
    )
  } catch {
    return undefined
  }
})()
const provider = ref<CliProvider>('codex')
const model = ref('')
const effort = ref<AgentEffort>('high')
const mode = ref<AgentMode>('safe')
const thread = ref<HTMLElement>()
const box = ref<HTMLTextAreaElement>()
const fatal = ref<string | null>(null)
const offs: (() => void)[] = []

const providerName = computed(() => PROVIDER_LABEL[provider.value])
/** Situação do agente no cabeçalho: cinza sem conversa, pulsando trabalhando, check verde ao terminar, × vermelho se falhou,
 *  âmbar enquanto um cartão (perguntas do agente ou aprovação do plano) espera a resposta do usuário. */
const statusKind = computed<'idle' | 'live' | 'waiting' | 'done' | 'error'>(() => {
  if (running.value) return 'live'
  if (!turns.length) return 'idle'
  if (turns[turns.length - 1].error) return 'error'
  return showAsk.value || showPlanAsk.value ? 'waiting' : 'done'
})
const statusLabel = computed(() => ({ idle: 'sem conversa', live: 'trabalhando', waiting: 'aguardando resposta', done: 'concluído', error: 'falhou' })[statusKind.value])
/** Quanto tempo a última tarefa levou, mostrado discretamente ao lado do "concluído" */
const statusTook = computed(() => (statusKind.value === 'done' ? took(turns[turns.length - 1]?.durationMs) : ''))
const statusTitle = computed(() => ({ idle: 'A conversa ainda não começou', live: 'O agente está trabalhando', waiting: 'O agente está aguardando a sua resposta', done: 'O agente terminou a última tarefa', error: 'A última tarefa terminou com erro' })[statusKind.value])
const modeOpen = ref(false)
const modeRoot = ref<HTMLElement>()
const currentMode = computed(() => MODES.find((m) => m.id === mode.value) ?? MODES[1])
/** Modo em uso quando o usuário ativou o Plano (menu ou /plan): é para ele que a aprovação do plano volta */
const modeBeforePlan = ref<AgentMode | null>(null)
function setMode(m: AgentMode) {
  if (m === 'plan' && mode.value !== 'plan') modeBeforePlan.value = mode.value
  mode.value = m
}
const onDocClick = (e: MouseEvent) => {
  if (modeOpen.value && modeRoot.value && !modeRoot.value.contains(e.target as Node)) modeOpen.value = false
  if (sendOpen.value && sendRoot.value && !sendRoot.value.contains(e.target as Node)) sendOpen.value = false
  if (gridOpen.value && gridRoot.value && !gridRoot.value.contains(e.target as Node)) gridOpen.value = false
}

// ---------- posição da janela: grid no cabeçalho ----------
const gridOpen = ref(false)
const gridRoot = ref<HTMLElement>()
/** Colunas × linhas do grid: carregado das configurações do app ao abrir a janela; a troca é gravada lá
 * (o app também usa esse tamanho para abrir janelas novas na próxima área livre) */
const gridSize = ref<GridSize>({ ...GRID_DEFAULT })
function setGridSize(s: GridSize) {
  gridSize.value = normalizeGrid(s)
  api.saveSettings({ agentGrid: gridSize.value }).catch(() => undefined)
}
/** Escolha feita no grid: a janela vai para a área correspondente da tela e o menu fecha */
async function placeWindow(p: GridPlacement) {
  gridOpen.value = false
  await api.agentPlace(uid, p).catch(() => undefined)
}
const current = () => [...turns].reverse().find((t) => t.running) ?? null

// ---------- fonte da conversa: vem das configurações do app ----------
const fontStyle = ref<Record<string, string>>({})
function applyFont(s: Settings) {
  const name = (s.agentFont ?? '').trim().replace(/["';{}]/g, '')
  const size = Math.min(Math.max(Number(s.agentFontSize) || 14, 11), 22)
  fontStyle.value = { '--agent-size': `${size}px`, ...(name ? { fontFamily: `"${name}", var(--font)` } : {}) }
}
/** Ao voltar para a janela, relê as configurações: a fonte pode ter mudado na janela principal */
const onFocus = () => api.getSettings().then(applyFont).catch(() => undefined)

// ---------- ferramentas agrupadas ----------
/** Grupos abertos pelo usuário (chave = id da primeira ferramenta do grupo) */
const openGroups = reactive(new Set<string>())
function display(t: Turn): DisplayBlock[] {
  const out: DisplayBlock[] = []
  for (const b of t.blocks) {
    if (b.kind !== 'tool') {
      out.push(b)
      continue
    }
    const last = out[out.length - 1]
    if (last?.kind === 'tools') last.items.push(b)
    else out.push({ kind: 'tools', key: b.id, items: [b] })
  }
  return out
}
/** "8 comandos · 3 leituras · 2 edições" */
function groupSummary(items: ToolBlock[]): string {
  const n = { cmd: 0, read: 0, edit: 0, other: 0 }
  for (const i of items) {
    if (i.name === 'Bash') n.cmd++
    else if (/Read|Grep|Glob|Search|Fetch/.test(i.name)) n.read++
    else if (/Edit|Write/.test(i.name)) n.edit++
    else n.other++
  }
  const parts: string[] = []
  if (n.cmd) parts.push(`${n.cmd} ${n.cmd === 1 ? 'comando' : 'comandos'}`)
  if (n.read) parts.push(`${n.read} ${n.read === 1 ? 'leitura' : 'leituras'}`)
  if (n.edit) parts.push(`${n.edit} ${n.edit === 1 ? 'edição' : 'edições'}`)
  if (n.other) parts.push(`${n.other} ${n.other === 1 ? 'outra ação' : 'outras ações'}`)
  return parts.join(' · ')
}
const groupBusy = (items: ToolBlock[]) => items.some((i) => i.ok === null)
const groupFailed = (items: ToolBlock[]) => items.some((i) => i.ok === false)
/** Enquanto roda, mostra o que está fazendo agora */
const groupNow = (items: ToolBlock[]) => {
  const cur = items.find((i) => i.ok === null) ?? items[items.length - 1]
  return cur ? `${cur.title}${cur.detail ? ` ${cur.detail}` : ''}` : ''
}
function toggleGroup(key: string) {
  if (openGroups.has(key)) openGroups.delete(key)
  else openGroups.add(key)
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Markdown do agente → HTML seguro. */
/** Markdown da resposta. Os blocos ```question saem do texto: viram o cartão de perguntas enquanto ele está
 * ativo; em vezes já respondidas, ficam como texto comum (pergunta em negrito e opções em lista). */
function md(text: string, card: boolean) {
  const { text: rest, questions: qs } = splitQuestions(text)
  const plain = card ? '' : qs.map((q) => `\n\n**${q.text}**\n${q.options.map((o) => `- ${o.label}${o.detail ? ` — ${o.detail}` : ''}`).join('\n')}`).join('')
  return withCopy(DOMPurify.sanitize(marked.parse(rest + plain, { async: false, gfm: true, breaks: false })))
}
const SVG = (d: string) =>
  `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
const COPY_BTN = `<button type="button" class="copy" title="Copiar">${SVG('M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4')}${SVG('M20 6 9 17l-5-5')}</button>`
/** Cada bloco de código ganha um botão de copiar no canto (o clique é tratado em onMdClick) */
const withCopy = (html: string) => html.replaceAll('<pre>', `<div class="code-wrap">${COPY_BTN}<pre>`).replaceAll('</pre>', '</pre></div>')
async function onMdClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest?.('button.copy') as HTMLButtonElement | null
  if (!btn) return
  const text = btn.parentElement?.querySelector('pre')?.textContent ?? ''
  try {
    await navigator.clipboard.writeText(text.replace(/\n$/, ''))
    btn.classList.add('done')
    btn.title = 'Copiado'
    setTimeout(() => {
      btn.classList.remove('done')
      btn.title = 'Copiar'
    }, 1500)
  } catch {
    /* sem acesso à área de transferência */
  }
}

// ---------- perguntas do agente: cartão com botões, uma pergunta de cada vez ----------
/** Perguntas da última resposta, enquanto o usuário não respondeu (a resposta vira uma vez nova) */
const questions = computed<AgentQuestion[]>(() => {
  const t = turns[turns.length - 1]
  if (!t || t.running || running.value) return []
  return t.blocks.flatMap((b) => (b.kind === 'text' ? splitQuestions(b.text).questions : []))
})
/** Decisão por pergunta: texto escolhido, null = pulada, ausente = ainda não vista */
const decided = reactive<(string | null | undefined)[]>([])
/** Pergunta em exibição (as setas navegam entre elas) */
const qi = ref(0)
const askOpen = ref(true)
const otherText = ref('')
const questionTurn = computed(() => turns[turns.length - 1]?.id)
watch(questionTurn, () => {
  decided.splice(0)
  qi.value = 0
  askOpen.value = true
  otherText.value = ''
})
const question = computed(() => questions.value[qi.value])
const showAsk = computed(() => askOpen.value && !!question.value)

// ---------- fim do plano: o app pergunta se deseja iniciar a implementação ----------
/** A última vez foi em modo plano e terminou bem, com texto e sem perguntas do modelo: o plano está pronto */
const planDone = computed(() => {
  const t = turns[turns.length - 1]
  if (!t || t.running || running.value || t.error || t.mode !== 'plan' || questions.value.length) return false
  return t.blocks.some((b) => b.kind === 'text' && b.text.trim())
})
const showPlanAsk = computed(() => askOpen.value && planDone.value)
/** Texto do plano pronto: o maior bloco de texto da última resposta (os outros são comentários entre as leituras) */
const planText = computed(() => {
  if (!planDone.value) return ''
  const texts = turns[turns.length - 1].blocks.flatMap((b) => (b.kind === 'text' ? [splitQuestions(b.text).text.trim()] : []))
  const plan = texts.reduce((a, b) => (b.length > a.length ? b : a), '')
  // o agente é orientado a abrir o plano com um título; se não abriu, vale o título da conversa
  return /^#{1,2} \S/.test(plan) || !info.value?.title ? plan : `# ${info.value.title}\n\n${plan}`
})
/** Modal de leitura do plano, com cópia do texto inteiro (em Markdown) */
const planOpen = ref(false)
const planCopied = ref(false)
async function copyPlan() {
  try {
    await navigator.clipboard.writeText(planText.value)
    planCopied.value = true
    setTimeout(() => (planCopied.value = false), 1500)
  } catch {
    /* sem acesso à área de transferência */
  }
}
/** Modo da aprovação: o que estava em uso antes do Plano; sem anterior conhecido, "Tudo liberado" */
const approveMode = computed<AgentMode>(() => modeBeforePlan.value ?? 'full')
/** Modos que executam: cada um vira uma opção do cartão, com o da aprovação em primeiro */
const PLAN_STARTS = computed(() => MODES.filter((m) => m.id !== 'plan').sort((a, b) => Number(b.id === approveMode.value) - Number(a.id === approveMode.value)))
/** Implementa o plano: troca o modo e pede na mesma sessão (o agente lembra o plano que acabou de escrever) */
async function startPlan(m: AgentMode) {
  planOpen.value = false
  mode.value = m
  askOpen.value = false
  await dispatch({ id: crypto.randomUUID(), body: 'Implemente o plano acima.', attachments: [] })
}
/** Ajuste ao plano: continua em modo plano com o que o usuário escreveu */
async function adjustPlan() {
  const text = otherText.value.trim()
  if (!text) return
  otherText.value = ''
  askOpen.value = false
  await dispatch({ id: crypto.randomUUID(), body: text, attachments: [] })
}
/** Escolhe (ou pula, com null) a pergunta atual; segue para a próxima sem decisão, ou envia tudo numa mensagem só */
async function decide(choice: string | null) {
  const qs = questions.value
  if (!qs.length) return
  decided[qi.value] = choice === null ? null : choice.trim() || null
  otherText.value = ''
  const next = qs.findIndex((_, j) => decided[j] === undefined)
  if (next >= 0) {
    qi.value = next
    return
  }
  const answers = qs.map((_, j) => decided[j] ?? undefined)
  askOpen.value = false
  // tudo pulado: nada a dizer ao agente
  if (!answers.some(Boolean)) return
  await dispatch({ id: crypto.randomUUID(), body: formatAnswers(qs, answers), attachments: [] })
}

// ---------- título: a IA dá um depois da primeira resposta; o usuário pode renomear ----------
const chatTitle = ref('')
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement>()
async function startRename() {
  titleDraft.value = chatTitle.value
  editingTitle.value = true
  await nextTick()
  titleInput.value?.select()
}
/** O cabeçalho é região de arrasto, mas o título precisa receber o clique duplo (renomear), e uma região
 * `-webkit-app-region: drag` não recebe cliques. Então o arrasto ali é feito à mão, mandando o deslocamento. */
function dragWindow(e: MouseEvent) {
  if (e.button !== 0 || editingTitle.value) return
  const x0 = e.screenX
  const y0 = e.screenY
  api.windowDrag(0, 0, true)
  const move = (ev: MouseEvent) => api.windowDrag(ev.screenX - x0, ev.screenY - y0)
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
async function saveTitle() {
  if (!editingTitle.value) return
  editingTitle.value = false
  const t = titleDraft.value.trim()
  if (t === chatTitle.value) return
  try {
    chatTitle.value = await api.agentSetTitle(uid, t)
  } catch (e) {
    attachError.value = clean(e)
  }
}

function apply(ev: AgentChatEvent) {
  if (ev.type === 'session') {
    sessionId.value = ev.sessionId
    return
  }
  if (ev.type === 'title') {
    if (!editingTitle.value) chatTitle.value = ev.title
    return
  }
  const t = current()
  if (!t) return
  if (ev.type === 'text') {
    t.thinking = false
    t.activity = 'writing'
    const last = t.blocks[t.blocks.length - 1]
    if (last?.kind === 'text') last.text += ev.delta
    else if (ev.delta.trim()) t.blocks.push({ kind: 'text', text: ev.delta.replace(/^\n+/, '') })
  } else if (ev.type === 'thinking') {
    t.thinking = true
    t.activity = 'thinking'
  } else if (ev.type === 'tool') {
    t.thinking = false
    t.activity = 'tools'
    t.blocks.push({ kind: 'tool', id: ev.id, name: ev.name, title: ev.title, detail: ev.detail, ok: null, open: false })
  } else if (ev.type === 'toolResult') {
    // a ferramenta pode ser de uma vez anterior, se uma mensagem entrou no meio da resposta
    const b = findTool(ev.id)
    if (b) {
      b.ok = ev.ok
      b.output = ev.output
    }
  } else if (ev.type === 'files') {
    const last = t.blocks[t.blocks.length - 1]
    // com `stats`, é a mesma lista chegando de novo com as contagens do git: entra no bloco que tem esses arquivos
    const target = ev.stats
      ? [...t.blocks].reverse().find((b): b is FilesBlock => b.kind === 'files' && ev.paths.some((p) => b.paths.includes(p)))
      : last?.kind === 'files'
        ? last
        : undefined
    if (target) {
      target.paths.push(...ev.paths.filter((p) => !target.paths.includes(p)))
      if (ev.stats) target.stats = { ...(target.stats ?? {}), ...ev.stats }
      if (ev.repos) target.repos = { ...(target.repos ?? {}), ...ev.repos }
    } else t.blocks.push({ kind: 'files', paths: [...ev.paths], stats: ev.stats, repos: ev.repos })
    if (ev.repos) for (const r of Object.values(ev.repos)) loadRepoIcon(r.root)
  } else if (ev.type === 'done') {
    t.running = false
    t.thinking = false
    t.error = ev.error
    // Codex não informa a duração: conta a partir do início da vez
    t.durationMs = ev.durationMs ?? (t.startedAt ? Date.now() - t.startedAt : undefined)
    t.costUsd = ev.costUsd
    running.value = false
    // texto vazio no fim: tira o bloco; o CLI repete o erro como texto: fica só a caixa de erro
    t.blocks = t.blocks.filter((b) => b.kind !== 'text' || (b.text.trim() && !(ev.error && /^API Error/i.test(b.text.trim()))))
    notifyDone(t)
    nextTick(() => box.value?.focus())
    // interrompida para dar lugar a outra mensagem: não é erro
    if (sendAfterStop && t.error === 'Interrompido.') t.error = undefined
    flushQueue()
  }
}

function findTool(id: string): ToolBlock | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const b = turns[i].blocks.find((x): x is ToolBlock => x.kind === 'tool' && x.id === id)
    if (b) return b
  }
  return undefined
}
/** Soma das linhas +/− de um bloco de arquivos; null se nenhum arquivo tem contagem */
function sumStats(b: FilesBlock): { add: number; del: number } | null {
  const list = Object.values(b.stats ?? {}).filter((s): s is NonNullable<typeof s> => !!s)
  if (!list.length) return null
  return list.reduce((acc, s) => ({ add: acc.add + s.add, del: acc.del + s.del }), { add: 0, del: 0 })
}

/** O agente terminou e o usuário ainda não tocou na janela: o indicador de estado pisca até o primeiro clique */
const unseen = ref(false)
const markSeen = () => (unseen.value = false)
onMounted(() => {
  window.addEventListener('mousedown', markSeen, true)
  window.addEventListener('keydown', markSeen, true)
})
onUnmounted(() => {
  window.removeEventListener('mousedown', markSeen, true)
  window.removeEventListener('keydown', markSeen, true)
})
watch(running, (r) => r && markSeen())

function notifyDone(t: Turn) {
  unseen.value = true
  if (document.hasFocus() || !('Notification' in window)) return
  const text = t.blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text').map((b) => b.text).join(' ')
  try {
    new Notification(`${providerName.value} terminou em ${info.value?.project ?? 'projeto'}`, {
      body: t.error ?? text.replace(/[*_`#>]+/g, '').slice(0, 180) ?? 'Tarefa concluída'
    })
  } catch {
    /* notificações desativadas */
  }
}

// ---------- anexos: clipe, arrastar, colar ----------
const isImage = (type: string, name: string) => /^image\//.test(type) || /\.(png|jpe?g|gif|webp)$/i.test(name)
const isAudio = (type: string, name: string) => /^audio\//.test(type) || /\.(mp3|m4a|wav|ogg|webm|aac|flac|opus)$/i.test(name)

function pushPending(a: Shown) {
  if (pending.some((p) => p.path === a.path)) return
  if (pending.length >= 20) {
    attachError.value = 'Máximo de 20 anexos por mensagem.'
    return
  }
  pending.push(a)
}

async function pickFiles() {
  attachError.value = null
  try {
    for (const a of await api.agentPickFiles(uid)) pushPending(a)
  } catch (e) {
    attachError.value = clean(e)
  }
}

/** Arquivos vindos do sistema (arrastados) ou só com bytes (colados): os sem caminho são guardados pelo app. */
async function addFiles(files: File[]) {
  attachError.value = null
  for (const f of files) {
    try {
      const preview = isImage(f.type, f.name) ? URL.createObjectURL(f) : undefined
      const real = api.filePath(f)
      if (real) {
        const kind = isImage(f.type, f.name) ? 'image' : isAudio(f.type, f.name) ? 'audio' : 'file'
        pushPending({ name: f.name, path: real, mime: f.type, size: f.size, kind, preview })
      } else {
        const name = f.name && f.name !== 'image.png' ? f.name : `colado-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
        const saved = await api.agentSaveBlob(uid, { name, type: f.type, data: await f.arrayBuffer() })
        pushPending({ ...saved, preview })
      }
    } catch (e) {
      attachError.value = clean(e)
    }
  }
}

function onDrop(e: DragEvent) {
  dragReset()
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) addFiles(files)
}
/** Texto colado grande vira um cartão (como no app do ChatGPT), em vez de tomar o campo inteiro */
const PASTE_CHARS = 1200
const PASTE_LINES = 12
const pastes = reactive<{ id: string; text: string; lines: number }[]>([])
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
  if (files.length) {
    e.preventDefault()
    addFiles(files)
    return
  }
  const text = e.clipboardData?.getData('text/plain') ?? ''
  const lines = text.split('\n').length
  if (text.length > PASTE_CHARS || lines > PASTE_LINES) {
    e.preventDefault()
    pastes.push({ id: crypto.randomUUID(), text, lines })
  }
}
function pasteToField(i: number) {
  const [p] = pastes.splice(i, 1)
  if (!p) return
  draft.value = draft.value ? `${draft.value}\n${p.text}` : p.text
  nextTick(autosize)
}
const pastePreview = (t: string) => t.trim().split('\n')[0].slice(0, 60)
/** Mensagens longas aparecem recolhidas no balão; clique mostra tudo */
const LONG_USER = 700
const expandedUsers = reactive(new Set<string>())
/** Mensagem do usuário copiada há pouco (o botão vira um check por um instante) */
const copiedUser = ref<string | null>(null)
async function copyUser(t: Turn) {
  try {
    await navigator.clipboard.writeText(t.user)
    copiedUser.value = t.id
    setTimeout(() => copiedUser.value === t.id && (copiedUser.value = null), 1500)
  } catch {
    /* sem acesso à área de transferência */
  }
}
const sentAt = (t: Turn) => (t.startedAt ? new Date(t.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '')
const isLongUser = (t: Turn) => t.user.length > LONG_USER || t.user.split('\n').length > PASTE_LINES
function removePending(i: number) {
  const [a] = pending.splice(i, 1)
  if (a?.preview) URL.revokeObjectURL(a.preview)
}
const sizeOf = (n: number) => (!n ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Mensagem pronta para ir ao agente: texto (digitado + colados) e anexos */
interface Payload {
  id: string
  body: string
  attachments: Shown[]
}
const canCompose = computed(() => !!(draft.value.trim() || pastes.length || pending.length))

/** Tira do campo o que foi digitado, colado e anexado; null se não há nada. */
function takePayload(text = draft.value): Payload | null {
  // /plan troca para o modo Plano; o que vier depois do comando segue como mensagem, já nesse modo
  const cmd = /^\/plan(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (cmd) setMode('plan')
  const typed = (cmd ? (cmd[1] ?? '') : text).trim()
  const pasted = pastes.splice(0, pastes.length).map((p) => p.text.trim()).filter(Boolean)
  const msg = [typed, ...pasted].filter(Boolean).join('\n\n')
  if (!msg && !pending.length) {
    if (cmd) {
      draft.value = ''
      nextTick(autosize)
    }
    return null
  }
  const attachments = pending.splice(0, pending.length)
  const body = msg || (attachments.length === 1 ? 'Veja o arquivo anexado.' : 'Veja os arquivos anexados.')
  draft.value = ''
  nextTick(autosize) // depois do campo esvaziar no DOM (senão mede a altura antiga)
  return { id: crypto.randomUUID(), body, attachments }
}

/** `since`: início do trabalho que esta mensagem continua (enviada no "agora"): o contador segue dele */
async function dispatch(p: Payload, since?: number) {
  if (!info.value) return
  const turn: Turn = { id: p.id, user: p.body, attachments: p.attachments, blocks: [], running: true, thinking: true, activity: 'thinking', startedAt: Date.now(), workSince: since, mode: mode.value }
  turns.push(turn)
  running.value = true
  scrollToEnd(true)
  try {
    await api.agentSend(
      uid,
      p.body,
      { model: model.value, effort: effort.value, mode: mode.value, provider: provider.value },
      p.attachments.map(({ preview: _p, ...a }) => a)
    )
  } catch (e) {
    turn.running = false
    turn.thinking = false
    turn.error = clean(e)
    running.value = false
    flushQueue()
  }
}

/** Desde quando o agente trabalha nesta vez: o início dela ou, se veio de um "agora", o da vez que ela continuou */
function workStart(t: Turn) {
  return t.workSince ?? t.startedAt
}

/** Agente livre: envia; ocupado: entra na fila (sai sozinha quando a resposta atual terminar). */
async function send(text = draft.value) {
  const p = takePayload(text)
  if (!p || !info.value) return
  if (running.value) queue.push(p)
  else await dispatch(p)
}

// ---------- fila e "enviar agora" ----------
const queue = reactive<Payload[]>([])
/** Mensagem que deve sair assim que a interrupção for confirmada */
let sendAfterStop: Payload | null = null
/** Tira da fila e descarta (texto e anexos). */
function discardQueued(i: number) {
  queue.splice(i, 1)
}
/** Tira da fila e devolve ao campo, para editar. */
function editQueued(i: number) {
  const [p] = queue.splice(i, 1)
  if (!p) return
  draft.value = draft.value ? `${draft.value}\n${p.body}` : p.body
  pending.push(...p.attachments)
  nextTick(autosize)
  box.value?.focus()
}
/** Tira da fila e manda agora: interrompe a resposta atual; o resto da fila continua depois. */
function sendQueuedNow(i: number) {
  const [p] = queue.splice(i, 1)
  if (p) sendAfter(p)
}
/**
 * "Agora": Claude recebe a mensagem no meio da resposta, sem interromper (ela entra no próximo passo);
 * Codex e Antigravity não têm isso, então a resposta atual é interrompida e a mensagem sai em seguida.
 * Se já havia uma mensagem esperando a interrupção, ela volta ao início da fila.
 */
async function sendAfter(p: Payload) {
  if (!running.value) return dispatch(p)
  if (provider.value === 'claude') {
    let steered = false
    try {
      steered = await api.agentSteer(uid, p.body, p.attachments.map(({ preview: _p, ...a }) => a))
    } catch {
      steered = false
    }
    if (steered) {
      // na interface, a vez atual encerra e a nova começa: os próximos eventos vão para ela
      const cur = current()
      if (cur) {
        cur.running = false
        cur.thinking = false
      }
      turns.push({ id: p.id, user: p.body, attachments: p.attachments, blocks: [], running: true, thinking: true, activity: 'thinking', startedAt: Date.now(), workSince: cur ? workStart(cur) : undefined, mode: mode.value })
      scrollToEnd(true)
      return
    }
    if (!running.value) return dispatch(p) // a resposta terminou enquanto isso
  }
  if (sendAfterStop) queue.unshift(sendAfterStop)
  sendAfterStop = p
  api.agentCancel(uid)
}
/** Chamado quando uma resposta termina: primeiro o "enviar agora", depois a fila. */
function flushQueue() {
  if (running.value) return
  const next = sendAfterStop ?? queue.shift()
  // "agora" interrompeu a resposta anterior: o contador continua de onde ela começou
  const prev = sendAfterStop ? turns[turns.length - 1] : undefined
  sendAfterStop = null
  if (next) dispatch(next, prev && workStart(prev))
}
/** Interrompe a resposta atual e manda esta mensagem em seguida (a fila continua depois dela). */
function sendNow() {
  const p = takePayload()
  if (p) sendAfter(p)
}

function stop() {
  api.agentCancel(uid)
}

// ---------- acelerar: avisa o agente, no meio da resposta, que há pressa ----------
/** Recado curto, para não pesar no consumo: entra no próximo passo do agente, sem interromper nem virar mensagem na conversa */
const HURRY = 'Aviso do usuário: temos pressa. Não recomece nem explique este aviso: conclua o que está fazendo pelo caminho mais direto, sem explorações, verificações ou leituras que não sejam essenciais, e responda de forma objetiva.'
/** Só o Claude recebe mensagem no meio da resposta; nos outros seria preciso interromper e pedir de novo (gasta mais) */
const canHurry = computed(() => provider.value === 'claude')
/** Vez em que o aviso já foi dado (um por vez) */
const hurried = ref<string | null>(null)
async function hurry(t: Turn) {
  if (hurried.value === t.id) return
  hurried.value = t.id
  const ok = await api.agentSteer(uid, HURRY, []).catch(() => false)
  if (!ok) hurried.value = null
}

/** Conversa nova nesta janela, com o mesmo agente: o processo reinicia a página sem sessão e sem transcrição local */
async function newChat() {
  if (running.value && !confirm('O agente ainda está trabalhando. Interromper e começar uma conversa nova?')) return
  try {
    await api.agentNewChat(uid)
  } catch (e) {
    fatal.value = e instanceof Error ? e.message : String(e)
    return
  }
  sessionStorage.removeItem(STORE)
  location.reload()
}
/** Dá para voltar à conversa anterior enquanto a nova ainda não recebeu a primeira mensagem */
const canGoBack = computed(() => !!info.value?.previousSessionId && !turns.length && !queue.length)
async function backToPrevious() {
  if (!(await api.agentBack(uid).catch(() => false))) return
  sessionStorage.removeItem(STORE)
  location.reload()
}

/** Com o agente ocupado, o botão de enviar escolhe entre pôr na fila (padrão) e interromper para enviar agora.
 * A escolha vale para a resposta atual: quando o agente termina, volta para a fila. */
type SendAction = 'queue' | 'now'
const SEND_ACTIONS = computed<{ id: SendAction; icon: 'list' | 'zap'; label: string; hint: string; keys: string }[]>(() => [
  { id: 'queue', icon: 'list', label: 'Fila', hint: 'Envia quando a resposta atual terminar', keys: 'Enter' },
  {
    id: 'now',
    icon: 'zap',
    label: 'Agora',
    hint: provider.value === 'claude' ? 'Entrega no meio da resposta, sem interromper: o agente recebe no próximo passo' : 'Interrompe a resposta atual e envia em seguida',
    keys: '⌘Enter'
  }
])
const sendAction = ref<SendAction>('queue')
const sendOpen = ref(false)
const sendRoot = ref<HTMLElement>()
/** ⌘ (ou Ctrl) pressionado: o botão mostra "Agora" enquanto a tecla estiver segurada, como prévia do ⌘Enter */
const modHeld = ref(false)
const onModKey = (e: KeyboardEvent) => (modHeld.value = e.metaKey || e.ctrlKey)
const onModReset = () => (modHeld.value = false)
/** Ação efetiva: a escolhida no menu, ou "agora" enquanto ⌘ está segurado */
const effectiveSend = computed<SendAction>(() => (modHeld.value ? 'now' : sendAction.value))
const currentSend = computed(() => SEND_ACTIONS.value.find((a) => a.id === effectiveSend.value) ?? SEND_ACTIONS.value[0])
const nowVerb = computed(() => (provider.value === 'claude' ? 'envia agora, sem interromper' : 'interrompe e envia agora'))
function sendAs(action: SendAction) {
  if (action === 'now') sendNow()
  else send()
}
watch(running, (r) => {
  if (!r) sendAction.value = 'queue'
  sendOpen.value = false
})

// ---------- menu de comandos: aparece ao digitar "/" e aplica o comando sem enviar mensagem ----------
interface SlashCommand {
  id: AgentMode
  name: string
  label: string
  hint: string
  icon: (typeof MODES)[number]['icon']
  /** Nomes pelos quais o comando é achado (sem acento) */
  keys: string[]
}
const SLASH_KEYS: Record<AgentMode, string[]> = { plan: ['plan', 'plano', 'planejar'], safe: ['edicoes', 'edits', 'safe'], full: ['liberado', 'full', 'tudo'] }
const plain = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const slashClosed = ref(false)
const slashIndex = ref(0)
/** O que vem depois da barra, enquanto o campo tem só o comando (sem espaço); null fora disso */
const slashQuery = computed(() => /^\/(\S*)$/.exec(draft.value)?.[1] ?? null)
const slashItems = computed<SlashCommand[]>(() => {
  if (slashQuery.value === null || slashClosed.value) return []
  const q = plain(slashQuery.value)
  return MODES.map((m) => {
    const off = m.id === 'plan' && mode.value === 'plan'
    return {
      id: m.id,
      name: SLASH_KEYS[m.id][0],
      label: m.id === 'plan' ? 'Modo Plano' : m.label,
      hint: off ? 'Desativar o modo Plano' : mode.value === m.id ? 'Modo em uso' : m.id === 'plan' ? 'Ativar o modo Plano: só lê e propõe, nada é alterado' : m.hint,
      icon: m.icon,
      keys: [...SLASH_KEYS[m.id], plain(m.label)]
    }
  }).filter((c) => c.keys.some((k) => k.startsWith(q)) || plain(c.label).includes(q))
})
watch(draft, () => {
  slashClosed.value = false
  slashIndex.value = 0
})
function runSlash(c: SlashCommand) {
  // /plan com o Plano já ligado desliga: volta ao modo que estava antes
  if (c.id === 'plan' && mode.value === 'plan') setMode(modeBeforePlan.value ?? 'safe')
  else setMode(c.id)
  draft.value = ''
  nextTick(() => {
    autosize()
    box.value?.focus()
  })
}

function onKey(e: KeyboardEvent) {
  const cmds = slashItems.value
  if (cmds.length && !e.isComposing) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      slashIndex.value = (slashIndex.value + (e.key === 'ArrowDown' ? 1 : cmds.length - 1)) % cmds.length
      return
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      runSlash(cmds[Math.min(slashIndex.value, cmds.length - 1)])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashClosed.value = true
      return
    }
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  if (e.metaKey || e.ctrlKey) sendNow()
  else sendAs(sendAction.value)
}

function autosize() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

// rolagem: acompanha o fim enquanto o usuário não subiu para ler algo
let stick = true
function onScroll() {
  const el = thread.value
  if (!el) return
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
function scrollToEnd(force = false) {
  if (!force && !stick) return
  nextTick(() => {
    const el = thread.value
    if (el) el.scrollTop = el.scrollHeight
  })
}
watch(turns, () => scrollToEnd(), { deep: true })

// a conversa é guardada: nesta janela (sobrevive a recargas) e, assim que a sessão do CLI existe,
// em disco pelo processo principal (histórico: dá para fechar o app e reabrir depois)
const STORE = `ovseer.agent.${uid}`
let saveTimer: ReturnType<typeof setTimeout> | undefined
const plainTurns = (): AgentTurn[] => turns.map((t) => ({ ...t, attachments: t.attachments.map(({ preview: _p, ...a }) => a) }))
watch(
  [turns, sessionId],
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const plain = plainTurns() // prévias (blob:) não sobrevivem à recarga
      try {
        sessionStorage.setItem(STORE, JSON.stringify(plain))
      } catch {
        /* sem espaço: segue sem guardar */
      }
      if (sessionId.value && plain.length) api.agentSaveTranscript(uid, JSON.parse(JSON.stringify(plain))).catch(() => undefined)
    }, 400)
  },
  { deep: true }
)
// ---------- fixar a conversa (o mesmo alfinete do menu Conversas) ----------
const pinned = ref(false)
watch(
  sessionId,
  async (id) => {
    pinned.value = false
    if (!id) return
    const item = (await api.agentHistory().catch(() => [])).find((h) => h.sessionId === id)
    if (sessionId.value === id) pinned.value = !!item?.pinned
  },
  { immediate: true }
)
async function togglePin() {
  const id = sessionId.value
  if (!id) return
  const next = !pinned.value
  pinned.value = next
  try {
    // a conversa entra no histórico com a transcrição: garante que já está lá antes de fixar
    await api.agentSaveTranscript(uid, JSON.parse(JSON.stringify(plainTurns())))
    await api.agentPin(id, next)
  } catch {
    pinned.value = !next
  }
}

function adopt(saved: AgentTurn[], stillRunning: boolean) {
  for (const t of saved) {
    if (t.running && !stillRunning) {
      t.running = false
      t.thinking = false
      if (!t.blocks.length) t.error = 'A resposta foi interrompida antes de terminar.'
    }
    turns.push(t)
    // pelo proxy reativo (não pelo objeto cru): o `repos` preenchido depois precisa redesenhar o card
    for (const b of turns[turns.length - 1].blocks) {
      if (b.kind !== 'files') continue
      if (b.repos) for (const r of Object.values(b.repos)) loadRepoIcon(r.root)
      else backfillRepos(b)
    }
  }
  if (turns.length && stillRunning) running.value = true
}
/** Card guardado antes de o app registrar o repositório de cada arquivo: descobre agora os de fora do projeto */
function backfillRepos(b: FilesBlock) {
  const cwd = info.value?.cwd
  // só os que saem do projeto: `../algo` ou absolutos fora da pasta da janela
  const outside = b.paths.filter((p) => /^\.\.[\\/]/.test(p) || (/^([a-zA-Z]:)?[\\/]/.test(p) && under(p, cwd) === p))
  if (!outside.length) return
  api
    .agentFileRepos(uid, outside)
    .then((repos) => {
      if (!Object.keys(repos).length) return
      b.repos = repos
      for (const r of Object.values(repos)) loadRepoIcon(r.root)
    })
    .catch(() => undefined)
}
async function restore(i: AgentWindowInfo) {
  try {
    const local = JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as AgentTurn[]
    if (local.length) return adopt(local, i.running)
  } catch {
    /* sem estado local */
  }
  // conversa reaberta do histórico: transcrição guardada em disco
  if (i.sessionId) {
    const saved = await api.agentLoadTranscript(i.sessionId).catch(() => null)
    if (saved?.length) adopt(saved, i.running)
  }
}

// linha de andamento enquanto o agente trabalha: tempo decorrido e o que está fazendo agora
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
watch(
  running,
  (on) => {
    clearInterval(clock)
    if (on) clock = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true }
)
onUnmounted(() => clearInterval(clock))
const elapsed = (t: Turn) => {
  const s = Math.max(0, Math.round((now.value - (workStart(t) ?? now.value)) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
const ACTIVITY = { thinking: 'Pensando…', tools: 'Executando ferramentas…', writing: 'Escrevendo…' }
const activityLabel = (t: Turn) => ACTIVITY[t.activity ?? 'thinking']

const toolIcon = (name: string) =>
  name === 'Bash' ? 'terminal' : /Edit|Write/.test(name) ? 'pencil' : /Read|Grep|Glob|Search|Fetch/.test(name) ? 'search' : /Agent|Task/.test(name) ? 'bot' : 'zap'
function took(ms?: number): string {
  return !ms ? '' : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
}
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p
/** Caminho a partir de uma pasta raiz; fora dela, fica como veio */
const under = (p: string, root: string | undefined) => {
  const r = root?.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  if (!r) return p
  const norm = p.replace(/\\/g, '/')
  return norm === r ? fileName(p) : norm.startsWith(r + '/') ? norm.slice(r.length + 1) : p
}
/** Caminho relativo ao projeto da janela ou, se o arquivo é de outro repositório, à raiz desse repositório */
const relPath = (p: string, b?: FilesBlock) => {
  const repo = b?.repos?.[p]
  if (repo) return under(/^([a-zA-Z]:)?[\\/]/.test(p) ? p : absPath(p), repo.root)
  return under(p, info.value?.cwd)
}
const fileDir = (p: string, b?: FilesBlock) => relPath(p, b).split('/').slice(0, -1).join('/')
/** Caminho absoluto de um caminho relativo à pasta do projeto (resolve `..` como o agente vê) */
function absPath(p: string): string {
  const root = info.value?.cwd?.replace(/[\\/]+$/, '').replace(/\\/g, '/') ?? ''
  const parts = root.split('/')
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
/** Repositórios (fora do projeto) que aparecem num card de arquivos, sem repetição */
const otherRepos = (b: FilesBlock): FileRepo[] => {
  const seen = new Map<string, FileRepo>()
  for (const p of b.paths) {
    const r = b.repos?.[p]
    if (r && !seen.has(r.root)) seen.set(r.root, r)
  }
  return [...seen.values()]
}
/** Ícone (favicon) de cada repositório citado nos cards, carregado uma vez */
const repoIcons = reactive(new Map<string, string | null>())
function loadRepoIcon(root: string) {
  if (repoIcons.has(root)) return
  repoIcons.set(root, null)
  api
    .projectIcon(root)
    .then((icon) => repoIcons.set(root, icon))
    .catch(() => undefined)
}

onMounted(async () => {
  try {
    const s = await api.getSettings()
    applyTheme(s.theme)
    gridSize.value = normalizeGrid(s.agentGrid)
    applyFont(s)
  } catch {
    /* tema padrão */
  }
  offs.push(api.onAgentEvent((u, ev) => u === uid && apply(ev)))
  document.addEventListener('mousedown', onDocClick)
  offs.push(() => document.removeEventListener('mousedown', onDocClick))
  window.addEventListener('keydown', onModKey)
  window.addEventListener('keyup', onModKey)
  window.addEventListener('blur', onModReset)
  window.addEventListener('focus', onFocus)
  offs.push(() => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onModKey)
    window.removeEventListener('keyup', onModKey)
    window.removeEventListener('blur', onModReset)
  })
  offs.push(
    api.onSettingsChanged((s) => {
      applyTheme(s.theme)
      applyFont(s)
    })
  )

  const i = await api.agentInfo(uid).catch(() => null)
  if (!i) {
    fatal.value = 'Esta janela perdeu a ligação com o agente. Feche e abra um agente novo.'
    return
  }
  info.value = i
  provider.value = i.provider
  model.value = i.model
  effort.value = i.effort
  mode.value = i.mode
  chatTitle.value = i.title
  sessionId.value = i.sessionId
  await restore(i)
  scrollToEnd(true)
  known.value = await api.knownModels().catch(() => null)
  box.value?.focus()
  // a primeira tarefa só é enviada uma vez (não de novo numa recarga)
  if (i.firstMessage && !turns.length) send(i.firstMessage)
})
onUnmounted(() => offs.forEach((f) => f()))
</script>

<template>
  <div
    class="agent"
    :style="fontStyle"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
    @mousemove="dragging && dragReset()"
  >
    <header class="bar">
      <AgentLogo v-if="info" :source="provider" :size="16" />
      <div v-if="info" class="head-text" @mousedown="dragWindow">
        <input
          v-if="editingTitle"
          ref="titleInput"
          v-model="titleDraft"
          type="text"
          class="title-input"
          maxlength="120"
          placeholder="Título da conversa"
          @keydown.enter.prevent="saveTitle"
          @keydown.esc.prevent="editingTitle = false"
          @blur="saveTitle"
        />
        <span v-else class="title" :class="{ none: !chatTitle }" title="Clique duas vezes para renomear" @dblclick="startRename">
          <span class="ellipsis">{{ chatTitle || `Nova conversa com ${providerName}` }}</span>
          <Icon name="pencil" :size="11" class="pen" />
        </span>
        <span class="sub ellipsis" :title="info.cwd">
          {{ providerName }} · {{ modelLabel(provider, model, catalogOf(known, provider)) }}
          · <Icon name="folder" :size="11" /> {{ info.project }}<template v-if="info.branch"> · <Icon name="branch" :size="10" /> {{ info.branch }}</template>
        </span>
      </div>
      <span class="spacer" />
      <div ref="gridRoot" class="grid-menu">
        <button type="button" class="ghost icon head-btn" :class="{ on: gridOpen }" title="Posicionar a janela na tela" @click="gridOpen = !gridOpen">
          <Icon name="grid" :size="14" />
        </button>
        <div v-if="gridOpen" class="pop">
          <WindowGrid :model-value="gridSize" @update:model-value="setGridSize" @place="placeWindow" />
        </div>
      </div>
      <button v-if="sessionId && turns.length" type="button" class="ghost icon head-btn pin" :class="{ pinned }" :title="pinned ? 'Soltar a conversa do topo da lista' : 'Fixar a conversa no topo da lista'" @click="togglePin">
        <Icon name="pin" :size="14" />
      </button>
      <button v-if="canGoBack" type="button" class="ghost icon head-btn back" title="Voltar à conversa anterior" @click="backToPrevious">
        <Icon name="undo" :size="14" />
      </button>
      <button v-if="turns.length" type="button" class="ghost icon head-btn" title="Nova conversa com este agente (a atual fica no histórico)" @click="newChat">
        <Icon name="compose" :size="14" />
      </button>
      <span class="status" :class="[statusKind, { blink: unseen && statusKind !== 'live' }]" :title="statusTitle">
        <span class="ball">
          <Icon v-if="statusKind === 'done'" name="check" :size="10" />
          <Icon v-else-if="statusKind === 'error'" name="x" :size="10" />
        </span>
        <span class="status-text">{{ statusLabel }}<small v-if="statusTook" class="status-took">{{ statusTook }}</small></span>
      </span>
    </header>

    <main ref="thread" class="thread" @scroll="onScroll">
      <p v-if="fatal" class="fatal">{{ fatal }}</p>
      <div v-else-if="!turns.length" class="empty">
        <AgentLogo v-if="info" :source="provider" :size="36" />
        <h2>O que você quer fazer em {{ info?.project ?? 'este projeto' }}?</h2>
        <p class="faint">
          O agente trabalha direto na pasta do projeto, como no app do {{ providerName }}. Enter envia; Shift+Enter quebra a linha.
        </p>
        <p v-if="info?.resumeId" class="faint resumed">Continuando uma conversa anterior; o agente lembra o que foi feito, mas a transcrição não foi encontrada.</p>
      </div>

      <article v-for="t in turns" :key="t.id" class="turn">
        <div class="user">
          <div class="bubble">
            <div v-if="t.attachments.length" class="atts">
              <span v-for="a in t.attachments" :key="a.path" class="att" :title="a.path">
                <img v-if="a.preview" :src="a.preview" alt="" />
                <Icon v-else :name="a.kind === 'image' ? 'panel' : a.kind === 'audio' ? 'mic' : 'paperclip'" :size="12" />
                <span class="ellipsis">{{ a.name }}</span>
              </span>
            </div>
            <p :class="{ clamp: isLongUser(t) && !expandedUsers.has(t.id) }">{{ t.user }}</p>
            <button v-if="isLongUser(t)" type="button" class="ghost more" @click="expandedUsers.has(t.id) ? expandedUsers.delete(t.id) : expandedUsers.add(t.id)">
              {{ expandedUsers.has(t.id) ? 'Mostrar menos' : 'Mostrar tudo' }}
            </button>
          </div>
          <div class="user-acts" :class="{ on: copiedUser === t.id }">
            <small class="faint">{{ sentAt(t) }}</small>
            <button type="button" class="ghost ua" :title="copiedUser === t.id ? 'Copiado' : 'Copiar mensagem'" @click="copyUser(t)">
              <Icon :name="copiedUser === t.id ? 'check' : 'clipboard'" :size="12" />
            </button>
          </div>
        </div>
        <div class="answer">
          <template v-for="(b, i) in display(t)" :key="i">
            <div v-if="b.kind === 'text'" class="md" @click="onMdClick" v-html="md(b.text, t.id === questionTurn && showAsk)" />
            <div v-else-if="b.kind === 'tools'" class="tools" :class="{ open: openGroups.has(b.key) }">
              <!-- linha discreta: enquanto roda mostra o que está fazendo; depois, só o resumo. Clique abre a lista. -->
              <button type="button" class="ghost tools-line" @click="toggleGroup(b.key)">
                <span v-if="groupBusy(b.items)" class="spinner tiny" />
                <Icon v-else-if="groupFailed(b.items)" name="alert" :size="12" class="bad" />
                <Icon v-else name="chevron" :size="12" class="caret" />
                <span class="tools-sum">{{ groupSummary(b.items) }}</span>
                <span v-if="groupBusy(b.items)" class="tools-now mono ellipsis">{{ groupNow(b.items) }}</span>
              </button>
              <div v-if="openGroups.has(b.key)" class="tools-list">
                <div v-for="tb in b.items" :key="tb.id" class="tool" :class="{ open: tb.open, click: tb.output }" @click="tb.output && (tb.open = !tb.open)">
                  <div class="tool-line">
                    <Icon :name="toolIcon(tb.name)" :size="12" class="tool-ic" />
                    <span class="tool-title">{{ tb.title }}</span>
                    <span v-if="tb.detail" class="tool-detail mono ellipsis" :title="tb.detail">{{ tb.detail }}</span>
                    <span class="tool-state">
                      <span v-if="tb.ok === null" class="spinner tiny" />
                      <Icon v-else-if="tb.ok" name="check" :size="11" class="ok" />
                      <Icon v-else name="x" :size="11" class="bad" />
                    </span>
                  </div>
                  <pre v-if="tb.open && tb.output" class="tool-out">{{ tb.output }}</pre>
                </div>
              </div>
            </div>
            <div v-else class="files">
              <div class="files-head">
                <template v-for="(r, i) in otherRepos(b)" :key="r.root">
                  <span v-if="i > 0" class="faint">e</span>
                  <span class="repo" :title="r.root">
                    <img v-if="repoIcons.get(r.root)" :src="repoIcons.get(r.root)!" class="favicon" alt="" />
                    <Icon v-else name="folder" :size="12" />
                    {{ r.name }}
                  </span>
                </template>
                <span v-if="otherRepos(b).length" class="faint sep">·</span>
                <Icon name="pencil" :size="12" /> Alterou {{ b.paths.length }} {{ b.paths.length === 1 ? 'arquivo' : 'arquivos' }}
                <span v-if="sumStats(b)" class="stat"><b class="add">+{{ sumStats(b)!.add }}</b> <b class="del">−{{ sumStats(b)!.del }}</b></span>
              </div>
              <div v-for="p in b.paths" :key="p" class="file">
                <span class="ellipsis" :title="p"><span class="faint">{{ fileDir(p, b) }}<template v-if="fileDir(p, b)">/</template></span>{{ fileName(p) }}</span>
                <span v-if="b.stats?.[p]" class="stat"><b class="add">+{{ b.stats[p]!.add }}</b> <b class="del">−{{ b.stats[p]!.del }}</b></span>
              </div>
            </div>
          </template>
          <div v-if="t.running" class="progress">
            <AgentLogo :source="provider" :size="13" class="spin-logo" />
            <span class="mono">{{ elapsed(t) }}</span> · {{ activityLabel(t) }}
            <button v-if="canHurry" type="button" class="ghost hurry" :class="{ on: hurried === t.id }" :disabled="hurried === t.id" :title="hurried === t.id ? 'O agente foi avisado de que há pressa' : 'Acelerar: avisa o agente de que há pressa, sem interromper'" @click="hurry(t)">
              <Icon name="forward" :size="12" />
            </button>
          </div>
          <p v-if="t.error" class="err"><Icon name="alert" :size="13" /> {{ t.error }}</p>
          <p v-if="!t.running && (t.durationMs || t.costUsd)" class="meta faint">
            <template v-if="t.durationMs">{{ took(t.durationMs) }}</template>
            <template v-if="t.costUsd"> · US$ {{ t.costUsd.toFixed(3) }}</template>
          </p>
          <div v-if="t.id === questionTurn && showAsk && question" class="ask">
            <div class="ask-head">
              <p class="ask-q">{{ question.text }}</p>
              <span v-if="questions.length > 1" class="ask-nav">
                <button type="button" class="ghost nav" title="Pergunta anterior" :disabled="qi === 0" @click="qi--"><Icon name="chevron" :size="13" class="prev" /></button>
                <span class="ask-count">{{ qi + 1 }} de {{ questions.length }}</span>
                <button type="button" class="ghost nav" title="Próxima pergunta" :disabled="qi === questions.length - 1" @click="qi++"><Icon name="chevron" :size="13" /></button>
              </span>
              <button type="button" class="ghost nav" title="Fechar: responda pelo campo de mensagem" @click="askOpen = false"><Icon name="x" :size="13" /></button>
            </div>
            <div class="ask-opts">
              <button v-for="(o, i) in question.options" :key="o.label" type="button" class="ghost ask-opt" :class="{ cur: decided[qi] === o.label }" @click="decide(o.label)">
                <span class="num">{{ i + 1 }}</span>
                <span class="opt-body">
                  <span class="opt-label">{{ o.label }}<span v-if="o.recommended" class="pill">Recomendado</span></span>
                  <span v-if="o.detail" class="opt-detail">{{ o.detail }}</span>
                </span>
              </button>
            </div>
            <form class="ask-other" @submit.prevent="otherText.trim() && decide(otherText)">
              <Icon name="pencil" :size="13" class="pen" />
              <input v-model="otherText" type="text" :placeholder="`Não, e diga ao ${providerName} o que fazer diferente`" maxlength="2000" />
              <button v-if="otherText.trim()" type="submit" class="small primary">Responder</button>
              <button v-else type="button" class="small skip" @click="decide(null)">Pular</button>
            </form>
          </div>
          <div v-else-if="t.id === questionTurn && showPlanAsk" class="ask">
            <div class="ask-head">
              <p class="ask-q">Deseja iniciar a implementação do plano?</p>
              <button type="button" class="ghost small see-plan" title="Abrir o plano para leitura" @click="planOpen = true"><Icon name="clipboard" :size="12" /> Ver plano</button>
              <button type="button" class="ghost nav" title="Fechar: continue pelo campo de mensagem" @click="askOpen = false"><Icon name="x" :size="13" /></button>
            </div>
            <div class="ask-opts">
              <button v-for="(m, i) in PLAN_STARTS" :key="m.id" type="button" class="ghost ask-opt" @click="startPlan(m.id)">
                <span class="num">{{ i + 1 }}</span>
                <span class="opt-body">
                  <span class="opt-label">Sim, implementar em "{{ m.label }}"<span v-if="m.id === approveMode" class="pill">{{ modeBeforePlan ? 'Modo anterior' : 'Padrão' }}</span></span>
                  <span class="opt-detail">{{ m.hint }}</span>
                </span>
              </button>
              <button type="button" class="ghost ask-opt" @click="askOpen = false">
                <span class="num">{{ PLAN_STARTS.length + 1 }}</span>
                <span class="opt-body">
                  <span class="opt-label">Não, continuar planejando</span>
                  <span class="opt-detail">Fecha este cartão; a conversa segue no modo Plano.</span>
                </span>
              </button>
            </div>
            <form class="ask-other" @submit.prevent="adjustPlan()">
              <Icon name="pencil" :size="13" class="pen" />
              <input v-model="otherText" type="text" :placeholder="`Não, e diga ao ${providerName} o que ajustar no plano`" maxlength="2000" />
              <button v-if="otherText.trim()" type="submit" class="small primary">Enviar</button>
            </form>
          </div>
        </div>
      </article>
    </main>

    <footer class="composer" :class="{ drop: dragging }">
      <div v-if="slashItems.length" class="slash">
        <button v-for="(c, i) in slashItems" :key="c.id" type="button" class="ghost slash-opt" :class="{ cur: i === slashIndex }" @mousedown.prevent @mouseenter="slashIndex = i" @click="runSlash(c)">
          <Icon :name="c.icon" :size="13" />
          <strong>{{ c.label }}</strong>
          <small class="ellipsis">{{ c.hint }}</small>
          <kbd>/{{ c.name }}</kbd>
        </button>
      </div>
      <div v-if="dragging" class="drop-hint"><Icon name="paperclip" :size="16" /> Solte para anexar</div>
      <div v-if="pending.length" class="pending">
        <span v-for="(a, i) in pending" :key="a.path" class="att" :title="`${a.path}${a.size ? ` · ${sizeOf(a.size)}` : ''}`">
          <img v-if="a.preview" :src="a.preview" alt="" />
          <Icon v-else :name="a.kind === 'image' ? 'panel' : a.kind === 'audio' ? 'mic' : 'paperclip'" :size="12" />
          <span class="ellipsis">{{ a.name }}</span>
          <button type="button" class="ghost rm" title="Remover" @click="removePending(i)"><Icon name="x" :size="11" /></button>
        </span>
      </div>
      <div v-if="pastes.length" class="pending">
        <span v-for="(p, i) in pastes" :key="p.id" class="att paste" :title="p.text.slice(0, 400)">
          <Icon name="list" :size="12" />
          <span class="paste-text">
            <span class="ellipsis">{{ pastePreview(p.text) }}</span>
            <small class="faint">Texto colado · {{ p.lines }} linhas · <a @click.prevent="pasteToField(i)">mostrar no campo</a></small>
          </span>
          <button type="button" class="ghost rm" title="Remover" @click="pastes.splice(i, 1)"><Icon name="x" :size="11" /></button>
        </span>
      </div>
      <p v-if="attachError" class="att-err">{{ attachError }}</p>
      <div v-if="queue.length" class="queue">
        <div v-for="(q, i) in queue" :key="q.id" class="queued" :title="q.body">
          <Icon name="list" :size="12" class="faint" />
          <span class="q-text ellipsis">{{ q.body }}</span>
          <small class="faint">na fila{{ q.attachments.length ? ` · ${q.attachments.length} anexo${q.attachments.length === 1 ? '' : 's'}` : '' }}</small>
          <span class="q-acts">
            <button type="button" class="ghost qa now" :title="`Enviar esta agora: ${nowVerb}`" @click="sendQueuedNow(i)"><Icon name="zap" :size="12" /></button>
            <button type="button" class="ghost qa" title="Voltar para o campo, para editar" @click="editQueued(i)"><Icon name="pencil" :size="11" /></button>
            <button type="button" class="ghost qa" title="Descartar" @click="discardQueued(i)"><Icon name="x" :size="12" /></button>
          </span>
        </div>
      </div>
      <textarea
        ref="box"
        v-model="draft"
        rows="1"
        :placeholder="!running ? 'Faça qualquer coisa (/ abre os comandos)' : sendAction === 'now' ? `Agente trabalhando… Enter ${nowVerb}` : `Agente trabalhando… Enter põe na fila, ⌘Enter ${nowVerb}`"
        :disabled="!info"
        @input="autosize"
        @keydown="onKey"
        @paste="onPaste"
      />
      <div class="row">
        <button type="button" class="ghost icon attach" title="Anexar arquivos (ou arraste/cole na janela)" :disabled="!info" @click="pickFiles">
          <Icon name="paperclip" :size="15" />
        </button>
        <ModelPicker v-model:provider="provider" v-model:model="model" v-model:effort="effort" providers :lock-provider="!!sessionId" :known="known" :defaults="pickerDefaults" />
        <div ref="modeRoot" class="mode-menu">
          <button type="button" class="chip" :class="[mode, { on: modeOpen }]" :title="currentMode.hint" @click="modeOpen = !modeOpen">
            <Icon :name="currentMode.icon" :size="12" />
            {{ currentMode.label }}
            <Icon name="chevron" :size="11" class="chev" />
          </button>
          <div v-if="modeOpen" class="pop">
            <button v-for="m in MODES" :key="m.id" type="button" class="ghost opt" :class="{ cur: mode === m.id }" @click="setMode(m.id), (modeOpen = false)">
              <Icon :name="m.icon" :size="13" />
              <span class="opt-text"><strong>{{ m.label }}</strong><small>{{ m.hint }}</small></span>
              <Icon v-if="mode === m.id" name="check" :size="13" class="ok" />
            </button>
          </div>
        </div>
        <span class="spacer" />
        <template v-if="running">
          <button v-if="!canCompose" type="button" class="icon send stop" title="Interromper" @click="stop"><Icon name="stop" :size="16" /></button>
          <div v-else ref="sendRoot" class="send-split" :class="[`as-${effectiveSend}`, { on: sendOpen }]">
            <button type="button" class="send-main" :title="`${currentSend.hint} (${currentSend.keys})`" :disabled="!info" @click="sendAs(effectiveSend)">
              <Icon :name="currentSend.icon" :size="13" /> {{ currentSend.label }}
            </button>
            <button type="button" class="send-more" title="Escolher como enviar" @click="sendOpen = !sendOpen"><Icon name="chevron" :size="11" class="chev" /></button>
            <div v-if="sendOpen" class="pop">
              <button v-for="a in SEND_ACTIONS" :key="a.id" type="button" class="ghost opt" :class="{ cur: sendAction === a.id }" @click="(sendAction = a.id), (sendOpen = false)">
                <Icon :name="a.icon" :size="13" />
                <span class="opt-text"><strong>{{ a.label }} <kbd>{{ a.keys }}</kbd></strong><small>{{ a.hint }}</small></span>
                <Icon v-if="sendAction === a.id" name="check" :size="13" class="ok" />
              </button>
              <hr class="sep" />
              <button type="button" class="ghost opt" @click="(sendOpen = false), stop()">
                <Icon name="stop" :size="13" />
                <span class="opt-text"><strong>Interromper</strong><small>Para a resposta atual; o texto continua no campo</small></span>
              </button>
            </div>
          </div>
        </template>
        <button v-else type="button" class="icon send primary" title="Enviar (Enter)" :disabled="!canCompose || !info" @click="send()"><Icon name="up" :size="16" /></button>
      </div>
    </footer>
    <Modal v-if="planOpen && planText" title="Plano" :width="760" @close="planOpen = false">
      <div class="md plan-read" @click="onMdClick" v-html="md(planText, false)" />
      <template #footer>
        <button type="button" class="ghost" @click="copyPlan"><Icon :name="planCopied ? 'check' : 'clipboard'" :size="13" /> {{ planCopied ? 'Copiado' : 'Copiar plano' }}</button>
        <button type="button" class="ghost" @click="planOpen = false">Fechar</button>
        <button type="button" class="primary" @click="startPlan(approveMode)">Implementar em "{{ MODES.find((m) => m.id === approveMode)?.label }}"</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.agent { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
.bar {
  height: var(--titlebar); display: flex; align-items: center; gap: 8px; padding: 0 14px; flex: none;
  border-bottom: 1px solid var(--border); background: var(--panel); -webkit-app-region: drag;
}
:root[data-platform='darwin'] .bar { padding-left: 90px; }
:root[data-platform='win32'] .bar, :root[data-platform='linux'] .bar { padding-right: 146px; }
.head-text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; -webkit-app-region: no-drag; line-height: 1.25; user-select: none; cursor: default; }
.title { display: inline-flex; align-items: center; height: 20px; gap: 6px; font-size: 13px; font-weight: 700; max-width: 100%; min-width: 0; }
.title.none { font-weight: 500; color: var(--muted); }
.title .pen { color: var(--faint); opacity: 0; flex: none; transition: opacity 0.12s; }
.title:hover .pen { opacity: 1; }
.title-input { height: 22px; padding: 0 6px; margin-left: -6px; font-size: 13px; font-weight: 700; width: min(100%, 420px); -webkit-app-region: no-drag; }
.sub { display: block; font-size: 11px; color: var(--muted); min-width: 0; }
.sub svg { vertical-align: -1px; }
.spacer { flex: 0 0 8px; }
.head-btn { width: 26px; height: 26px; border-radius: 8px; color: var(--muted); flex: none; margin-right: 6px; -webkit-app-region: no-drag; }
.head-btn:hover, .head-btn.on { color: var(--text); }
.head-btn.on { background: var(--hover); }
.head-btn.back { color: var(--accent); }
.head-btn.pin.pinned { color: var(--accent); }
.grid-menu { position: relative; flex: none; -webkit-app-region: no-drag; }
/* o menu do grid abre para baixo, encostado à direita do botão (mais específico que .pop, que vem depois e abre para cima) */
.grid-menu .pop { left: auto; right: 0; bottom: auto; top: calc(100% + 6px); width: 320px; -webkit-app-region: no-drag; }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); flex: none; white-space: nowrap; -webkit-app-region: no-drag; }
/* duração na linha de baixo, menor: o cabeçalho não quebra em janelas estreitas */
.status-text { display: flex; flex-direction: column; line-height: 1.2; }
.ball { width: 14px; height: 14px; border-radius: 50%; flex: none; display: grid; place-items: center; background: var(--faint); color: #fff; }
.status.idle .ball { background: var(--faint); opacity: 0.6; }
.status.live { color: var(--accent); }
.status.live .ball { width: 9px; height: 9px; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; box-shadow: 0 0 0 3px var(--accent-soft); }
.status.waiting { color: var(--mod); }
.status.waiting .ball { width: 9px; height: 9px; background: var(--mod); }
.status.done { color: var(--add); }
.status.done .ball { background: var(--add); }
.status.error { color: var(--del); }
.status.error .ball { background: var(--del); }
/* terminou e ainda não foi visto: a bolinha pisca de leve, com um halo, até o primeiro clique na janela */
.status.blink .ball { animation: unseen 1.6s ease-in-out infinite; }
@keyframes unseen {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 transparent; }
  50% { opacity: 0.35; box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 22%, transparent); }
}
@media (prefers-reduced-motion: reduce) { .status.blink .ball { animation-duration: 3.2s; } }
.status-took { color: var(--faint); font-size: 10px; font-weight: 400; font-variant-numeric: tabular-nums; }
@keyframes pulse { 50% { opacity: 0.35; } }

/* só rola na vertical: textos longos quebram e código/tabelas rolam por dentro do próprio bloco */
.thread { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 20px 22px 12px; display: flex; flex-direction: column; gap: 22px; }
.fatal { color: var(--del); }
.empty { margin: auto; max-width: 420px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.empty h2 { margin: 6px 0 0; font-size: 18px; font-weight: 700; }
.empty p { margin: 0; font-size: 12.5px; line-height: 1.5; }
.resumed { padding: 6px 10px; border-radius: 8px; background: var(--panel-2); }

.turn { display: flex; flex-direction: column; gap: 14px; min-width: 0; max-width: 100%; }
.user { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
/* hora e copiar: aparecem ao passar o mouse na mensagem */
.user-acts { display: flex; align-items: center; gap: 4px; height: 22px; opacity: 0; transition: opacity 0.12s; }
.user:hover .user-acts, .user-acts.on, .user-acts:focus-within { opacity: 1; }
.user-acts small { font-size: 11px; font-variant-numeric: tabular-nums; }
.ua { width: 22px; height: 22px; padding: 0; color: var(--faint); border-radius: 6px; }
.ua:hover { color: var(--text); }
.user-acts.on .ua { color: var(--add, var(--accent)); }
.bubble {
  max-width: 78%; padding: 10px 14px; border-radius: 16px 16px 4px 16px;
  background: var(--panel-2); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px;
}
.bubble p { margin: 0; font-size: var(--agent-size, 14px); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; line-height: 1.5; }
.atts, .pending { display: flex; flex-wrap: wrap; gap: 6px; }
.pending { padding: 2px 4px 0; }
.att {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px 0 6px; max-width: 220px;
  border-radius: 8px; background: var(--panel); border: 1px solid var(--border); font-size: 12px; color: var(--muted);
}
.att img { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; flex: none; }
.att.paste { height: auto; padding: 6px 8px 6px 8px; max-width: 320px; align-items: flex-start; }
.paste-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-family: var(--mono); font-size: 11.5px; color: var(--text); }
.paste-text small { font-family: var(--font); font-size: 11px; }
.paste-text a { color: var(--accent); cursor: pointer; }
.bubble p.clamp { display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
.more { height: 22px; padding: 0 6px; margin: -4px 0 0 -6px; align-self: flex-start; font-size: 11.5px; color: var(--accent); }
.att .rm { width: 18px; height: 18px; padding: 0; color: var(--faint); flex: none; }
.att-err { margin: 0 6px; font-size: 12px; color: var(--del); }
.attach { width: 30px; height: 30px; border-radius: 50%; color: var(--muted); flex: none; }
.composer.drop { border-color: var(--accent); background: var(--accent-soft); }
.drop-hint { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 6px; color: var(--accent); font-weight: 600; font-size: 12.5px; }
.answer { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.md { user-select: text; line-height: 1.6; font-size: var(--agent-size, 14px); min-width: 0; overflow-wrap: anywhere; }
.md :deep(p) { margin: 0 0 10px; }
.md :deep(p:last-child) { margin-bottom: 0; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 10px; padding-left: 22px; }
.md :deep(li) { margin: 3px 0; }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { margin: 12px 0 6px; font-size: calc(var(--agent-size, 14px) + 1px); }
.md :deep(code) { font-family: var(--mono); font-size: calc(var(--agent-size, 14px) - 1.5px); background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.md :deep(pre) { margin: 0 0 10px; padding: 10px 12px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; }
.md :deep(pre code) { background: transparent; padding: 0; }
.md :deep(.code-wrap) { position: relative; }
.md :deep(.code-wrap .copy) {
  position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; padding: 0; border-radius: 6px;
  border: 1px solid transparent; background: var(--panel-2); color: var(--faint); opacity: 0; transition: opacity 0.12s, color 0.12s;
}
.md :deep(.code-wrap:hover .copy), .md :deep(.code-wrap .copy:focus-visible), .md :deep(.code-wrap .copy.done) { opacity: 1; }
.md :deep(.code-wrap .copy:hover) { color: var(--text); border-color: var(--border); }
.md :deep(.code-wrap .copy svg:last-child) { display: none; }
.md :deep(.code-wrap .copy.done) { color: var(--add); }
.md :deep(.code-wrap .copy.done svg:first-child) { display: none; }
.md :deep(.code-wrap .copy.done svg:last-child) { display: block; }
.md :deep(a) { color: var(--accent); }
.md :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 10px; font-size: calc(var(--agent-size, 14px) - 1px); }
.md :deep(td), .md :deep(th) { border: 1px solid var(--border); padding: 4px 8px; }
.md :deep(blockquote) { margin: 0 0 10px; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }

/* grupo de ferramentas: uma linha apagada, como nos apps; abre a lista ao clicar */
.tools { display: flex; flex-direction: column; gap: 2px; }
.tools-line { justify-content: flex-start; gap: 8px; height: 26px; padding: 0 8px; margin-left: -8px; font-size: 12px; font-weight: 500; color: var(--faint); min-width: 0; max-width: 100%; }
.tools-line:hover { color: var(--muted); }
.tools-line .caret { transition: transform 0.12s; }
.tools.open .tools-line .caret { transform: rotate(90deg); }
.tools-sum { flex: none; }
.tools-now { min-width: 0; font-size: 11.5px; color: var(--faint); font-weight: 400; }
.tools-list { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 4px 6px; padding-left: 10px; border-left: 2px solid var(--border); }
.tool { border-radius: 8px; border: 1px solid transparent; }
.tool.click { cursor: pointer; }
.tool.click:hover, .tool.open { background: var(--panel); border-color: var(--border); }
.tool-line { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; min-width: 0; font-size: 12px; }
.tool-ic { color: var(--faint); }
.tool-title { color: var(--faint); flex: none; }
.tool-detail { min-width: 0; font-size: 11.5px; color: var(--muted); }
.tool-state { margin-left: auto; flex: none; display: grid; place-items: center; width: 16px; }
.tool-state .ok { color: var(--add); }
.tool-state .bad { color: var(--del); }
.spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
.tool-out {
  margin: 0 8px 8px; padding: 8px 10px; max-height: 260px; overflow: auto; border-radius: 8px;
  background: var(--panel-2); font-family: var(--mono); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; user-select: text;
}
.files { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 8px 10px; font-size: 12.5px; }
.files-head { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 4px; min-width: 0; }
.files-head .faint { font-weight: 400; }
.files-head .sep { margin: 0 2px; }
.repo { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.repo .favicon { width: 13px; height: 13px; object-fit: contain; border-radius: 3px; flex: none; }
.file { display: flex; align-items: center; gap: 12px; font-family: var(--mono); font-size: 12px; padding: 2px 0 2px 18px; user-select: text; min-width: 0; }
.file > .ellipsis { flex: 1; min-width: 0; }
.stat { margin-left: auto; flex: none; font-family: var(--mono); font-size: 11.5px; font-weight: 500; }
.stat .add { color: var(--add); font-weight: inherit; }
.stat .del { color: var(--del); font-weight: inherit; }
.progress { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12.5px; padding: 2px 0; }
.progress .mono { font-size: 12px; font-variant-numeric: tabular-nums; }
.hurry { width: 22px; height: 22px; padding: 0; border-radius: 6px; color: var(--faint); flex: none; }
.hurry:hover { color: var(--text); }
.hurry.on, .hurry.on:disabled { color: var(--accent); opacity: 1; }
.spin-logo { animation: breathe 1.6s ease-in-out infinite; margin-right: 2px; }
@keyframes breathe { 50% { opacity: 0.35; transform: scale(0.9); } }
.err { margin: 0; display: flex; align-items: flex-start; gap: 6px; padding: 8px 10px; border-radius: 8px; background: var(--del-bg); color: var(--del); font-size: 12.5px; user-select: text; }
.meta { margin: 0; font-size: 11px; }
/* cartão de pergunta do agente */
.ask { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 12px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel); max-width: 640px; }
.ask-head { display: flex; align-items: flex-start; gap: 8px; }
.see-plan { flex: none; gap: 5px; color: var(--accent); }
.plan-read { max-height: min(64vh, 720px); overflow: auto; padding-right: 6px; }
.ask-q { margin: 0; flex: 1; min-width: 0; font-size: calc(var(--agent-size, 14px) + 0.5px); font-weight: 600; line-height: 1.45; user-select: text; }
.ask-nav { display: inline-flex; align-items: center; gap: 2px; flex: none; color: var(--muted); }
.ask-count { font-size: 11.5px; padding: 0 4px; font-variant-numeric: tabular-nums; }
.nav { width: 22px; height: 22px; padding: 0; border-radius: 6px; color: var(--muted); flex: none; }
.nav:hover:not(:disabled) { color: var(--text); }
.nav:disabled { opacity: 0.3; }
.nav .prev { transform: rotate(180deg); }
.ask-opts { display: flex; flex-direction: column; gap: 2px; }
.ask-opt { height: auto; padding: 7px 8px; border-radius: 10px; justify-content: flex-start; align-items: flex-start; gap: 12px; text-align: left; white-space: normal; color: var(--text); }
.ask-opt.cur { background: var(--accent-soft); }
.ask-opt .num { width: 20px; height: 20px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 11px; font-weight: 600; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); margin-top: 1px; }
.ask-opt:hover .num, .ask-opt.cur .num { color: var(--text); border-color: var(--accent); }
.opt-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.opt-label { font-size: var(--agent-size, 14px); font-weight: 600; line-height: 1.45; }
.opt-detail { font-size: calc(var(--agent-size, 14px) - 1px); line-height: 1.45; color: var(--muted); font-weight: 400; }
.pill { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); vertical-align: 1px; }
.ask-other { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 6px 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); }
.ask-other:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.ask-other .pen { color: var(--faint); flex: none; }
.ask-other input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; padding: 0; font-size: calc(var(--agent-size, 14px) - 0.5px); }
.ask-other input:focus { box-shadow: none; }
.ask-other .small { height: 26px; border-radius: 999px; flex: none; }
.ask-other .skip { background: var(--panel); }

.composer {
  position: relative; flex: none; margin: 0 16px 16px; padding: 10px 10px 8px; border-radius: 18px;
  background: var(--panel); border: 1px solid var(--border); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  display: flex; flex-direction: column; gap: 6px;
}
/* menu de comandos ("/"): flutua acima do campo, na largura dele */
.slash {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: 30; padding: 6px; max-height: 260px; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.slash-opt { justify-content: flex-start; gap: 8px; height: 32px; padding: 0 10px; border-radius: 8px; color: var(--text); min-width: 0; }
.slash-opt.cur { background: var(--hover); }
.slash-opt strong { font-size: 12.5px; flex: none; }
.slash-opt small { font-size: 12px; color: var(--muted); flex: 1; min-width: 0; text-align: left; }
.slash-opt kbd { font-family: var(--mono); font-size: 10.5px; color: var(--faint); flex: none; }
.composer:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.composer textarea { border: 0; background: transparent; padding: 6px 6px 2px; font-size: var(--agent-size, 14px); line-height: 1.45; max-height: 200px; overflow-y: auto; }
.composer textarea:focus { box-shadow: none; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.row .spacer { flex: 1 1 auto; }
.chip { height: 30px; padding: 0 10px; gap: 6px; border-radius: 999px; font-size: 12px; color: var(--muted); flex: none; }
.chip.full { color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); }
.chip.plan { color: var(--hunk); border-color: color-mix(in srgb, var(--hunk) 45%, var(--border)); }
.chip.on { background: var(--hover); }
.chip .chev { transform: rotate(-90deg); color: var(--faint); }
.mode-menu { position: relative; flex: none; }
.pop {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30; width: 300px; padding: 6px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.opt { justify-content: flex-start; gap: 10px; height: auto; padding: 8px 10px; text-align: left; white-space: normal; color: var(--text); }
.opt.cur { background: var(--accent-soft); }
.opt-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.opt-text strong { font-size: 12.5px; }
.opt-text small { font-size: 11px; color: var(--muted); line-height: 1.35; }
.opt .ok { color: var(--accent); flex: none; }
.opt kbd { font-family: var(--mono); font-size: 10.5px; font-weight: 400; color: var(--muted); margin-left: 6px; }
.sep { border: 0; border-top: 1px solid var(--border); margin: 4px 6px; }
.send { width: 34px; height: 34px; border-radius: 50%; flex: none; }
/* botão de envio dividido: a ação escolhida à esquerda, a seta abre o menu para trocar */
.send-split { position: relative; display: inline-flex; height: 34px; flex: none; border-radius: 999px; background: var(--text); color: var(--bg); }
.send-split.as-now { background: var(--accent); color: var(--on-accent); }
.send-main, .send-more { height: 100%; border: 0; background: transparent; color: inherit; }
.send-main { padding: 0 10px 0 14px; gap: 6px; font-size: 12.5px; font-weight: 600; border-radius: 999px 0 0 999px; }
.send-more { width: 28px; padding: 0 4px 0 0; border-radius: 0 999px 999px 0; border-left: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.send-main:hover:not(:disabled), .send-more:hover:not(:disabled), .send-split.on .send-more { background: color-mix(in srgb, currentColor 14%, transparent); }
.send-split .chev { transform: rotate(90deg); color: inherit; }
.send-split .pop { left: auto; right: 0; }
.queue { display: flex; flex-direction: column; gap: 2px; padding: 2px 4px 0; }
.queued { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; border-radius: 8px; background: var(--panel-2); font-size: 12px; min-width: 0; }
.q-text { flex: 1; min-width: 0; }
.queued small { font-size: 11px; flex: none; }
.q-acts { display: inline-flex; gap: 2px; flex: none; margin-right: -4px; }
.qa { width: 22px; height: 22px; padding: 0; border-radius: 6px; color: var(--faint); }
.qa:hover { color: var(--text); }
.qa.now { color: var(--accent); }
.qa.now:hover { background: var(--accent-soft) !important; }
.send.stop { background: var(--text); color: var(--bg); border-color: var(--text); }
</style>
