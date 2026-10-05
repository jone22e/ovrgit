<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  GridCell,
  AgentAction, AgentAsk, AgentSnapshot,
  AgentAttachment, AgentBlock, AgentChatEvent, AgentEffort, AgentMode, AgentTurn, AgentWindowInfo, CliProvider, FileRepo, GridPlacement, GridSize, KnownModels, Settings
} from '@shared/types'
import { DEFAULT_EFFORT, DEFAULT_MODEL, MODES, PROVIDER_LABEL, catalogOf, modelLabel } from '@shared/models'
import { GRID_DEFAULT, clampGrid, fitGrid, gridLimitsFor, normalizeGrid } from '@shared/grid'
import { formatAnswers, splitQuestions, type AgentQuestion } from '@shared/questions'
import { checksOf } from '@shared/agentChecks'
import { readCodexFast } from './agentPrefs'
import { useDictation } from './dictation'
import { AUTO_RETRY_DELAYS, AUTO_RETRY_MAX, canAutoRetry } from '@shared/autoRetry'
import { summaryOf } from '@shared/summary'
import { applyMarkers, CHECKLIST_PROGRESS, checklistReminder, isPlanMode, parseChecklist, type ChecklistItem } from '@shared/checklist'
import { nowLabel } from '@shared/activity'
import { findArtifacts } from '@shared/artifacts'
import { ARCH_PHASES, archPlanRequest, cleanDesignHtml, designRequest, extractHtml, extractSummary, hasInterface, stripArchMarkers, type ArchPhase, type ArchState, type DesignAction, type DesignWindowState } from '@shared/architect'
import AgentLogo from './components/AgentLogo.vue'
import AskCard from './components/AskCard.vue'
import FileCard from './components/FileCard.vue'
import Icon from './components/Icon.vue'
import Modal from './components/Modal.vue'
import ModelPicker from './components/ModelPicker.vue'
import RepoMenu from './components/RepoMenu.vue'
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
// Modo Arquiteto: declarados cedo porque a situação da janela (lida por observadores imediatos) depende deles
/** Estado do Modo Arquiteto desta conversa (fica na vez em que a descoberta começou) */
const arch = computed<ArchState | null>(() => turns.find((t) => t.arch)?.arch ?? null)
/** Painel de design: aberto, desenhando agora, HTML parcial, atividade e erro */
const designOpen = ref(false)
const designRunning = ref(false)
const designLive = ref('')
const designActivity = ref('')
const designError = ref<string | null>(null)
const pending = reactive<Shown[]>([])
/**
 * Arrasto de arquivos sobre a janela. O aviso liga a cada `dragenter` e `dragover` (com o arquivo por cima, o
 * navegador manda `dragover` sem parar, mesmo com o ponteiro parado) e só desliga quando o arrasto sai da janela,
 * termina ou para de dar sinal. Não conta entradas e saídas dos elementos: a contagem se perdia quando algo a
 * zerava no meio do arrasto, e daí em diante cada troca de elemento apagava o aviso.
 */
const dragging = ref(false)
let dragTimer: ReturnType<typeof setTimeout> | undefined
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
function onDragMove(e: DragEvent) {
  if (!hasFiles(e)) return
  dragging.value = true
  // arrasto cancelado sem avisar (Esc, solto fora): sem `dragover` por um tempo, o aviso sai sozinho
  clearTimeout(dragTimer)
  dragTimer = setTimeout(dragReset, 1200)
}
function onDragLeave(e: DragEvent) {
  // saiu da janela: não há elemento de destino, ou o ponteiro está fora dela
  const out = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight
  if (!e.relatedTarget && out) dragReset()
}
function dragReset() {
  clearTimeout(dragTimer)
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
const mode = ref<AgentMode>('full')
const thread = ref<HTMLElement>()
const box = ref<HTMLTextAreaElement>()
const fatal = ref<string | null>(null)
const offs: (() => void)[] = []

const providerName = computed(() => PROVIDER_LABEL[provider.value])
/** Retomada automática depois de uma falha: segundos até a próxima tentativa (null: nenhuma marcada) */
const retryIn = ref<number | null>(null)
/** Tentativas seguidas já feitas; zera quando uma resposta termina bem ou o usuário manda uma mensagem */
const autoRetries = ref(0)
/** As tentativas acabaram sem sucesso: o cartão da falha avisa e espera o usuário decidir */
const retryGaveUp = ref(false)
/** Situação do agente no cabeçalho: cinza sem conversa, pulsando trabalhando, check verde ao terminar, × vermelho se falhou,
 *  âmbar enquanto um cartão (perguntas do agente ou aprovação do plano) espera a resposta do usuário. */
const statusKind = computed<'idle' | 'live' | 'waiting' | 'done' | 'error'>(() => {
  if (running.value || designRunning.value) return 'live'
  if (!turns.length) return 'idle'
  // entre uma tentativa e outra da retomada automática o agente segue "trabalhando"
  if (retryIn.value !== null) return 'live'
  if (turns[turns.length - 1].error) return 'error'
  // o conceito visual esperando aprovação também é "precisa de você"
  const conceptWaiting = arch.value?.phase === 'concept' && arch.value.design?.approved === undefined
  return showAsk.value || showPlanAsk.value || conceptWaiting ? 'waiting' : 'done'
})
const statusLabel = computed(() => ({ idle: 'sem conversa', live: 'trabalhando', waiting: 'aguardando resposta', done: 'concluído', error: 'falhou' })[statusKind.value])
/** Quanto tempo a última tarefa levou, mostrado discretamente ao lado do "concluído" */
const statusTook = computed(() => (statusKind.value === 'done' ? took(turns[turns.length - 1]?.durationMs) : ''))
const statusTitle = computed(() => ({ idle: 'A conversa ainda não começou', live: 'O agente está trabalhando', waiting: 'O agente está aguardando a sua resposta', done: 'O agente terminou a última tarefa', error: 'A última tarefa terminou com erro' })[statusKind.value])
const modeOpen = ref(false)
const modeRoot = ref<HTMLElement>()
const currentMode = computed(() => MODES.find((m) => m.id === mode.value) ?? MODES[MODES.length - 1])
/** Modo em uso quando o usuário ativou o Plano (menu ou /plan): é para ele que a aprovação do plano volta */
const modeBeforePlan = ref<AgentMode | null>(null)
function setMode(m: AgentMode) {
  if (isPlanMode(m) && !isPlanMode(mode.value)) modeBeforePlan.value = mode.value
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
/** Maior grid que cabe na tela onde a janela está: relido a cada abertura do menu (a janela pode ter mudado de tela) */
const screenArea = () => ({ width: window.screen.availWidth, height: window.screen.availHeight })
const gridLimits = ref<GridSize>(gridLimitsFor(screenArea()))
/** Grid usado nesta tela: o configurado, encaixado no limite dela */
const shownGrid = computed(() => clampGrid(gridSize.value, gridLimits.value))
async function setGridSize(s: GridSize) {
  const from = shownGrid.value
  const to = fitGrid(s, screenArea())
  if (to.cols === from.cols && to.rows === from.rows) return
  gridSize.value = to
  api.saveSettings({ agentGrid: to }).catch(() => undefined)
  // as janelas de agente desta tela acompanham o grid novo; depois o desenho mostra onde cada uma ficou
  await api.agentRegrid(uid, { ...from }, { ...to }).catch(() => undefined)
  gridCells.value = await api.agentGridCells(uid, { ...to }).catch(() => [])
}
/** Escolha feita no grid: a janela vai para a área correspondente da tela e o menu fecha */
/** Células já cobertas por janelas de agente: recarrega ao abrir o menu e ao mudar o tamanho do grid */
const gridCells = ref<GridCell[]>([])
watch([gridOpen, gridSize], async ([open]) => {
  if (!open) return
  gridLimits.value = gridLimitsFor(screenArea())
  gridCells.value = await api.agentGridCells(uid, { ...shownGrid.value }).catch(() => [])
})
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
/** Enquanto roda, mostra o que está fazendo agora, em português claro (comandos traduzidos para o que fazem) */
const groupNow = (items: ToolBlock[]) => {
  const cur = items.find((i) => i.ok === null) ?? items[items.length - 1]
  return cur ? nowLabel(cur) : ''
}
function toggleGroup(key: string) {
  if (openGroups.has(key)) openGroups.delete(key)
  else openGroups.add(key)
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Markdown do agente → HTML seguro. */
/** Markdown da resposta. Os blocos ```question saem do texto: viram o cartão de perguntas enquanto ele está
 * ativo; em vezes já respondidas, ficam como texto comum (pergunta em negrito e opções em lista). */
/** Marcadores do checklist ("[ok] 3"): o cartão já mostra; na conversa só poluem */
const MARKERS = /^[ \t]*(?:\[(?:ok|x|concluído|concluido|done|falhou|erro|failed|pulado|pulada|dispensado|dispensada|skipped|n\/a)\]|✅|❌)[ \t]*(?:item\s*|etapa\s*|passo\s*)?#?\d{1,2}[ \t]*$\n?/gim
/**
 * O resultado fica guardado por texto: a janela se redesenha a cada segundo e a cada pedaço de resposta enquanto
 * o agente trabalha, e sem isso o markdown da conversa inteira era reprocessado toda vez (numa conversa longa,
 * metade de um núcleo só nisso). `stable: false` (resposta ainda chegando): não guarda, o texto muda a cada pedaço.
 */
const mdCache = new Map<string, string>()
const MD_CACHE_MAX = 1500
function md(text: string, card: boolean, stable = true) {
  const key = (card ? '1' : '0') + text
  if (stable) {
    const hit = mdCache.get(key)
    if (hit !== undefined) return hit
  }
  const { text: rest, questions: qs } = splitQuestions(stripArchMarkers(text.replace(MARKERS, '')))
  const plain = card ? '' : qs.map((q) => `\n\n**${q.text}**\n${q.options.map((o) => `- ${o.label}${o.detail ? ` — ${o.detail}` : ''}`).join('\n')}`).join('')
  const html = withCopy(DOMPurify.sanitize(marked.parse(rest + plain, { async: false, gfm: true, breaks: false })))
  if (stable) {
    // o mais antigo sai quando enche (o Map guarda a ordem de inserção)
    if (mdCache.size >= MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value as string)
    mdCache.set(key, html)
  }
  return html
}
/** Arquivos gerados citados numa resposta terminada, também guardados por texto (mesmo motivo) */
const artifactsCache = new Map<string, string[]>()
function artifactsOf(text: string): string[] {
  let list = artifactsCache.get(text)
  if (!list) {
    if (artifactsCache.size >= MD_CACHE_MAX) artifactsCache.delete(artifactsCache.keys().next().value as string)
    artifactsCache.set(text, (list = findArtifacts(text)))
  }
  return list
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
const questionTurn = computed(() => turns[turns.length - 1]?.id)
watch(questionTurn, () => {
  decided.splice(0)
  qi.value = 0
  askOpen.value = true
})
const question = computed(() => questions.value[qi.value])
const showAsk = computed(() => askOpen.value && !!question.value)

// ---------- fim do plano: o app pergunta se deseja iniciar a implementação ----------
/** A última vez foi em modo plano e terminou bem, com texto e sem perguntas do modelo: o plano está pronto */
const planDone = computed(() => {
  const t = turns[turns.length - 1]
  if (!t || t.running || running.value || t.error || !isPlanMode(t.mode) || questions.value.length) return false
  return t.blocks.some((b) => b.kind === 'text' && b.text.trim())
})
const showPlanAsk = computed(() => askOpen.value && planDone.value && !(turns[turns.length - 1]?.mode === 'architect' && arch.value?.phase !== 'discovery'))
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
/** Modo recomendado para implementar o plano: sempre "Controle Total" (o plano já foi lido e aprovado) */
const approveMode = computed<AgentMode>(() => 'full')
/** Modos que executam: cada um vira uma opção do cartão, com o da aprovação em primeiro */
const PLAN_STARTS = computed(() => MODES.filter((m) => !isPlanMode(m.id)).sort((a, b) => Number(b.id === approveMode.value) - Number(a.id === approveMode.value)))
/** O cartão aberto (pergunta ou aprovação do plano), no formato do AskCard: o mesmo vai para o gerenciador de agentes */
const askModel = computed<AgentAsk | null>(() => {
  if (showAsk.value && question.value)
    return {
      kind: 'question',
      text: question.value.text,
      options: question.value.options.map((o) => ({ label: o.label, detail: o.detail, recommended: o.recommended })),
      index: qi.value,
      total: questions.value.length,
      current: decided[qi.value] ?? null
    }
  if (showPlanAsk.value && discoveryDone.value) {
    // descoberta do Modo Arquiteto: aprovar o entendimento e seguir para o conceito visual ou direto para o plano
    const ui = hasInterface(lastText.value)
    return {
      kind: 'plan',
      title: 'O entendimento está certo?',
      see: 'Ver resumo',
      stay: { label: 'Não, ajustar o entendimento', detail: 'Fecha este cartão; escreva o que mudar e o resumo é refeito.' },
      adjustHint: `Não, e diga ao ${providerName.value} o que entendeu errado`,
      options: [
        { mode: 'architect' as AgentMode, label: 'Sim, desenhar o conceito visual', detail: 'Abre o modo de design ao lado da conversa, com um mockup do que foi entendido.', pill: ui === false ? undefined : 'Recomendado' },
        { mode: 'checklist' as AgentMode, label: 'Sim, ir direto ao plano completo', detail: 'Sem conceito visual: o plano avançado com checklist é o próximo passo.', pill: ui === false ? 'Recomendado' : undefined }
      ],
      plan: planText.value
    }
  }
  if (showPlanAsk.value)
    return {
      kind: 'plan',
      options: PLAN_STARTS.value.map((m) => ({
        mode: m.id,
        label: `Sim, implementar em "${m.label}"`,
        detail: m.hint,
        pill: m.id === approveMode.value ? 'Recomendado' : undefined
      })),
      plan: planText.value
    }
  return null
})
/** Implementa o plano: troca o modo e pede na mesma sessão (o agente lembra o plano que acabou de escrever) */
async function startPlan(m: AgentMode) {
  planOpen.value = false
  if (discoveryDone.value) return approveDiscovery(m === 'architect')
  if (arch.value) arch.value.phase = 'execute'
  // Plano com Checklist: os itens do plano viram o checklist da implementação, marcado conforme o agente avisa
  const items = turns[turns.length - 1]?.mode === 'checklist' ? parseChecklist(planText.value) : []
  mode.value = m
  askOpen.value = false
  const body = items.length ? `Implemente o plano acima. ${CHECKLIST_PROGRESS}` : 'Implemente o plano acima.'
  await dispatch({ id: crypto.randomUUID(), body, attachments: [] }, undefined, items.length ? items.map((i) => ({ ...i, done: false })) : undefined)
}
/** Checklist em andamento (ou o último), para o cartão fixo e o gerenciador */
const checklist = computed(() => [...turns].reverse().find((t) => t.checklist?.length)?.checklist ?? null)
const checklistDone = computed(() => checklist.value?.filter((i) => i.done).length ?? 0)
const checklistTurn = computed(() => [...turns].reverse().find((t) => t.checklist?.length) ?? null)
/** Painel do checklist (parte da janela, entre a conversa e o campo): recolhe para uma linha com o progresso */
const checklistOpen = ref(true)
const checklistNext = computed(() => checklist.value?.findIndex((i) => !i.done) ?? -1)
/** Etapas ainda em aberto (nem concluídas nem dispensadas) */
const checklistPending = computed(() => checklist.value?.filter((i) => !i.done).length ?? 0)
/** O agente parou e ficaram etapas em aberto: o painel explica e oferece continuar, marcar ou dispensar */
const checklistStopped = computed(() => !!checklist.value && checklistPending.value > 0 && !running.value)
/** Continua de onde parou: a mensagem aparece na conversa; a lista do que falta vai junto (ver dispatch) */
function continueChecklist() {
  if (!checklistStopped.value) return
  // direto ao agente, sem passar pelo campo: o que estiver digitado ou anexado ali fica como está
  dispatch({ id: crypto.randomUUID(), body: 'Continue o checklist: resolva as etapas em aberto, uma a uma.', attachments: [] })
}
/** O usuário encerra uma etapa por conta própria: feita por fora, ou dispensada */
function resolveItem(it: ChecklistItem, how: 'done' | 'skipped') {
  it.done = true
  if (how === 'skipped') {
    it.state = 'skipped'
    it.note = 'dispensada por você'
  } else {
    delete it.state
    delete it.note
  }
}
/** Reabre uma etapa encerrada (por engano, ou para o agente refazer) */
function reopenItem(it: ChecklistItem) {
  it.done = false
  delete it.state
  delete it.note
}
/** Ajuste ao plano: continua em modo plano com o que o usuário escreveu */
async function adjustPlan(raw: string) {
  const text = raw.trim()
  if (!text) return
  askOpen.value = false
  await dispatch({ id: crypto.randomUUID(), body: text, attachments: [] })
}
/** Escolhe (ou pula, com null) a pergunta atual; segue para a próxima sem decisão, ou envia tudo numa mensagem só */
async function decide(choice: string | null) {
  const qs = questions.value
  if (!qs.length) return
  decided[qi.value] = choice === null ? null : choice.trim() || null
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

/**
 * Os pedaços de texto da resposta chegam às dezenas por segundo e cada um redesenhava a janela. Eles são
 * juntados e aplicados no máximo ~12 vezes por segundo; qualquer outro evento aplica antes o texto pendente,
 * para a ordem dos blocos não mudar.
 */
let textBuf = ''
let textTimer: ReturnType<typeof setTimeout> | undefined
function flushText() {
  clearTimeout(textTimer)
  textTimer = undefined
  if (!textBuf) return
  const delta = textBuf
  textBuf = ''
  apply({ type: 'text', delta })
}
function onEvent(ev: AgentChatEvent) {
  if (ev.type === 'text') {
    textBuf += ev.delta
    if (!textTimer) textTimer = setTimeout(flushText, 80)
    return
  }
  flushText()
  apply(ev)
}
function apply(ev: AgentChatEvent) {
  lastEventAt.value = Date.now()
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
    // "[ok] N", "[pulado] N", "[falhou] N" no texto marcam o item: na resposta que implementa o plano e também nas
    // seguintes, enquanto o checklist da conversa tiver etapas em aberto
    const list = t.checklist?.length ? t.checklist : checklist.value
    if (list?.length) applyMarkers(list, t.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n'))
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
    if (!t.error) resetRetry()
    // falha passageira e nada na fila: a retomada sai sozinha, sem notificar (só avisa se as tentativas acabarem)
    if (sendAfterStop || queue.length || !scheduleRetry(t)) notifyDone(t)
    nextTick(() => box.value?.focus())
    // interrompida para dar lugar a outra mensagem: não é erro
    if (sendAfterStop) {
      t.superseded = true
      if (t.error === 'Interrompido.') t.error = undefined
    }
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
// a lista de conversas da janela principal mostra esta situação
watch(statusKind, (k) => api.agentReportStatus(uid, k), { immediate: true })

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
    for (const a of await api.agentPickFiles(uid)) {
      pushPending(a)
      loadPreview(pending[pending.length - 1])
    }
  } catch (e) {
    attachError.value = clean(e)
  }
}

const PREVIEW_MAX = 25 * 1024 * 1024
/** Miniatura de uma imagem anexada que ainda não tem (escolhida pelo seletor, ou de uma conversa reaberta) */
async function loadPreview(a: Shown | undefined) {
  if (!a || a.preview || a.kind !== 'image') return
  const url = await api.agentImage(a.path).catch(() => null)
  if (url) a.preview = url
}
/** Imagem aberta em tamanho maior (clique na miniatura) */
const zoom = ref<{ src: string; name: string } | null>(null)
const zoomImg = ref<HTMLImageElement>()
/** Resultado da última cópia da imagem aberta (some depois de um instante) */
const zoomCopied = ref<'ok' | 'fail' | null>(null)
/** Copia a imagem aberta para a área de transferência, como PNG (qualquer formato de origem passa pelo canvas) */
async function copyZoom() {
  const img = zoomImg.value
  if (!img || !img.naturalWidth) return
  try {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    // a escrita é feita pelo processo principal: a API do navegador exige o documento em foco
    await api.copyImage(canvas.toDataURL('image/png'))
    zoomCopied.value = 'ok'
  } catch {
    zoomCopied.value = 'fail'
  }
  setTimeout(() => (zoomCopied.value = null), 1600)
}
const onZoomKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') zoom.value = null
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
    e.preventDefault()
    copyZoom()
  }
}
watch(zoom, (z) => {
  zoomCopied.value = null
  if (z) window.addEventListener('keydown', onZoomKey)
  else window.removeEventListener('keydown', onZoomKey)
})

/** Arquivos vindos do sistema (arrastados) ou só com bytes (colados): os sem caminho são guardados pelo app. */
async function addFiles(files: File[]) {
  attachError.value = null
  for (const f of files) {
    try {
      // a prévia vem dos bytes lidos agora, não do arquivo: o original pode sumir (captura de tela arrastada
      // da miniatura do macOS) e uma prévia ligada a ele quebraria junto
      const preview = isImage(f.type, f.name) && f.size <= PREVIEW_MAX ? URL.createObjectURL(new Blob([await f.arrayBuffer()], { type: f.type || 'image/png' })) : undefined
      const real = api.filePath(f)
      if (real) {
        pushPending({ ...(await api.agentKeepFile(uid, real)), preview })
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
  /** Pedido do app (ex.: o aviso de pressa): vai para o agente sem aparecer como mensagem na conversa */
  silent?: boolean
  /** Instruções do app que acompanham a mensagem: vão para o agente, não aparecem na conversa */
  hidden?: string
  /** Tentativa da retomada automática (não zera a contagem de tentativas) */
  auto?: boolean
  attachments: Shown[]
}
const canCompose = computed(() => !!(draft.value.trim() || pastes.length || pending.length))

/** "/plan" (ou /plano, /planejar) como palavra solta: depois de um espaço ou no começo de uma linha, e sem nada colado depois */
const PLAN_CMD = /(^|\s)\/(?:plan|plano|planejar)(?=\s|$)/i
const PLAN_CMD_ALL = new RegExp(PLAN_CMD.source, 'gi')

/** Tira do campo o que foi digitado, colado e anexado; null se não há nada. */
function takePayload(text = draft.value): Payload | null {
  // /plan em qualquer ponto do texto (no começo, no meio ou numa linha só dele) troca para o modo Plano;
  // o comando sai da mensagem e o resto segue, já nesse modo
  const cmd = PLAN_CMD.test(text)
  if (cmd) setMode('plan')
  // onde o comando estava não sobra espaço dobrado nem linha vazia a mais
  const typed = (cmd ? text.replace(PLAN_CMD_ALL, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n') : text).trim()
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
async function dispatch(p: Payload, since?: number, checklistItems?: ChecklistItem[]) {
  if (!info.value) return
  if (p.auto) clearRetryTimer()
  else resetRetry()
  const turn: Turn = { id: p.id, user: p.silent ? '' : p.body, silent: p.silent, attachments: p.attachments, blocks: [], running: true, thinking: true, activity: 'thinking', startedAt: Date.now(), workSince: since, mode: mode.value, checklist: checklistItems }
  // checklist com etapas em aberto: a mensagem vai com a lista do que falta (o usuário vê só o que escreveu)
  const reminder = !checklistItems && !p.silent && checklist.value ? checklistReminder(checklist.value) : ''
  // Modo Arquiteto: a primeira vez neste modo abre a descoberta; o estado da conversa fica guardado nela
  const discovery = mode.value === 'architect'
  if (discovery && !arch.value) turn.arch = { phase: 'discovery' }
  else if (discovery && arch.value) arch.value.phase = 'discovery'
  turns.push(turn)
  running.value = true
  scrollToEnd(true)
  try {
    await api.agentSend(
      uid,
      [p.body, p.hidden, reminder].filter(Boolean).join('\n\n'),
      // (na descoberta o processo principal troca para um modelo rápido e esforço baixo só nessa chamada)
      { model: model.value, effort: effort.value, mode: mode.value, provider: provider.value, fast: provider.value === 'codex' && readCodexFast() },
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

// ---------- Modo Arquiteto: descoberta → conceito → plano → execução ----------
/** Texto da última resposta (para ler o marcador de interface) */
const lastText = computed(() => (turns[turns.length - 1]?.blocks ?? []).flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n'))
/** A última vez foi a descoberta e terminou: o cartão pergunta se o entendimento está certo */
const discoveryDone = computed(() => planDone.value && turns[turns.length - 1]?.mode === 'architect' && arch.value?.phase === 'discovery')
/** Etapas da faixa do topo: feita, atual ou por vir */
const archSteps = computed(() => {
  const a = arch.value
  if (!a) return []
  const order: ArchPhase[] = ['discovery', 'concept', 'plan', 'execute']
  const cur = order.indexOf(a.phase)
  const allDone = a.phase === 'execute' && !running.value && !!checklist.value && checklistPending.value === 0
  return ARCH_PHASES.map((p, i) => ({
    ...p,
    state: allDone || i < cur ? 'done' : i === cur ? 'now' : 'next',
    skipped: p.id === 'concept' && (a.design?.approved === 'skipped' || (!a.design && cur > 1))
  }))
})
/** Etapa atual, com o número (para o cartão) */
const archNow = computed(() => {
  const i = Math.max(0, archSteps.value.findIndex((s) => s.state === 'now'))
  const done = archSteps.value.length && archSteps.value.every((s) => s.state === 'done')
  return done ? { label: 'Concluído', n: 4 } : { label: archSteps.value[i]?.label ?? '', n: i + 1 }
})
/** Cartão do arquiteto: recolhido mostra só a etapa atual; aberto, as quatro com o que cada uma faz */
const archOpen = ref(false)
const ARCH_ABOUT: Record<ArchPhase, string> = {
  discovery: 'Primeira leitura do pedido, em segundos, para conferir o entendimento.',
  concept: 'Mockup das telas no painel de design, com revisões até aprovar.',
  plan: 'Plano completo de implementação, com checklist.',
  execute: 'Implementação, marcando o checklist.'
}
/** Etapa do plano sem plano pronto nem em andamento (interrompido, ou conversa reaberta): oferece pedir de novo */
const archCanReplan = computed(() => arch.value?.phase === 'plan' && !running.value && (!planDone.value || !parseChecklist(planText.value).length))
/** O que se espera agora, em uma frase, ao lado das etapas */
const archHint = computed(() => {
  const a = arch.value
  if (!a) return ''
  if (a.phase === 'discovery') return running.value ? 'Interpretando o pedido…' : discoveryDone.value ? 'Confira se o entendimento está certo' : 'Ajuste o entendimento pela conversa'
  if (a.phase === 'concept') return designRunning.value ? 'Desenhando o conceito…' : a.design?.versions.length ? 'Revise o layout ou aprove o conceito' : 'Conceito visual'
  if (a.phase === 'plan') return running.value ? 'Escrevendo o plano completo…' : archCanReplan.value ? 'O plano completo ainda não foi escrito' : 'Aprove o plano para começar a execução'
  if (running.value) return checklist.value ? `Implementando · ${checklistDone.value} de ${checklist.value.length} etapas` : 'Implementando…'
  return checklist.value && checklistPending.value === 0 ? 'Concluído' : 'Execução'
})
/** Entendimento aprovado: guarda o resumo e segue para o conceito visual ou direto para o plano */
async function approveDiscovery(concept: boolean) {
  const a = arch.value
  if (!a) return
  a.brief = stripArchMarkers(planText.value).trim()
  a.hasUi = hasInterface(lastText.value)
  askOpen.value = false
  if (!concept) return startArchPlan()
  a.phase = 'concept'
  if (!a.design) {
    // a IA do design é própria: por padrão o Claude (desenha bem em HTML), no modelo que ele usa por último
    const d = pickerDefaults?.claude
    a.design = { provider: 'claude', model: d?.model ?? DEFAULT_MODEL.claude, effort: d?.effort ?? DEFAULT_EFFORT.claude, versions: [], current: 0 }
  }
  openDesign()
  drawDesign()
}
/** Etapa 3: pede o plano avançado à conversa principal, no modo Plano com Checklist e no modelo do campo */
async function startArchPlan(conceptFile?: string) {
  const a = arch.value
  if (a) a.phase = 'plan'
  setMode('checklist')
  const req = archPlanRequest(conceptPath(conceptFile))
  await dispatch({ id: crypto.randomUUID(), body: req.visible, hidden: req.hidden, attachments: [] })
}

// ---------- painel de design: à parte da conversa, com a sua própria IA ----------
let designText = ''
let designNote = ''
let designLiveTimer: ReturnType<typeof setTimeout> | undefined
/** Abre (ou traz para a frente) a janela de design desta conversa; o estado é publicado para ela */
function openDesign() {
  if (!arch.value?.design) return
  designOpen.value = true
  pushDesign()
  api.designOpen(uid).catch((e) => (attachError.value = clean(e)))
}
offs.push(api.onDesignClosed((u) => u === uid && (designOpen.value = false)))
/** O que a janela de design mostra: o conceito, as versões e a rodada em andamento */
const designActs = ref<string[]>([])
let designTarget = ''
let designFiles: AgentAttachment[] = []
function pushDesign() {
  const a = arch.value
  if (!a?.design || !info.value) return
  const st: DesignWindowState = {
    title: chatTitle.value || info.value.title || '',
    project: info.value.project,
    request: turns.find((t) => t.arch)?.user ?? '',
    design: a.design,
    running: designRunning.value,
    live: designLive.value,
    activity: designActs.value,
    note: designNote,
    target: designTarget,
    attachments: designFiles,
    error: designError.value
  }
  api.designPush(uid, JSON.parse(JSON.stringify(st)))
}
let pushTimer: ReturnType<typeof setTimeout> | undefined
watch(
  [() => arch.value?.design, designRunning, designLive, designActs, designError, chatTitle],
  () => {
    clearTimeout(pushTimer)
    pushTimer = setTimeout(pushDesign, 120)
  },
  { deep: true }
)
/** Pedidos da janela de design: revisar, aprovar, pular, trocar de versão, trocar a IA */
function onDesignAct(a: DesignAction) {
  const d = arch.value?.design
  if (!d) return
  if (a.type === 'revise') drawDesign(a.note, a.target, a.attachments)
  else if (a.type === 'retry') drawDesign(designNote, undefined, designFiles)
  else if (a.type === 'approve') approveDesign()
  else if (a.type === 'skip') skipDesign()
  else if (a.type === 'cancel') api.designCancel(uid)
  else if (a.type === 'select') d.current = Math.max(0, Math.min(d.versions.length - 1, a.index))
  else if (a.type === 'ai') setDesignAi(a.provider, a.model, a.effort as AgentEffort)
}
offs.push(api.onDesignAct((u, a) => u === uid && onDesignAct(a)))
/** Pede uma versão do conceito: a primeira parte do resumo aprovado; as revisões levam o HTML atual e o ajuste */
async function drawDesign(note = '', target?: { label: string; ref: string }, files?: AgentAttachment[]) {
  const a = arch.value
  const d = a?.design
  if (!a || !d || designRunning.value) return
  const request = turns.find((t) => t.arch)?.user ?? ''
  const cur = d.versions[d.current]
  designText = ''
  designNote = note
  designTarget = target?.label ?? ''
  // a primeira versão leva o que foi anexado ao pedido original da conversa (capturas, referências de layout)
  const first = turns.find((t) => t.arch)
  designFiles = (files ?? (note ? [] : (first?.attachments ?? []))).map(({ name, path, mime, size, kind }) => ({ name, path, mime, size, kind }))
  designActs.value = []
  designLive.value = ''
  designActivity.value = ''
  designError.value = null
  designRunning.value = true
  try {
    await api.designRun(uid, {
      provider: d.provider,
      model: d.model,
      effort: d.effort as AgentEffort,
      attachments: designFiles,
      prompt: designRequest({ request, brief: a.brief ?? '', currentHtml: note && cur ? cur.html : undefined, note: target ? `Sobre o elemento ${target.ref}: ${note}` : note, history: d.versions.slice(0, d.current + 1).map((v) => v.note) })
    })
  } catch (e) {
    designRunning.value = false
    designError.value = clean(e)
  }
}
function onDesignEvent(ev: AgentChatEvent) {
  const d = arch.value?.design
  if (!d || !designRunning.value) return
  if (ev.type === 'text') {
    designText += ev.delta
    // a prévia acompanha, sem redesenhar a cada pedaço
    if (!designLiveTimer) designLiveTimer = setTimeout(() => ((designLiveTimer = undefined), (designLive.value = extractHtml(designText))), 700)
  } else if (ev.type === 'tool') {
    designActivity.value = nowLabel(ev)
    // a janela de design mostra o que foi feito no caminho, linha a linha
    if (designActs.value[designActs.value.length - 1] !== designActivity.value) designActs.value = [...designActs.value, designActivity.value].slice(-12)
  } else if (ev.type === 'done') {
    clearTimeout(designLiveTimer)
    designLiveTimer = undefined
    designRunning.value = false
    designActivity.value = ''
    // o que fica guardado (e vai para o arquivo do conceito) sai sem nada que execute
    const html = cleanDesignHtml(extractHtml(designText))
    if (ev.ok && html) {
      d.versions.push({ html, note: designNote, at: Date.now(), target: designTarget || undefined, attachments: designFiles.length ? designFiles : undefined, summary: extractSummary(designText) || undefined, activity: designActs.value.length ? designActs.value : undefined })
      d.current = d.versions.length - 1
    } else designError.value = ev.ok ? 'A resposta veio sem o HTML do conceito.' : (ev.error ?? 'Falhou.')
    designLive.value = ''
    // as versões ficam no estado do arquiteto, dentro da vez da descoberta: a gravação da conversa já as leva
  }
}
offs.push(api.onDesignEvent((u, ev) => u === uid && onDesignEvent(ev)))
function setDesignAi(p: CliProvider, m: string, e: AgentEffort) {
  const d = arch.value?.design
  if (d) Object.assign(d, { provider: p, model: m, effort: e })
}
/** Conceito aprovado: salva o HTML em tmp/ do projeto e pede o plano avançado à conversa, apontando para ele */
async function approveDesign() {
  const d = arch.value?.design
  const v = d?.versions[d.current]
  if (!d || !v || designRunning.value) return
  try {
    d.file = await api.designSave(uid, v.html, `conceito-${(sessionId.value ?? uid).slice(0, 8)}.html`)
  } catch (e) {
    designError.value = clean(e)
    return
  }
  d.approved = d.current
  // conceito aprovado: a janela de design fecha; o trabalho segue na conversa (o botão Design a reabre para consulta)
  api.designClose(uid).catch(() => undefined)
  await startArchPlan(d.file)
}
/** Caminho do conceito como o agente e a conversa veem: relativo à pasta do projeto, quando está dentro dela */
function conceptPath(file?: string): string | undefined {
  if (!file) return undefined
  const root = (info.value?.cwd ?? '').replace(/[\\/]+$/, '')
  return root && file.startsWith(root) ? file.slice(root.length + 1).replace(/\\/g, '/') : file
}
function skipDesign() {
  const d = arch.value?.design
  if (!d || designRunning.value) return
  d.approved = 'skipped'
  api.designClose(uid).catch(() => undefined)
  startArchPlan()
}

/** Desde quando o agente trabalha nesta vez: o início dela ou, se veio de um "agora", o da vez que ela continuou */
function workStart(t: Turn) {
  return t.workSince ?? t.startedAt
}

// ---------- ditado: o microfone grava e o texto transcrito entra no campo, para conferir antes de enviar ----------
/** O transcritor é o reconhecimento de fala do macOS: nos outros sistemas o botão não aparece */
const canDictate = window.ovseer.platform === 'darwin'
const dictation = useDictation((text) => {
  draft.value = draft.value.trim() ? `${draft.value.replace(/\s+$/, '')} ${text}` : text
  nextTick(() => {
    autosize()
    box.value?.focus()
  })
})

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
        cur.superseded = true
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
/** Interrompe a resposta atual e manda esta mensagem em seguida (a fila continua depois dela).
 * Campo vazio (sem texto, colagens nem anexos) e fila com mensagens: manda agora a última que entrou na fila. */
function sendNow() {
  if (!draft.value.trim() && !pastes.length && !pending.length && queue.length) return sendQueuedNow(queue.length - 1)
  const p = takePayload()
  if (p) sendAfter(p)
}

function stop() {
  api.agentCancel(uid)
}

// ---------- acelerar: avisa o agente, no meio da resposta, que há pressa ----------
/** Recado curto, para não pesar no consumo: entra no próximo passo do agente, sem interromper nem virar mensagem na conversa */
const HURRY = 'Aviso do usuário: temos pressa. Não recomece nem explique este aviso: conclua o que está fazendo pelo caminho mais direto, sem explorações, verificações ou leituras que não sejam essenciais, e responda de forma objetiva.'
/**
 * Codex e Antigravity não recebem mensagem no meio da resposta: o aviso interrompe a resposta atual e pede para
 * continuar de onde parou (gasta um pouco mais, porque o agente relê a conversa ao retomar).
 */
const HURRY_RESUME = 'Interrompi sua resposta porque temos pressa. Continue a tarefa de onde parou, sem recomeçar nem refazer o que já foi feito: conclua pelo caminho mais direto, sem explorações, verificações ou leituras que não sejam essenciais, e responda de forma objetiva.'
const steers = computed(() => provider.value === 'claude')
const hurryTitle = computed(() => (steers.value ? 'Acelerar: avisa o agente de que há pressa, sem interromper' : 'Acelerar: interrompe a resposta e pede ao agente que conclua pelo caminho mais direto'))
/** Vez em que o aviso já foi dado (um por vez) */
const hurried = ref<string | null>(null)
async function hurry(t: Turn) {
  if (hurried.value === t.id) return
  if (!steers.value) {
    // o aviso vira a próxima vez da conversa, sem mensagem visível; o botão dela já nasce marcado, para não interromper de novo
    const p: Payload = { id: crypto.randomUUID(), body: HURRY_RESUME, silent: true, attachments: [] }
    hurried.value = p.id
    return sendAfter(p)
  }
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
/** O repositório só troca antes da primeira mensagem: a sessão do CLI nasce presa à pasta */
const canSwitchRepo = computed(() => !!info.value && !sessionId.value && !turns.length && !queue.length && !running.value)
async function switchRepo(cwd: string) {
  if (!info.value || !canSwitchRepo.value) return
  try {
    const i = await api.agentSetCwd(uid, cwd)
    info.value = { ...info.value, cwd: i.cwd, project: i.project, branch: i.branch }
  } catch (e) {
    attachError.value = clean(e)
  }
  box.value?.focus()
}
async function pickRepo() {
  const p = await api.agentPickCwd(uid).catch(() => null)
  if (p) await switchRepo(p)
}
/** Outros repositórios do espaço de trabalho (a IA vê todos): pode mudar a qualquer momento */
async function setExtraDirs(dirs: string[]) {
  if (!info.value) return
  try {
    const i = await api.agentSetExtraDirs(uid, dirs)
    info.value = { ...info.value, extraDirs: i.extraDirs }
  } catch (e) {
    attachError.value = clean(e)
  }
}
const addDir = (p: string) => setExtraDirs([...(info.value?.extraDirs ?? []), p])
const removeDir = (p: string) => setExtraDirs((info.value?.extraDirs ?? []).filter((d) => d !== p))
async function pickExtraDir() {
  const p = await api.agentPickCwd(uid).catch(() => null)
  if (p && p !== info.value?.cwd) await addDir(p)
  box.value?.focus()
}
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
const SLASH_KEYS: Record<AgentMode, string[]> = { plan: ['plan', 'plano', 'planejar'], checklist: ['checklist', 'check', 'lista'], architect: ['arquiteto', 'architect', 'conceito'], full: ['controle', 'total', 'full', 'liberado', 'tudo'] }
const plain = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const slashClosed = ref(false)
const slashIndex = ref(0)
/** O que vem depois da barra, enquanto o texto termina num comando (no começo ou depois de um espaço ou de uma quebra de linha); null fora disso */
const SLASH_TAIL = /(^|\s)\/(\S*)$/
const slashQuery = computed(() => SLASH_TAIL.exec(draft.value)?.[2] ?? null)
const slashItems = computed<SlashCommand[]>(() => {
  if (slashQuery.value === null || slashClosed.value) return []
  const q = plain(slashQuery.value)
  return MODES.map((m) => {
    const off = isPlanMode(m.id) && mode.value === m.id
    return {
      id: m.id,
      name: SLASH_KEYS[m.id][0],
      label: m.id === 'plan' ? 'Modo Plano' : m.label,
      hint: off ? `Desativar o modo ${m.label}` : mode.value === m.id ? 'Modo em uso' : m.id === 'plan' ? 'Ativar o modo Plano: só lê e propõe, nada é alterado' : m.hint,
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
  if (isPlanMode(c.id) && mode.value === c.id) setMode(modeBeforePlan.value ?? 'full')
  else setMode(c.id)
  // só o comando sai do campo: o que já estava digitado antes dele fica
  draft.value = draft.value.replace(SLASH_TAIL, '').trimEnd()
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
/** Desde quando há mudança esperando para ser guardada: com o agente escrevendo sem parar, a espera de 400 ms
 * nunca terminava e a conversa só entrava no histórico quando a resposta acabava */
let savePendingSince = 0
const SAVE_MAX_WAIT = 2000
const plainTurns = (): AgentTurn[] => turns.map((t) => ({ ...t, attachments: t.attachments.map(({ preview: _p, ...a }) => a) }))
watch(
  [turns, sessionId],
  () => {
    clearTimeout(saveTimer)
    savePendingSince ||= Date.now()
    saveTimer = setTimeout(() => {
      savePendingSince = 0
      const plain = plainTurns() // prévias (blob:) não sobrevivem à recarga
      try {
        sessionStorage.setItem(STORE, JSON.stringify(plain))
      } catch {
        /* sem espaço: segue sem guardar */
      }
      if (sessionId.value && plain.length) api.agentSaveTranscript(uid, JSON.parse(JSON.stringify(plain))).catch(() => undefined)
    }, Math.max(0, Math.min(400, savePendingSince + SAVE_MAX_WAIT - Date.now())))
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
    // as prévias não são guardadas com a conversa: recarrega as das imagens que ainda existem
    for (const a of turns[turns.length - 1].attachments) loadPreview(a)
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
/** Rodando ferramentas: diz qual, em português ("Rodando os testes", "Lendo App.vue"); senão, a fase */
const activityLabel = (t: Turn) => {
  if (t.activity === 'tools') {
    const tools = t.blocks.filter((b): b is ToolBlock => b.kind === 'tool')
    if (tools.length) return `${groupNow(tools)}…`
  }
  return ACTIVITY[t.activity ?? 'thinking']
}

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

// ---------- gerenciador de agentes: esta janela publica um resumo e executa as ações que vêm de lá ----------
/** Desde quando a janela está na situação atual (para "esperando há 17 min", "concluído há 1 min") */
const statusSince = ref(Date.now())
/** Último sinal do agente (qualquer evento): sem nenhum há minutos, o gerenciador sugere cutucar */
const lastEventAt = ref(Date.now())
watch(running, (r) => r && (lastEventAt.value = Date.now()))
/** Comandos de verificação vistos nas ferramentas da resposta */
watch(statusKind, () => (statusSince.value = Date.now()))
/** Primeira linha de texto da última resposta, sem marcas de Markdown */
/** Resultado da última resposta: o primeiro parágrafo de verdade do último texto (pula títulos), sem Markdown */
/** Resumo da resposta para o gerenciador (ver `summaryOf`) */
function firstLine(t: Turn | undefined): string {
  const texts = (t?.blocks ?? []).flatMap((b) => (b.kind === 'text' ? [splitQuestions(b.text).text.trim()] : [])).filter(Boolean)
  return summaryOf(texts[texts.length - 1] ?? '')
}
const snapshot = computed<AgentSnapshot | null>(() => {
  if (!info.value) return null
  const last = turns[turns.length - 1] as Turn | undefined
  const lastUser = [...turns].reverse().find((t) => !t.silent && t.user.trim())?.user.trim() ?? ''
  let files: AgentSnapshot['files']
  const paths: string[] = []
  for (const b of last?.blocks ?? []) {
    if (b.kind !== 'files') continue
    files ??= { count: 0, add: 0, del: 0 }
    files.count += b.paths.length
    paths.push(...b.paths)
    for (const st of Object.values(b.stats ?? {})) if (st) (files.add += st.add), (files.del += st.del)
  }
  const ask = askModel.value ?? undefined
  const cur = current()
  const lastToolBlock = [...(cur ?? last)?.blocks ?? []].reverse().find((b): b is ToolBlock => b.kind === 'tool')
  return {
    uid,
    title: chatTitle.value || info.value.title || `Nova conversa com ${providerName.value}`,
    project: info.value.project,
    provider: provider.value,
    model: modelLabel(provider.value, model.value, catalogOf(known.value, provider.value)),
    modelId: model.value,
    effort: effort.value,
    mode: mode.value,
    status: statusKind.value,
    since: statusSince.value,
    lastUser: lastUser.length > 160 ? `${lastUser.slice(0, 157)}…` : lastUser,
    error: last?.error,
    activity: cur ? activityLabel(cur).replace(/…$/, '') : undefined,
    summary: last && !last.running ? firstLine(last) : undefined,
    files,
    paths: [...new Set(paths)].slice(0, 200),
    cwd: info.value.cwd,
    startedAt: cur ? workStart(cur) : undefined,
    lastEventAt: cur ? lastEventAt.value : undefined,
    lastTool: lastToolBlock ? (lastToolBlock.detail?.split('\n')[0] || lastToolBlock.title).slice(0, 80) : undefined,
    checks: last && !last.running ? checksOf(last.blocks, paths) : undefined,
    ask,
    checklist: checklist.value ? checklist.value.map((i) => ({ ...i })) : undefined,
    // Modo Arquiteto: o conceito visual espera aprovação na janela de design (não há cartão para o gerenciador mostrar)
    note: !ask && arch.value?.phase === 'concept' && arch.value.design?.approved === undefined && !designRunning.value ? 'Conceito visual aguardando a sua aprovação, na janela de design' : undefined,
    canPin: !!sessionId.value && turns.length > 0,
    pinned: pinned.value
  }
})
let snapTimer: ReturnType<typeof setTimeout> | undefined
watch(
  snapshot,
  (snap) => {
    clearTimeout(snapTimer)
    if (snap) snapTimer = setTimeout(() => api.agentReportSnapshot(uid, JSON.parse(JSON.stringify(snap))), 250)
  },
  { deep: true, immediate: true }
)
// ---------- retomada automática: a resposta caiu por um erro passageiro ----------
const CONTINUE = 'Continue a tarefa de onde parou, sem refazer o que já foi feito.'
let retryTimer: ReturnType<typeof setInterval> | undefined
/** O que a retomada manda: "continue" se o agente chegou a trabalhar; senão, o pedido que falhou, de novo */
let retryBase: { body: string; attachments: Shown[] } | null = null
function clearRetryTimer() {
  clearInterval(retryTimer)
  retryIn.value = null
}
function resetRetry() {
  clearRetryTimer()
  autoRetries.value = 0
  retryGaveUp.value = false
  retryBase = null
}
/** Marca a próxima tentativa; false se a falha não é do tipo que se resolve sozinha ou se as tentativas acabaram */
function scheduleRetry(t: Turn): boolean {
  // no Modo Arquiteto cada mensagem mexe na etapa da conversa: ali a retomada fica com o usuário
  if (!canAutoRetry(t.error) || mode.value === 'architect') return false
  if (autoRetries.value >= AUTO_RETRY_MAX) {
    retryGaveUp.value = true
    return false
  }
  if (t.blocks.length && sessionId.value) retryBase = { body: CONTINUE, attachments: [] }
  else if (!t.silent && t.user.trim()) retryBase = { body: t.user, attachments: t.attachments }
  else if (!retryBase && sessionId.value) retryBase = { body: CONTINUE, attachments: [] }
  if (!retryBase) return false
  clearInterval(retryTimer)
  retryIn.value = AUTO_RETRY_DELAYS[Math.min(autoRetries.value, AUTO_RETRY_DELAYS.length - 1)]
  autoRetries.value++
  retryTimer = setInterval(() => {
    if (retryIn.value !== null && --retryIn.value <= 0) retryNow()
  }, 1000)
  return true
}
/** Faz já a tentativa marcada; a mensagem vai sem aparecer na conversa e o contador de tempo segue do trabalho que caiu */
function retryNow() {
  const last = turns[turns.length - 1]
  if (retryIn.value === null || !retryBase || !last || running.value) return clearRetryTimer()
  clearRetryTimer()
  dispatch({ id: crypto.randomUUID(), ...retryBase, silent: true, auto: true }, workStart(last))
}
onUnmounted(() => clearInterval(retryTimer))

/** Falhou: se o agente chegou a trabalhar, pede para continuar de onde parou; senão, manda o pedido de novo */
async function retryLast() {
  const last = turns[turns.length - 1]
  if (!last || running.value) return
  if (last.blocks.length || !last.user.trim()) await continueAfter()
  else await resend(last)
}
/** Pede ao agente para continuar a tarefa interrompida (a sessão lembra o que já foi feito) */
async function continueAfter() {
  if (running.value) return
  await dispatch({ id: crypto.randomUUID(), body: CONTINUE, attachments: [] })
}
/** Manda de novo o pedido da vez que falhou, com os mesmos anexos */
async function resend(t: Turn) {
  if (running.value || !t.user.trim()) return
  await dispatch({ id: crypto.randomUUID(), body: t.user, attachments: t.attachments as Shown[] })
}

/** Vez que falhou: diz onde parou e o que ficou alterado, em vez de só a mensagem de erro */
function stopInfo(t: Turn) {
  const interrupted = !t.error || /interromp/i.test(t.error)
  const after = took(t.durationMs)
  const title = `${interrupted ? 'Interrompido' : 'Falhou'}${after ? ` após ${after}` : ''}`
  const tool = [...t.blocks].reverse().find((b): b is ToolBlock => b.kind === 'tool')
  const cmd = tool ? (tool.detail?.split('\n')[0] ?? '').trim() : ''
  const where = tool
    ? `Parou em: ${tool.title}${cmd ? ` ${cmd.length > 90 ? `${cmd.slice(0, 87)}…` : cmd}` : ''}.`
    : t.blocks.some((b) => b.kind === 'text')
      ? 'Parou enquanto escrevia a resposta.'
      : 'Parou antes de começar a trabalhar.'
  const n = new Set(t.blocks.flatMap((b) => (b.kind === 'files' ? b.paths : []))).size
  const changed = n ? `${n} ${n === 1 ? 'arquivo foi alterado' : 'arquivos foram alterados'} até ali.` : 'Nenhum arquivo foi alterado.'
  // a mensagem técnica só aparece quando diz algo além de "interrompido"
  const detail = t.error && !/^(Interrompido\.?|A resposta foi interrompida antes de terminar\.)$/i.test(t.error.trim()) ? t.error : ''
  return { title, text: `${where} ${changed}`, detail, worked: t.blocks.length > 0 }
}
function onAct(a: AgentAction) {
  if (a.type === 'decide') decide(a.choice)
  else if (a.type === 'plan') startPlan(a.mode)
  else if (a.type === 'dismiss') askOpen.value = false
  else if (a.type === 'nav') qi.value = Math.max(0, Math.min(questions.value.length - 1, a.index))
  else if (a.type === 'retry') retryLast()
  else if (a.type === 'pin') togglePin()
  else if (a.type === 'nudge') {
    const cur = current()
    if (cur) hurry(cur)
  }
  else if (a.type === 'reply') {
    const text = a.text.trim()
    // reativo desde já: a prévia da imagem chega depois (loadPreview) e precisa aparecer no balão
    const attachments: Shown[] = reactive((a.attachments ?? []).map((x) => ({ ...x })))
    if (!text && !attachments.length) return
    if (a.model !== undefined) model.value = a.model
    if (a.effort) effort.value = a.effort
    if (a.mode) setMode(a.mode)
    // com anexos é sempre uma mensagem nova (as respostas a perguntas e ao plano não levam arquivos)
    if (showAsk.value && !attachments.length) decide(text)
    else if (showPlanAsk.value && !attachments.length) adjustPlan(text)
    else {
      // mensagem nova, sem mexer no que estiver sendo escrito no campo desta janela
      attachments.forEach((x) => loadPreview(x))
      const body = text || (attachments.length === 1 ? 'Veja o arquivo anexado.' : 'Veja os arquivos anexados.')
      const p: Payload = { id: crypto.randomUUID(), body, attachments }
      if (running.value) queue.push(p)
      else dispatch(p)
    }
  }
}
offs.push(api.onAgentAct((u, a) => u === uid && onAct(a)))

/** Borda na cor do tema por ~2 s quando a janela é trazida para a frente pelo gerenciador: mostra qual é */
const flashing = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | undefined
offs.push(
  api.onAgentFlash((u) => {
    if (u !== uid) return
    flashing.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (flashing.value = false), 2000)
  })
)

onMounted(async () => {
  try {
    const s = await api.getSettings()
    applyTheme(s.theme)
    gridSize.value = normalizeGrid(s.agentGrid)
    applyFont(s)
  } catch {
    /* tema padrão */
  }
  offs.push(api.onAgentEvent((u, ev) => u === uid && onEvent(ev)))
  offs.push(() => clearTimeout(textTimer))
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
  // Modo Arquiteto: conversa reaberta volta no modo da etapa em que parou (o processo principal reabre tudo em
  // Controle Total, e uma mensagem na descoberta ou no plano executaria em vez de refinar)
  const a = arch.value
  if (a && !running.value) {
    if (a.phase === 'discovery' || a.phase === 'concept') mode.value = 'architect'
    else if (a.phase === 'plan') mode.value = 'checklist'
  }
  if (a?.design) api.designIsOpen(uid).then((open) => (designOpen.value = open)).catch(() => undefined)
  scrollToEnd(true)
  known.value = await api.knownModels().catch(() => null)
  box.value?.focus()
  // a primeira tarefa (e os arquivos que vieram com ela, ex.: pelo mascote) só é enviada uma vez (não numa recarga)
  if (!turns.length && i.firstFiles?.length) {
    for (const p of i.firstFiles) {
      try {
        const kept = await api.agentKeepFile(uid, p)
        pushPending({ ...kept, preview: isImage(kept.mime, kept.name) ? ((await api.agentImage(kept.path).catch(() => null)) ?? undefined) : undefined })
      } catch (e) {
        attachError.value = clean(e)
      }
    }
  }
  if ((i.firstMessage || pending.length) && !turns.length) send(i.firstMessage ?? '')
})
onUnmounted(() => offs.forEach((f) => f()))
</script>

<template>
  <div
    class="agent"
    :style="fontStyle"
    @dragenter.prevent="onDragMove"
    @dragover.prevent="onDragMove"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="bar" :class="`mode-${mode}`">
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
        <span class="sub ellipsis">
          {{ providerName }} · {{ modelLabel(provider, model, catalogOf(known, provider)) }} ·
          <RepoMenu :cwd="info.cwd" :project="info.project" :switchable="false" :extra="info.extraDirs" extensible @add="addDir" @remove="removeDir" @pick-extra="pickExtraDir" />
          <template v-if="info.branch"> · <Icon name="branch" :size="10" /> {{ info.branch }}</template>
        </span>
      </div>
      <span class="spacer" />
      <div ref="gridRoot" class="grid-menu">
        <button type="button" class="ghost icon head-btn" :class="{ on: gridOpen }" title="Posicionar a janela na tela" @click="gridOpen = !gridOpen">
          <Icon name="grid" :size="14" />
        </button>
        <div v-if="gridOpen" class="pop">
          <WindowGrid :model-value="shownGrid" :cells="gridCells" :limits="gridLimits" @update:model-value="setGridSize" @place="placeWindow" />
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
        <h2 class="ask">
          O que você quer fazer em
          <span class="ask-repo">
            <RepoMenu v-if="info" :cwd="info.cwd" :project="info.project" :switchable="canSwitchRepo" :extra="info.extraDirs" extensible big center @choose="switchRepo" @pick="pickRepo" @add="addDir" @remove="removeDir" @pick-extra="pickExtraDir" />
            <template v-else>este projeto</template>?
          </span>
        </h2>
        <p v-if="canSwitchRepo" class="faint hint-repo">Clique no repositório para trocar antes de começar, ou para juntar outros repositórios à mesma conversa.</p>
        <p v-else-if="!info?.extraDirs?.length" class="faint hint-repo">Clique no repositório para juntar outros à conversa: a IA vê e edita todos.</p>
        <p class="faint">
          O agente trabalha direto na pasta do projeto, como no app do {{ providerName }}. Enter envia; Shift+Enter quebra a linha.
        </p>
        <p v-if="info?.resumeId" class="faint resumed">Continuando uma conversa anterior; o agente lembra o que foi feito, mas a transcrição não foi encontrada.</p>
      </div>

      <article v-for="t in turns" :key="t.id" class="turn">
        <div v-if="!t.silent" class="user">
          <div class="bubble">
            <div v-if="t.attachments.length" class="atts">
              <template v-for="a in t.attachments" :key="a.path">
                <button v-if="a.preview" type="button" class="thumb" :title="`${a.name}: clique para ampliar`" @click="zoom = { src: a.preview, name: a.name }">
                  <img :src="a.preview" :alt="a.name" />
                </button>
                <span v-else class="att" :title="a.path">
                  <Icon :name="a.kind === 'image' ? 'panel' : a.kind === 'audio' ? 'mic' : 'paperclip'" :size="12" />
                  <span class="ellipsis">{{ a.name }}</span>
                </span>
              </template>
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
            <template v-if="b.kind === 'text'">
              <div class="md" @click="onMdClick" v-html="md(b.text, t.id === questionTurn && showAsk, !t.running)" />
              <!-- arquivos gerados citados na resposta (planilhas, PDFs…): cartão com Abrir, só com a vez terminada -->
              <template v-if="!t.running">
                <FileCard v-for="p in artifactsOf(b.text)" :key="p" :path="p" :cwd="info?.cwd" />
              </template>
            </template>
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
            <button type="button" class="ghost hurry" :class="{ on: hurried === t.id }" :disabled="hurried === t.id" :title="hurried === t.id ? 'O agente foi avisado de que há pressa' : hurryTitle" @click="hurry(t)">
              <Icon name="forward" :size="12" />
            </button>
          </div>
          <div v-if="t.error" class="stopped">
            <strong>{{ stopInfo(t).title }}</strong>
            <p>{{ stopInfo(t).text }}</p>
            <small v-if="stopInfo(t).detail" class="stop-detail">{{ stopInfo(t).detail }}</small>
            <template v-if="t === turns[turns.length - 1] && !running && retryIn !== null">
              <p class="stop-retry">Retomando sozinho em {{ retryIn }} s · tentativa {{ autoRetries }} de {{ AUTO_RETRY_MAX }}</p>
              <div class="stop-actions">
                <button type="button" class="small primary" @click="retryNow">Retomar agora</button>
                <button type="button" class="small" @click="clearRetryTimer">Cancelar</button>
              </div>
            </template>
            <p v-else-if="t === turns[turns.length - 1] && !running && retryGaveUp" class="stop-retry">Tentei retomar {{ AUTO_RETRY_MAX }} vezes e falhou de novo. O que deseja fazer?</p>
            <div v-if="t === turns[turns.length - 1] && !running && retryIn === null" class="stop-actions">
              <button v-if="stopInfo(t).worked && sessionId" type="button" class="small primary" @click="continueAfter">Continuar de onde parou</button>
              <button v-if="t.user.trim()" type="button" class="small" @click="resend(t)">Reenviar mensagem</button>
            </div>
          </div>
          <p v-if="!t.running && !t.superseded && t.durationMs" class="meta faint">
            <template v-if="t.durationMs">{{ took(t.durationMs) }}</template>
          </p>
          <AskCard
            v-if="t.id === questionTurn && askModel"
            :ask="askModel"
            :agent="providerName"
            :current="askModel.kind === 'question' ? askModel.current : null"
            @decide="decide"
            @plan="startPlan"
            @adjust="adjustPlan"
            @see-plan="planOpen = true"
            @close="askOpen = false"
            @nav="(i) => (qi = i)"
          />
        </div>
      </article>
      <!-- conversa concluída: uma linha verde fecha a conversa; some quando o agente volta a trabalhar -->
      <div v-if="statusKind === 'done'" class="done-mark" role="status">
        <span class="dm-line" /><span class="dm-label"><Icon name="check" :size="12" /> Concluído</span><span class="dm-line" />
      </div>
    </main>

    <!-- Modo Arquiteto: cartão da janela, encostado no campo (o mesmo desenho do cartão do checklist): a etapa atual,
         o que se espera agora, as quatro etapas em segmentos e o painel de design -->
    <section v-if="arch" class="archcard" :class="{ open: archOpen }">
      <div class="ac-head">
        <button type="button" class="ghost ac-main" :title="archOpen ? 'Recolher as etapas' : 'Mostrar as etapas'" @click="archOpen = !archOpen">
          <span class="ac-icon"><Icon name="drafting" :size="14" /></span>
          <span class="ac-title">
            <strong>{{ archNow.label }} <small>· etapa {{ archNow.n }} de 4</small></strong>
            <small class="ellipsis">{{ archHint }}</small>
          </span>
          <span class="ac-segs" aria-hidden="true"><i v-for="st in archSteps" :key="st.id" :class="[st.state, { skipped: st.skipped }]" :title="st.label" /></span>
          <Icon name="chevron" :size="12" class="ac-chev" />
        </button>
        <!-- o plano foi interrompido (ou a conversa foi reaberta nesta etapa): dá para pedir de novo -->
        <button v-if="archCanReplan" type="button" class="small primary ac-btn" @click="startArchPlan(typeof arch.design?.approved === 'number' ? arch.design.file : undefined)">Gerar o plano</button>
        <button v-if="arch.design" type="button" class="ghost ac-btn ac-design" :class="{ on: designOpen }" :title="designOpen ? 'Trazer a janela de design para a frente' : 'Abrir a janela de design'" @click="openDesign">
          <Icon name="layers" :size="13" /> Design
        </button>
      </div>
      <ol v-if="archOpen" class="ac-steps">
        <li v-for="(st, i) in archSteps" :key="st.id" :class="[st.state, { skipped: st.skipped }]">
          <span class="ac-num"><Icon v-if="st.state === 'done' && !st.skipped" name="check" :size="11" /><template v-else>{{ i + 1 }}</template></span>
          <span class="ac-text"><strong>{{ st.label }}</strong><small>{{ ARCH_ABOUT[st.id] }}</small></span>
          <small v-if="st.skipped" class="ac-state">pulado</small>
          <small v-else-if="st.state === 'now'" class="ac-state now">agora</small>
        </li>
      </ol>
    </section>

    <!-- Plano com Checklist: faixa fixa da janela, encostada no campo; some quando a conversa não tem checklist -->
    <section v-if="checklist" class="checklist" :class="{ complete: checklistDone === checklist.length, collapsed: !checklistOpen, live: checklistTurn?.running, halted: checklistStopped }">
      <span class="cl-progress"><i :style="{ width: `${(checklistDone / checklist.length) * 100}%` }" /></span>
      <button type="button" class="ghost cl-head" :title="checklistOpen ? 'Recolher o checklist' : 'Mostrar o checklist'" @click="checklistOpen = !checklistOpen">
        <span class="cl-icon"><Icon :name="checklistDone === checklist.length ? 'check' : checklistStopped ? 'alert' : 'listChecks'" :size="14" /></span>
        <span class="cl-title">
          <strong>Checklist do plano</strong>
          <small>{{
            checklistDone === checklist.length
              ? 'Todas as etapas encerradas'
              : checklistStopped
                ? `O agente parou com ${checklistPending} ${checklistPending === 1 ? 'etapa em aberto' : 'etapas em aberto'}`
                : checklistNext >= 0 && !checklistOpen
                  ? checklist[checklistNext].text
                  : `${checklistDone} de ${checklist.length} etapas`
          }}</small>
        </span>
        <span class="cl-segs" aria-hidden="true"><i v-for="(it, n) in checklist" :key="n" :class="{ done: it.done && !it.state, skipped: it.state === 'skipped', failed: it.state === 'failed', next: n === checklistNext && running }" /></span>
        <span class="cl-pct">{{ Math.round((checklistDone / checklist.length) * 100) }}%</span>
        <Icon name="chevron" :size="12" class="cl-chev" />
      </button>
      <ol v-if="checklistOpen">
        <li v-for="(it, n) in checklist" :key="n" :class="{ done: it.done && !it.state, skipped: it.state === 'skipped', failed: it.state === 'failed', next: n === checklistNext && running }">
          <span class="cl-num"><Icon v-if="it.done && !it.state" name="check" :size="11" /><Icon v-else-if="it.state === 'skipped'" name="forward" :size="10" /><Icon v-else-if="it.state === 'failed'" name="x" :size="11" /><template v-else>{{ n + 1 }}</template></span>
          <span class="cl-text">
            {{ it.text }}
            <small v-if="it.note" class="cl-note">{{ it.note }}</small>
          </span>
          <small v-if="n === checklistNext && running" class="cl-state">em andamento</small>
          <small v-else-if="it.state === 'skipped'" class="cl-state muted">dispensada</small>
          <small v-else-if="it.state === 'failed'" class="cl-state bad">falhou</small>
          <small v-else-if="!it.done && !running" class="cl-state open">em aberto</small>
          <!-- com o agente parado, você encerra a etapa por conta própria, ou reabre uma já encerrada -->
          <span v-if="!running" class="cl-acts">
            <template v-if="!it.done">
              <button type="button" class="ghost icon" title="Marcar como feita (você fez por fora, ou já estava pronta)" @click="resolveItem(it, 'done')"><Icon name="check" :size="12" /></button>
              <button type="button" class="ghost icon" title="Dispensar: esta etapa não é mais necessária" @click="resolveItem(it, 'skipped')"><Icon name="forward" :size="12" /></button>
            </template>
            <button v-else type="button" class="ghost icon" title="Reabrir esta etapa" @click="reopenItem(it)"><Icon name="undo" :size="12" /></button>
          </span>
        </li>
      </ol>
      <!-- o agente parou com etapas em aberto: o que aconteceu e o que dá para fazer -->
      <div v-if="checklistOpen && checklistStopped" class="cl-foot">
        <span>O agente encerrou a resposta sem concluir {{ checklistPending === 1 ? 'esta etapa' : 'estas etapas' }}. Peça para continuar, ou encerre você mesmo cada uma (feita ou dispensada).</span>
        <button type="button" class="small primary" @click="continueChecklist"><Icon name="play" :size="11" /> Continuar o checklist</button>
      </div>
    </section>
    <footer class="composer" :class="{ drop: dragging }">
      <div v-if="slashItems.length" class="slash">
        <button v-for="(c, i) in slashItems" :key="c.id" type="button" class="ghost slash-opt" :class="{ cur: i === slashIndex }" @mousedown.prevent @mouseenter="slashIndex = i" @click="runSlash(c)">
          <Icon :name="c.icon" :size="13" />
          <strong>{{ c.label }}</strong>
          <small class="ellipsis">{{ c.hint }}</small>
          <kbd>/{{ c.name }}</kbd>
        </button>
      </div>
      <!-- a fila fica em cima: os anexos da mensagem nova ficam junto do texto dela -->
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
      <div v-if="dragging" class="drop-hint"><Icon name="paperclip" :size="16" /> Solte para anexar</div>
      <div v-if="pending.length" class="pending">
        <template v-for="(a, i) in pending" :key="a.path">
          <span v-if="a.preview" class="thumb" :title="`${a.name}${a.size ? ` · ${sizeOf(a.size)}` : ''}: clique para ampliar`" @click="zoom = { src: a.preview, name: a.name }">
            <img :src="a.preview" :alt="a.name" />
            <button type="button" class="thumb-rm" title="Remover" @click.stop="removePending(i)"><Icon name="x" :size="11" /></button>
          </span>
          <span v-else class="att" :title="`${a.path}${a.size ? ` · ${sizeOf(a.size)}` : ''}`">
            <Icon :name="a.kind === 'image' ? 'panel' : a.kind === 'audio' ? 'mic' : 'paperclip'" :size="12" />
            <span class="ellipsis">{{ a.name }}</span>
            <button type="button" class="ghost rm" title="Remover" @click="removePending(i)"><Icon name="x" :size="11" /></button>
          </span>
        </template>
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
      <p v-if="dictation.error.value" class="att-err">{{ dictation.error.value }}</p>
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
          <!-- só o ícone: o nome do modo fica na dica e no menu -->
          <button type="button" class="chip mode-chip" :class="[`m-${mode}`, { on: modeOpen }]" :title="`${currentMode.label}: ${currentMode.hint}`" :aria-label="currentMode.label" @click="modeOpen = !modeOpen">
            <Icon :name="currentMode.icon" :size="13" />
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
        <!-- ditado: um clique grava, outro transcreve para o campo -->
        <div v-if="canDictate" class="dictate" :class="dictation.phase.value">
          <template v-if="dictation.phase.value === 'recording'">
            <button type="button" class="ghost icon dict-x" title="Descartar a gravação" @click="dictation.cancel"><Icon name="x" :size="13" /></button>
            <span class="dict-time mono">{{ dictation.time.value }}</span>
          </template>
          <span v-if="dictation.phase.value === 'transcribing'" class="dict-time">Transcrevendo…</span>
          <button
            type="button"
            class="icon mic"
            :disabled="dictation.phase.value === 'transcribing'"
            :title="dictation.phase.value === 'recording' ? 'Terminar e transcrever' : dictation.phase.value === 'transcribing' ? 'Transcrevendo o áudio…' : 'Ditar: grava o microfone e escreve o texto no campo'"
            @click="dictation.toggle"
          >
            <span v-if="dictation.phase.value === 'transcribing'" class="spinner" />
            <Icon v-else :name="dictation.phase.value === 'recording' ? 'stop' : 'mic'" :size="15" />
          </button>
        </div>
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
    <!-- destaque de "esta é a janela": borda na cor do tema, some sozinha -->
    <Transition name="flash"><div v-if="flashing" class="flash-ring" aria-hidden="true" /></Transition>
    <!-- imagem anexada em tamanho maior: clique fora ou Esc fecha; o botão (ou ⌘C/Ctrl+C) copia a imagem -->
    <div v-if="zoom" class="zoom" @click="zoom = null">
      <img ref="zoomImg" :src="zoom.src" :alt="zoom.name" @click.stop />
      <button type="button" class="zoom-copy" :class="zoomCopied ?? ''" title="Copiar a imagem (⌘C)" @click.stop="copyZoom">
        <Icon :name="zoomCopied === 'ok' ? 'check' : 'clipboard'" :size="14" />
        {{ zoomCopied === 'ok' ? 'Copiada' : zoomCopied === 'fail' ? 'Não deu para copiar' : 'Copiar imagem' }}
      </button>
      <button type="button" class="zoom-close" title="Fechar (Esc)" @click="zoom = null"><Icon name="x" :size="16" /></button>
    </div>

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
/* cartão do Modo Arquiteto: da mesma família do cartão do checklist, encostado no campo */
.archcard { flex: none; margin: 0 16px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12); overflow: hidden; }
.ac-head { display: flex; align-items: center; gap: 6px; padding-right: 8px; min-width: 0; }
.ac-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 8px 0 12px; border-radius: 0; justify-content: flex-start; text-align: left; }
.ac-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); flex: none; }
.ac-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; line-height: 1.2; }
.ac-title strong { font-size: 12.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ac-title strong small { font-weight: 400; color: var(--faint); font-size: 11.5px; }
.ac-title > small { font-size: 11.5px; color: var(--muted); }
/* as quatro etapas em segmentos: feitas, a atual (pulsando) e as por vir */
.ac-segs { display: inline-flex; gap: 3px; flex: none; }
.ac-segs i { width: 18px; height: 5px; border-radius: 3px; background: var(--panel-2); }
.ac-segs i.done { background: var(--add); }
.ac-segs i.now { background: var(--accent); }
.ac-segs i.skipped { background: color-mix(in srgb, var(--faint) 45%, var(--panel-2)); }
.ac-chev { color: var(--faint); transform: rotate(-90deg); transition: transform 0.15s; flex: none; }
.archcard.open .ac-chev { transform: rotate(90deg); }
.ac-btn { height: 28px; flex: none; }
.ac-design { padding: 0 10px; gap: 6px; border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--muted); border: 1px solid var(--border); }
.ac-design:hover { color: var(--text); }
.ac-design.on { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.ac-steps { list-style: none; margin: 0; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 1px; border-top: 1px solid var(--border); }
.ac-steps li { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 4px 8px; border-radius: 8px; }
.ac-steps li.now { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.ac-num { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; flex: none; box-sizing: border-box; font-family: var(--mono); font-size: 10.5px; font-weight: 600; color: var(--muted); border: 1.5px solid var(--border); }
.ac-steps li.done .ac-num { background: var(--add); border-color: var(--add); color: var(--bg); }
.ac-steps li.now .ac-num { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.ac-steps li.skipped .ac-num { border-style: dashed; background: transparent; color: var(--faint); }
.ac-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.ac-text strong { font-size: 12.5px; font-weight: 600; }
.ac-text small { font-size: 11.5px; color: var(--muted); line-height: 1.35; }
.ac-steps li.done .ac-text strong, .ac-steps li.next .ac-text strong { font-weight: 500; }
.ac-steps li.next .ac-text strong { color: var(--muted); }
.ac-state { flex: none; font-size: 11px; color: var(--faint); }
.ac-state.now { color: var(--accent); font-weight: 500; }
.bar {
  height: var(--titlebar); display: flex; align-items: center; gap: 8px; padding: 0 14px; flex: none;
  border-bottom: 1px solid var(--border); background: var(--panel); -webkit-app-region: drag;
}
/* modo Plano (roxo) e Controle total (dourado): manchas suaves de luz espalhadas pelo cabeçalho, nas cores dos chips */
.bar.mode-plan, .bar.mode-checklist, .bar.mode-architect { --mode-tint: var(--hunk); }
/* o dourado aparece mais que o roxo: entra mais diluído */
.bar.mode-full { --mode-tint: color-mix(in srgb, var(--mod) 43%, transparent); }
.bar.mode-plan, .bar.mode-checklist, .bar.mode-architect, .bar.mode-full {
  background:
    radial-gradient(ellipse 38% 160% at 8% 0%, color-mix(in srgb, var(--mode-tint) 28%, transparent), transparent 70%),
    radial-gradient(ellipse 30% 140% at 42% 110%, color-mix(in srgb, var(--mode-tint) 16%, transparent), transparent 70%),
    radial-gradient(ellipse 26% 120% at 78% -10%, color-mix(in srgb, var(--mode-tint) 10%, transparent), transparent 70%),
    var(--panel);
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
/* marca de conversa concluída, no fim da conversa */
.done-mark { flex: none; display: flex; align-items: center; gap: 10px; margin: -8px 0 2px; color: var(--add); font-size: 11.5px; font-weight: 600; animation: dm-in 0.25s ease-out; }
.dm-line { flex: 1; height: 2px; border-radius: 1px; background: color-mix(in srgb, var(--add) 60%, transparent); }
.dm-label { display: inline-flex; align-items: center; gap: 5px; flex: none; }
@keyframes dm-in { from { opacity: 0; } }
.thread { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 20px 22px 12px; display: flex; flex-direction: column; gap: 22px; }
.fatal { color: var(--del); }
.empty { margin: auto; max-width: 420px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.empty h2 { margin: 6px 0 0; font-size: 18px; font-weight: 700; }
.empty .ask { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; }
.empty .ask-repo { display: inline-flex; align-items: center; gap: 2px; }
.hint-repo { font-size: 11.5px !important; margin-top: -4px !important; }
.empty p { margin: 0; font-size: 12.5px; line-height: 1.5; }
.resumed { padding: 6px 10px; border-radius: 8px; background: var(--panel-2); }

.turn { display: flex; flex-direction: column; gap: 14px; min-width: 0; max-width: 100%; }
/* faixa do checklist: parte da janela, entre a conversa e o campo; linha de progresso no topo e etapas numeradas */
.checklist { --cl: var(--hunk); position: relative; flex: none; margin: 0 16px 10px; border-radius: 14px; border: 1px solid var(--border); background: var(--panel); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12); overflow: hidden; max-height: 42vh; display: flex; flex-direction: column; }
.checklist.complete { --cl: var(--add); }
.cl-progress { flex: none; display: block; height: 3px; background: var(--panel-2); }
.cl-progress i { display: block; height: 100%; background: var(--cl); transition: width 0.4s ease; }
.cl-head { flex: none; display: flex; align-items: center; gap: 12px; width: 100%; height: 48px; padding: 0 14px 0 12px; border-radius: 0; justify-content: flex-start; text-align: left; }
.cl-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: color-mix(in srgb, var(--cl) 16%, transparent); color: var(--cl); flex: none; }
.cl-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; line-height: 1.2; }
.cl-title strong { font-size: 12.5px; font-weight: 600; color: var(--text); }
.cl-title small { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* segmentos: um por etapa, acompanham o progresso mesmo com a lista recolhida */
.cl-segs { display: inline-flex; gap: 3px; flex: none; }
.cl-segs i { width: 14px; height: 5px; border-radius: 3px; background: var(--panel-2); }
.cl-segs i.done { background: var(--cl); }
.cl-segs i.next { background: color-mix(in srgb, var(--cl) 45%, var(--panel-2)); animation: pulse 1.4s ease-in-out infinite; }
.cl-pct { font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--cl); flex: none; min-width: 34px; text-align: right; }
.cl-chev { color: var(--faint); transform: rotate(90deg); transition: transform 0.15s; flex: none; }
.checklist.collapsed .cl-chev { transform: rotate(-90deg); }
.checklist ol { list-style: none; margin: 0; padding: 0 8px 8px; overflow: auto; display: flex; flex-direction: column; gap: 1px; border-top: 1px solid var(--border); }
.checklist li { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 4px 8px; border-radius: 8px; font-size: 13px; line-height: 1.35; color: var(--text); }
.checklist li.next { background: color-mix(in srgb, var(--cl) 8%, transparent); }
.checklist li.done .cl-text { color: var(--muted); }
.checklist li.next .cl-text { font-weight: 600; }
.cl-text { flex: 1; min-width: 0; }
.cl-num { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; flex: none; font-family: var(--mono); font-size: 10.5px; font-weight: 600; color: var(--muted); border: 1.5px solid var(--border); }
.checklist li.done .cl-num { background: var(--add); border-color: var(--add); color: var(--bg); }
.checklist li.next .cl-num { border-color: var(--cl); color: var(--cl); box-shadow: 0 0 0 3px color-mix(in srgb, var(--cl) 22%, transparent); }
.cl-state { flex: none; font-size: 11px; color: var(--cl); font-weight: 500; }
.cl-state.open { color: var(--mod); }
.cl-state.muted { color: var(--faint); }
.cl-state.bad { color: var(--del); }
/* parou com etapas em aberto: o painel fica âmbar e ganha o rodapé com a ação */
.checklist.halted { --cl: var(--mod); border-color: color-mix(in srgb, var(--mod) 40%, var(--border)); max-height: 58vh; }
.cl-note { display: block; margin-top: 1px; font-size: 11.5px; color: var(--faint); font-weight: 400; }
.checklist li.skipped .cl-text { color: var(--faint); }
.checklist li.skipped .cl-num { color: var(--faint); border-style: dashed; }
.checklist li.failed .cl-num { color: var(--del); border-color: color-mix(in srgb, var(--del) 60%, var(--border)); }
.cl-segs i.skipped { background: color-mix(in srgb, var(--faint) 55%, var(--panel-2)); }
.cl-segs i.failed { background: var(--del); }
/* ações por etapa: discretas, aparecem ao passar o mouse na linha */
.cl-acts { display: inline-flex; gap: 2px; flex: none; opacity: 0; transition: opacity 0.1s; }
.checklist li:hover .cl-acts, .cl-acts:focus-within { opacity: 1; }
.cl-acts .icon { width: 24px; height: 24px; border-radius: 6px; color: var(--muted); }
.cl-acts .icon:hover { color: var(--text); background: var(--hover); }
.cl-foot { flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--mod) 6%, transparent); font-size: 12px; line-height: 1.4; color: var(--muted); }
.cl-foot span { flex: 1; min-width: 0; }
.cl-foot .small { height: 28px; gap: 6px; flex: none; }
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
/* imagem anexada: quadro com a miniatura; clique amplia */
.thumb {
  position: relative; display: block; width: 72px; height: 72px; padding: 0; flex: none; border-radius: 12px; overflow: hidden;
  border: 1px solid var(--border); background: var(--panel-2); cursor: zoom-in;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb:hover { border-color: var(--accent); }
.bubble .thumb { width: 120px; height: 90px; }
.thumb-rm {
  position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 0;
  display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); color: #fff; cursor: pointer;
}
.thumb-rm:hover { background: rgba(0, 0, 0, 0.85); }
.flash-ring { position: fixed; inset: 0; z-index: 90; pointer-events: none; border: 5px solid var(--accent); border-radius: 10px; box-shadow: inset 0 0 24px color-mix(in srgb, var(--accent) 35%, transparent); }
.flash-enter-active { transition: opacity 0.12s ease-out; }
.flash-leave-active { transition: opacity 0.5s ease-in; }
.flash-enter-from, .flash-leave-to { opacity: 0; }
.zoom {
  position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 32px;
  background: rgba(0, 0, 0, 0.78); cursor: zoom-out; animation: zoom-in 0.12s ease-out;
  -webkit-app-region: no-drag; /* cobre o cabeçalho, que arrasta a janela */
}
.zoom img { max-width: 100%; max-height: 100%; border-radius: 8px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); cursor: default; object-fit: contain; min-height: 0; }
.zoom-close {
  position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; border: 0;
  display: grid; place-items: center; background: rgba(255, 255, 255, 0.14); color: #fff; cursor: pointer;
}
.zoom-close:hover { background: rgba(255, 255, 255, 0.26); }
.zoom-copy {
  position: absolute; top: 14px; right: 56px; height: 32px; padding: 0 14px; border-radius: 999px; border: 0;
  display: inline-flex; align-items: center; gap: 7px; background: rgba(255, 255, 255, 0.14); color: #fff;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.zoom-copy:hover { background: rgba(255, 255, 255, 0.26); }
.zoom-copy.ok { background: color-mix(in srgb, var(--add) 55%, transparent); }
.zoom-copy.fail { background: color-mix(in srgb, var(--del) 55%, transparent); }
@keyframes zoom-in { from { opacity: 0; } }
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
.stopped { display: flex; flex-direction: column; gap: 6px; max-width: 640px; padding: 12px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--del) 30%, var(--border)); background: color-mix(in srgb, var(--del) 6%, var(--panel)); }
.stopped strong { font-size: 13.5px; color: var(--del); }
.stopped p { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; user-select: text; }
.stop-detail { font-family: var(--mono); font-size: 11.5px; color: var(--faint); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.stopped p.stop-retry { color: var(--text); }
.stop-actions { display: flex; gap: 8px; margin-top: 4px; }
.stop-actions button { height: 28px; }
.meta { margin: 0; font-size: 11px; }
/* cartão de pergunta do agente */
.plan-read { max-height: min(64vh, 720px); overflow: auto; padding-right: 6px; }

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
.chip.mode-chip { width: 30px; padding: 0; justify-content: center; }
/* classes do modo com prefixo: "checklist" sem prefixo pegava os estilos do painel do checklist e desalinhava o botão */
.chip.m-full { color: var(--mod); border-color: color-mix(in srgb, var(--mod) 45%, var(--border)); }
.chip.m-plan, .chip.m-checklist, .chip.m-architect { color: var(--hunk); border-color: color-mix(in srgb, var(--hunk) 45%, var(--border)); }
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
.dictate { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.mic { width: 34px; height: 34px; border-radius: 50%; flex: none; color: var(--muted); }
.dictate.recording .mic { background: var(--del); border-color: var(--del); color: #fff; animation: mic-pulse 1.4s ease-in-out infinite; }
@keyframes mic-pulse { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--del) 25%, transparent); } }
.dict-time { font-size: 12px; color: var(--muted); }
.dictate.recording .dict-time { color: var(--del); }
.dict-x { width: 24px; height: 24px; border-radius: 50%; color: var(--faint); }
/* botão de envio dividido: a ação escolhida à esquerda, a seta abre o menu para trocar */
.send-split { position: relative; display: inline-flex; height: 34px; flex: none; border-radius: 999px; background: var(--text); color: var(--bg); }
.send-split.as-now { background: var(--accent); color: var(--on-accent); }
.send-main, .send-more { height: 100%; border: 0; background: transparent; color: inherit; }
.send-main { padding: 0 10px 0 14px; gap: 6px; font-size: 12.5px; font-weight: 600; border-radius: 999px 0 0 999px; }
.send-more { width: 28px; padding: 0 4px 0 0; border-radius: 0 999px 999px 0; border-left: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.send-main:hover:not(:disabled), .send-more:hover:not(:disabled), .send-split.on .send-more { background: color-mix(in srgb, currentColor 14%, transparent); }
.send-split .chev { transform: rotate(90deg); color: inherit; }
.send-split .pop { left: auto; right: 0; }
.queue { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px 2px; }
/* mensagem na fila: uma linha que se destaca do campo (borda e fio na cor do tema), com altura de toque */
.queued {
  display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px 0 10px; border-radius: 9px; min-width: 0;
  background: color-mix(in srgb, var(--accent) 9%, var(--panel-2)); border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  box-shadow: inset 3px 0 0 var(--accent); font-size: 12.5px; color: var(--text);
}
.q-text { flex: 1; min-width: 0; font-weight: 500; }
.queued small { font-size: 11px; flex: none; color: var(--accent); font-weight: 600; }
.q-acts { display: inline-flex; gap: 2px; flex: none; margin-right: -4px; }
.qa { width: 22px; height: 22px; padding: 0; border-radius: 6px; color: var(--faint); }
.qa:hover { color: var(--text); }
.qa.now { color: var(--accent); }
.qa.now:hover { background: var(--accent-soft) !important; }
.send.stop { background: var(--text); color: var(--bg); border-color: var(--text); }
</style>
