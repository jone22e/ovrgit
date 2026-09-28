import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import type { AgentAttachment, AgentChatEvent, AgentChatOpen, AgentMode, AgentSendOptions, AgentWindowInfo, CliProvider, FileRepo, FileStat, GridPlacement, GridSize, WindowBounds } from '../shared/types'
import { findBinary, needsShell, runCli } from './cli'
import { run as runGit } from './git'
import { QUESTION_FORMAT } from '../shared/questions'
import { getSettings } from './settings'
import { normalizeGrid } from '../shared/grid'
import { findHistory, historyBounds, loadTranscript, setHistoryBounds, setHistoryTitle, titleOf } from './agentHistory'
import os from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'

/**
 * Janela exclusiva de um agente de IA (Claude Code ou Codex), no estilo dos apps deles.
 *
 * Cada mensagem do usuário vira uma execução do CLI em modo não interativo, continuando a mesma
 * sessão (`--resume` / `exec resume`). A saída JSON de cada CLI é traduzida em eventos simples
 * (texto, ferramenta, arquivos, fim) e enviada à janela. Modelo e esforço podem mudar a cada mensagem.
 */

interface AgentWin {
  info: AgentWindowInfo
  win: BrowserWindow
  child: ChildProcessWithoutNullStreams | null
  /** A resposta atual já terminou (o processo pode ainda estar encerrando) */
  turnDone: boolean
  /** Resolve quando o processo atual sai */
  exited: Promise<void> | null
}

const wins = new Map<string, AgentWin>()
let setup: { icon: string; background: () => string } | null = null

export function setupAgentWindows(s: { icon: string; background: () => string }) {
  setup = s
}

const PROVIDER_NAME: Record<CliProvider, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }
const BIN: Record<CliProvider, string> = { claude: 'claude', codex: 'codex', agy: 'agy' }

function title(info: AgentWindowInfo) {
  return `${info.title ? `${info.title} · ` : ''}${PROVIDER_NAME[info.provider]} · ${info.project}`
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const r = await runCli('git', ['rev-parse', '--abbrev-ref', 'HEAD'], '', cwd, 5000)
    const b = r.stdout.trim()
    return r.code === 0 && b && b !== 'HEAD' ? b : null
  } catch {
    return null
  }
}

/** Posição guardada só vale se ainda cai numa tela ligada (monitor desconectado: volta ao padrão). */
function visibleBounds(b: WindowBounds | null): Partial<WindowBounds> {
  if (!b) return {}
  const area = screen.getDisplayMatching(b).workArea
  const inside = b.x + b.width > area.x + 40 && b.x < area.x + area.width - 40 && b.y >= area.y - 10 && b.y < area.y + area.height - 40
  return inside ? b : { width: b.width, height: b.height }
}

const MIN_WIN = { width: 420, height: 480 }

/**
 * Próxima área livre do grid para uma janela nova: percorre as células em ordem de leitura e devolve a primeira
 * onde cabe uma janela do tamanho mínimo (células pequenas juntam vizinhas) sem esbarrar nas janelas já abertas.
 * Uma célula conta como ocupada quando uma janela cobre pelo menos um quarto dela. Sem espaço: null.
 */
export function freeGridSlot(area: WindowBounds, grid: GridSize, occupied: WindowBounds[], min = MIN_WIN): WindowBounds | null {
  const { cols, rows } = normalizeGrid(grid)
  const cw = area.width / cols
  const ch = area.height / rows
  const colSpan = Math.min(cols, Math.max(1, Math.ceil(min.width / cw)))
  const rowSpan = Math.min(rows, Math.max(1, Math.ceil(min.height / ch)))
  const covered = (cell: WindowBounds) =>
    occupied.some((w) => {
      const ox = Math.max(0, Math.min(cell.x + cell.width, w.x + w.width) - Math.max(cell.x, w.x))
      const oy = Math.max(0, Math.min(cell.y + cell.height, w.y + w.height) - Math.max(cell.y, w.y))
      return ox * oy >= cell.width * cell.height * 0.25
    })
  for (let row = 0; row + rowSpan <= rows; row++) {
    for (let col = 0; col + colSpan <= cols; col++) {
      let free = true
      for (let r = row; free && r < row + rowSpan; r++) {
        for (let c = col; free && c < col + colSpan; c++) {
          if (covered(gridBounds(area, { cols, rows, col: c, row: r, colSpan: 1, rowSpan: 1 }))) free = false
        }
      }
      if (free) return gridBounds(area, { cols, rows, col, row, colSpan, rowSpan })
    }
  }
  return null
}

/** Janelas de agente abertas e visíveis, na tela onde o ponteiro está: são as que ocupam células do grid */
function openAgentBounds(): WindowBounds[] {
  return [...wins.values()].filter((w) => !w.win.isDestroyed() && !w.win.isMinimized()).map((w) => w.win.getBounds())
}

/** Abre a janela do agente. A primeira mensagem (se houver) é enviada pela própria janela ao carregar. */
export async function openAgentWindow(opts: AgentChatOpen): Promise<AgentWindowInfo> {
  const uid = crypto.randomUUID()
  const prev = opts.resumeId ? findHistory(opts.resumeId) : undefined
  const info: AgentWindowInfo = {
    ...opts,
    uid,
    project: path.basename(opts.cwd),
    branch: await currentBranch(opts.cwd),
    sessionId: opts.resumeId ?? null,
    running: false,
    title: prev?.title ?? '',
    renamed: !!prev?.renamed
  }
  const isMac = process.platform === 'darwin'
  // conversa reaberta volta ao lugar de antes; janela nova vai para a próxima área livre do grid, na tela do ponteiro
  const saved = visibleBounds(historyBounds(opts.resumeId))
  const slot = saved.x === undefined ? freeGridSlot(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, getSettings().agentGrid, openAgentBounds()) : null
  const win = new BrowserWindow({
    width: 760,
    height: 800,
    ...(slot ?? saved),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: title(info),
    icon: setup?.icon,
    show: false,
    backgroundColor: setup?.background() ?? '#1e1e1e',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#a9a3b8', height: 48 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // bloqueia navegação para fora, mas deixa a própria página recarregar (o servidor de desenvolvimento pede
  // recarga completa quando uma atualização a quente falha; sem isso a janela ficava com código antigo)
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== win.webContents.getURL().split('#')[0]) e.preventDefault()
  })
  // o título é da janela: a página não pode trocar
  win.on('page-title-updated', (e) => e.preventDefault())
  // lembra onde a janela ficou, para a conversa reabrir no mesmo lugar
  win.on('close', () => {
    if (win.isMinimized() || win.isFullScreen()) return
    setHistoryBounds(wins.get(uid)?.info.sessionId ?? null, win.getBounds())
  })
  win.on('closed', () => {
    const w = wins.get(uid)
    if (w?.child) terminate(w.child, 'codex')
    wins.delete(uid)
    broadcastWindows()
    // cópias de imagens coladas/arrastadas desta conversa
    rmSync(blobDir(uid), { recursive: true, force: true })
  })
  wins.set(uid, { info, win, child: null, turnDone: true, exited: null })
  const load = () =>
    process.env.ELECTRON_RENDERER_URL
      ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/agent.html?uid=${uid}`)
      : win.loadFile(path.join(__dirname, '../renderer/agent.html'), { query: { uid } })
  // a janela nunca fica em branco sem reação: falha de carregamento tenta de novo; renderer que caiu recarrega
  let retries = 0
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* abortado por outra navegação */) return
    console.error(`Janela do agente não carregou (${code} ${desc}) ${url}`)
    if (retries++ < 5 && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && load().catch(() => undefined), 700)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`Renderer da janela do agente caiu (${details.reason})`)
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.webContents.reload()
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.error(`[janela do agente ${uid.slice(0, 8)}] ${message}`)
  })
  load().catch((e) => console.error('Janela do agente não carregou:', e))
  broadcastWindows()
  return info
}

export function agentInfo(uid: string): AgentWindowInfo | null {
  return wins.get(uid)?.info ?? null
}

/**
 * Área da tela correspondente a uma escolha no grid: a área útil (sem barra de menu e Dock) da tela onde a
 * janela está, dividida em colunas × linhas. Célula e extensão fora do grid são encaixadas nele.
 */
export function gridBounds(area: WindowBounds, p: GridPlacement): WindowBounds {
  const cols = Math.max(1, Math.floor(p.cols))
  const rows = Math.max(1, Math.floor(p.rows))
  const col = Math.min(cols - 1, Math.max(0, Math.floor(p.col)))
  const row = Math.min(rows - 1, Math.max(0, Math.floor(p.row)))
  const colSpan = Math.min(cols - col, Math.max(1, Math.floor(p.colSpan)))
  const rowSpan = Math.min(rows - row, Math.max(1, Math.floor(p.rowSpan)))
  const cw = area.width / cols
  const ch = area.height / rows
  // bordas arredondadas a partir das linhas do grid: células vizinhas ficam encostadas, sem fresta nem sobreposição
  const x = Math.round(area.x + col * cw)
  const y = Math.round(area.y + row * ch)
  return { x, y, width: Math.round(area.x + (col + colSpan) * cw) - x, height: Math.round(area.y + (row + rowSpan) * ch) - y }
}

/** Move e redimensiona a janela do agente para a área do grid, na tela onde ela está. */
export function placeAgentWindow(uid: string, p: GridPlacement): WindowBounds {
  const w = wins.get(uid)
  if (!w || w.win.isDestroyed()) throw new Error('Janela do agente não encontrada.')
  if (w.win.isFullScreen()) w.win.setFullScreen(false)
  if (w.win.isMaximized()) w.win.unmaximize()
  const b = gridBounds(screen.getDisplayMatching(w.win.getBounds()).workArea, p)
  w.win.setBounds(b, true)
  return w.win.getBounds()
}

export function agentWindows(): string[] {
  return [...wins.values()].map((w) => w.info.sessionId).filter((s): s is string => !!s)
}

export function focusAgentWindow(sessionId: string): boolean {
  const w = [...wins.values()].find((x) => x.info.sessionId === sessionId)
  if (!w) return false
  if (w.win.isMinimized()) w.win.restore()
  w.win.show()
  w.win.focus()
  return true
}

function broadcastWindows() {
  const ids = agentWindows()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('agents:windows', ids)
}

function emit(w: AgentWin, ev: AgentChatEvent) {
  if (!w.win.isDestroyed()) w.win.webContents.send('agent:event', w.info.uid, ev)
}

// ---------- anexos ----------

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'webm', 'aac', 'flac', 'opus'])
const MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm'
}
/** Imagens maiores que isso não vão em linha (limite da API); ficam só pelo caminho */
const INLINE_IMAGE_MAX = 4.5 * 1024 * 1024

/** Anexo a partir de um caminho: tipo pela extensão, tamanho pelo disco. */
export function describeFile(p: string): AgentAttachment {
  const ext = path.extname(p).slice(1).toLowerCase()
  const kind: AgentAttachment['kind'] = IMAGE_MIME[ext] ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : 'file'
  let size = 0
  try {
    size = statSync(p).size
  } catch {
    /* arquivo sumiu: o agente vai avisar */
  }
  return { name: path.basename(p), path: p, mime: IMAGE_MIME[ext] ?? MIME[ext] ?? '', size, kind }
}

const blobDir = (uid: string) => path.join(app.getPath('userData'), 'agent-attachments', uid)

/** Guarda um arquivo que não existe em disco (imagem colada, gravação) para o CLI conseguir ler. */
export function saveBlob(uid: string, name: string, type: string, data: Uint8Array): AgentAttachment {
  if (!wins.has(uid)) throw new Error('Janela do agente não encontrada.')
  if (data.byteLength > 50 * 1024 * 1024) throw new Error('Arquivo grande demais (máx. 50 MB).')
  const dir = blobDir(uid)
  mkdirSync(dir, { recursive: true })
  let base = name.replace(/[^\w.\-() ]+/g, '_').replace(/^\.+/, '') || 'arquivo'
  if (!path.extname(base)) {
    const ext = Object.entries(IMAGE_MIME).find(([, m]) => m === type)?.[0] ?? Object.entries(MIME).find(([, m]) => m === type)?.[0]
    if (ext) base += `.${ext}`
  }
  const file = path.join(dir, `${Date.now().toString(36)}-${base}`)
  writeFileSync(file, data)
  return describeFile(file)
}

const KIND_LABEL: Record<AgentAttachment['kind'], string> = { image: 'imagem', audio: 'áudio', file: 'arquivo' }

/**
 * Texto que descreve ao agente os anexos que não vão em linha (caminho absoluto).
 * Áudio: nenhum dos CLIs transcreve, então avisa para o agente não inventar o conteúdo.
 */
export function attachmentNote(files: AgentAttachment[]): string {
  if (!files.length) return ''
  const lines = files.map((f) => {
    const what = f.kind === 'audio' ? 'áudio; não há transcrição automática, então pergunte ao usuário o que ele diz se for relevante' : KIND_LABEL[f.kind]
    return `- ${f.path} (${what}${f.size ? `, ${Math.max(1, Math.round(f.size / 1024))} KB` : ''})`
  })
  return `\n\nArquivos anexados pelo usuário. Leia com suas ferramentas quando precisar:\n${lines.join('\n')}`
}

/** Divide os anexos entre os que vão em linha (imagens pequenas) e os que vão só pelo caminho. */
export function splitAttachments(files: AgentAttachment[]) {
  const inline: AgentAttachment[] = []
  const byPath: AgentAttachment[] = []
  for (const f of files) (f.kind === 'image' && f.size > 0 && f.size <= INLINE_IMAGE_MAX && inline.length < 10 ? inline : byPath).push(f)
  return { inline, byPath }
}

/** Mensagem no formato de entrada stream-json do Claude Code, com as imagens em base64. */
export function claudeInputMessage(text: string, images: AgentAttachment[]): string {
  const content: unknown[] = [{ type: 'text', text }]
  for (const img of images) {
    try {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: readFileSync(img.path).toString('base64') } })
    } catch {
      content.push({ type: 'text', text: `(não foi possível ler a imagem ${img.path})` })
    }
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

// ---------- argumentos dos CLIs ----------

export function claudeArgs(o: AgentSendOptions & { resume: string | null; images?: number; instructions?: string }): string[] {
  // entrada em stream-json: o pedido vai como mensagem JSON (texto + imagens) e o stdin fica aberto durante
  // a resposta, para entregar outra mensagem no meio dela sem interromper (o modelo a recebe no próximo passo)
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json']
  // instruções personalizadas do usuário e o formato de perguntas ao usuário: complementam o prompt de sistema
  args.push('--append-system-prompt', [o.instructions?.trim(), QUESTION_FORMAT].filter(Boolean).join('\n\n'))
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.mode === 'full') args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', o.mode === 'plan' ? 'plan' : 'acceptEdits')
  if (o.resume) args.push('--resume', o.resume)
  return args
}

/**
 * Modo plano no Codex: o `exec` não expõe o modo de colaboração do app, então usamos sandbox
 * somente leitura (nada muda no projeto) e a mesma orientação que o app dá ao modelo.
 */
export const CODEX_PLAN_INSTRUCTIONS = `<collaboration_mode>
# Modo Plano

Você está em Modo Plano: explore o projeto, leia arquivos e rode comandos que não alteram nada,
mas NÃO edite, crie ou apague arquivos e não execute a tarefa. Se o usuário pedir para executar,
trate como pedido para planejar a execução.

Entregue um plano detalhado e completo em decisões, pronto para outro engenheiro ou agente implementar:
objetivo, arquivos a alterar (com caminhos), passos na ordem, riscos e como validar. Responda em português do Brasil.
Não pergunte se deve implementar nem explique como sair do Modo Plano: quando o plano terminar, o próprio app
pergunta ao usuário se deseja iniciar a implementação.
</collaboration_mode>

`

export function normalizeMode(m: unknown): AgentMode {
  return m === 'full' || m === 'plan' ? m : 'safe'
}

export function codexArgs(o: AgentSendOptions & { resume: string | null; images?: string[] }): string[] {
  const args = ['exec']
  if (o.resume) args.push('resume')
  args.push('--json', '--skip-git-repo-check')
  for (const img of o.images ?? []) args.push('-i', img)
  if (o.model) args.push('-m', o.model)
  if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`)
  if (o.mode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox')
  else args.push('-c', o.mode === 'plan' ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"')
  if (o.resume) args.push(o.resume)
  args.push('-') // o pedido vai pelo stdin
  return args
}

/**
 * Antigravity (`agy`): o prompt vai colado ao próprio -p (ele não lê stdin em modo texto).
 * Modos: plan → --mode plan; safe → --mode accept-edits; full → --dangerously-skip-permissions.
 */
export function agyArgs(o: AgentSendOptions & { resume: string | null; prompt: string }): string[] {
  const args = ['--output-format', 'stream-json', `--print=${o.prompt}`]
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort === 'xhigh' || o.effort === 'ultra' ? 'max' : o.effort === 'minimal' ? 'low' : o.effort)
  if (o.mode === 'full') args.push('--dangerously-skip-permissions')
  else args.push('--mode', o.mode === 'plan' ? 'plan' : 'accept-edits')
  if (o.resume) args.push('--conversation', o.resume)
  return args
}

const safeModel = (m: string) => (/^[\w.:/-]+$/.test(m) ? m : '')

// ---------- tradução da saída do Claude Code (stream-json) ----------

export interface ClaudeParseState {
  cwd: string
  /** Texto já recebido em pedaços desde a última mensagem completa (evita duplicar) */
  streamed: number
  done: boolean
}

interface ClaudeBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

const rel = (cwd: string, p: unknown) => (typeof p === 'string' ? path.relative(cwd, p) || p : '')

/** Título curto de uma ferramenta do Claude Code, em português. */
export function describeClaudeTool(name: string, input: Record<string, unknown>, cwd: string): { title: string; detail?: string } {
  const file = rel(cwd, input.file_path ?? input.notebook_path ?? input.path)
  switch (name) {
    case 'Bash':
      return { title: 'Rodou comando', detail: String(input.command ?? '') }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { title: 'Editou', detail: file }
    case 'Write':
      return { title: 'Escreveu', detail: file }
    case 'Read':
      return { title: 'Leu', detail: file }
    case 'Grep':
    case 'Glob':
      return { title: 'Buscou', detail: String(input.pattern ?? '') }
    case 'WebFetch':
    case 'WebSearch':
      return { title: 'Consultou a web', detail: String(input.url ?? input.query ?? '') }
    case 'Agent':
    case 'Task':
      return { title: 'Subagente', detail: String(input.description ?? '') }
    case 'TodoWrite':
      return { title: 'Atualizou a lista de tarefas' }
    case 'ExitPlanMode':
      return { title: 'Plano pronto', detail: 'Ao terminar, o cartão abaixo pergunta se deseja iniciar a implementação.' }
    case 'EnterPlanMode':
      return { title: 'Entrou no modo plano' }
    default:
      return { title: name, detail: typeof input.description === 'string' ? input.description : undefined }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('')
}

/** Erros do Claude Code em linguagem simples. O "API Error" do CLI não significa uso de API key: o login é o da assinatura. */
export function friendlyClaudeError(msg: string): string {
  const m = /Claude Code ([\d.]+) does not support this model; version ([\d.]+) or newer is required/i.exec(msg)
  if (m) return `Seu Claude Code (${m[1]}) é antigo demais para este modelo: precisa do ${m[2]} ou mais novo. Rode "claude update" no terminal e tente de novo, ou escolha outro modelo.`
  if (/not_found_error|model.*not (found|exist)/i.test(msg)) return `Modelo não encontrado na sua conta. Escolha outro no seletor. (${msg.slice(0, 160)})`
  if (/auth|login|oauth|credential|unauthorized|401/i.test(msg)) return 'Sem login. Abra ⚙ Configurações e clique em "Entrar".'
  return msg.replace(/^API Error:\s*\d*\s*/i, '')
}

export function parseClaudeLine(line: string, st: ClaudeParseState): AgentChatEvent[] {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  const out: AgentChatEvent[] = []
  // mensagens internas de subagentes não entram na conversa
  if (o.parent_tool_use_id) return out
  const msg = (o.message ?? {}) as { content?: ClaudeBlock[] }
  if (o.type === 'system' && o.subtype === 'init') {
    out.push({ type: 'session', sessionId: String(o.session_id ?? ''), model: typeof o.model === 'string' ? o.model : undefined })
  } else if (o.type === 'stream_event') {
    const ev = (o.event ?? {}) as { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      st.streamed += ev.delta.text.length
      out.push({ type: 'text', delta: ev.delta.text })
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
      out.push({ type: 'thinking', delta: ev.delta.thinking })
    }
  } else if (o.type === 'assistant') {
    for (const b of msg.content ?? []) {
      if (b.type === 'text' && b.text) {
        // sem pedaços parciais (CLI antigo ou opção ignorada): entrega o texto inteiro de uma vez
        if (!st.streamed) out.push({ type: 'text', delta: b.text })
      } else if (b.type === 'tool_use' && b.id && b.name) {
        // fim do modo plano: o plano vem dentro da chamada da ferramenta, e sem alguém para aprovar ele ficaria escondido
        if (b.name === 'ExitPlanMode' && typeof b.input?.plan === 'string' && b.input.plan.trim()) {
          out.push({ type: 'text', delta: `\n\n${b.input.plan.trim()}\n\n` })
        }
        out.push({ type: 'tool', id: b.id, name: b.name, ...describeClaudeTool(b.name, b.input ?? {}, st.cwd) })
      }
    }
    st.streamed = 0
  } else if (o.type === 'user') {
    for (const b of msg.content ?? []) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        out.push({ type: 'toolResult', id: b.tool_use_id, ok: !b.is_error, output: textOf(b.content).slice(-4000) })
      }
    }
  } else if (o.type === 'result') {
    st.done = true
    const err = o.is_error ? friendlyClaudeError(String(o.result ?? o.subtype ?? 'erro')) : undefined
    out.push({
      type: 'done',
      ok: !o.is_error,
      error: err,
      durationMs: Number(o.duration_ms) || undefined,
      costUsd: Number(o.total_cost_usd) || undefined
    })
  }
  return out
}

// ---------- tradução da saída do Codex (exec --json) ----------

export interface CodexParseState {
  /** Quanto do texto de cada item já foi entregue (os itens chegam repetidos, cada vez mais completos) */
  emitted: Map<string, number>
  error: string | null
  done: boolean
}

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  changes?: { path?: string; kind?: string }[]
  message?: string
  query?: string
  server?: string
  tool?: string
}

/** Tira o invólucro do shell que o Codex põe em todo comando ("/bin/zsh -lc '…'"). */
export function cleanCommand(cmd: string): string {
  const m = /^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/.exec(cmd.trim())
  if (!m) return cmd.trim()
  let inner = m[1].trim()
  const q = inner[0]
  if ((q === "'" || q === '"') && inner.endsWith(q) && inner.length >= 2) {
    inner = inner.slice(1, -1)
    if (q === "'") inner = inner.replace(/'\\''/g, "'")
    else inner = inner.replace(/\\(["\\$`])/g, '$1')
  }
  return inner
}

export function parseCodexLine(line: string, st: CodexParseState): AgentChatEvent[] {
  let o: { type?: string; thread_id?: string; item?: CodexItem; error?: { message?: string }; message?: string }
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  const out: AgentChatEvent[] = []
  const t = o.type ?? ''
  if (t === 'thread.started' && o.thread_id) {
    out.push({ type: 'session', sessionId: o.thread_id })
  } else if (t.startsWith('item.') && o.item) {
    const it = o.item
    const id = it.id ?? `${it.type}-${st.emitted.size}`
    const completed = t === 'item.completed'
    if (it.type === 'agent_message' && typeof it.text === 'string') {
      const sent = st.emitted.get(id) ?? 0
      if (it.text.length > sent) {
        out.push({ type: 'text', delta: it.text.slice(sent) })
        st.emitted.set(id, it.text.length)
      }
      // texto entre itens: separa parágrafos
      if (completed) out.push({ type: 'text', delta: '\n\n' })
    } else if (it.type === 'reasoning') {
      out.push({ type: 'thinking', delta: typeof it.text === 'string' ? it.text : undefined })
    } else if (it.type === 'command_execution') {
      if (!st.emitted.has(id)) {
        st.emitted.set(id, 1)
        out.push({ type: 'tool', id, name: 'Bash', title: 'Rodou comando', detail: cleanCommand(it.command ?? '') })
      }
      if (completed) out.push({ type: 'toolResult', id, ok: (it.exit_code ?? 0) === 0 && it.status !== 'failed', output: (it.aggregated_output ?? '').slice(-4000) })
    } else if (it.type === 'file_change') {
      if (completed) {
        const paths = (it.changes ?? []).map((c) => c.path ?? '').filter(Boolean)
        if (paths.length) out.push({ type: 'files', paths })
      }
    } else if (it.type === 'web_search') {
      if (!st.emitted.has(id)) {
        st.emitted.set(id, 1)
        out.push({ type: 'tool', id, name: 'WebSearch', title: 'Pesquisou na web', detail: it.query ?? '' })
      }
      if (completed) out.push({ type: 'toolResult', id, ok: true })
    } else if (it.type === 'mcp_tool_call') {
      if (!st.emitted.has(id)) {
        st.emitted.set(id, 1)
        out.push({ type: 'tool', id, name: 'MCP', title: it.tool ?? 'Ferramenta', detail: it.server })
      }
      if (completed) out.push({ type: 'toolResult', id, ok: it.status !== 'failed' })
    } else if (it.type === 'error' && it.message) {
      st.error = it.message
    }
  } else if (t === 'turn.completed') {
    st.done = true
    out.push({ type: 'done', ok: !st.error, error: st.error ?? undefined })
  } else if (t === 'turn.failed' || t === 'error') {
    st.done = true
    out.push({ type: 'done', ok: false, error: o.error?.message ?? o.message ?? st.error ?? 'O Codex falhou.' })
  }
  return out
}

// ---------- tradução da saída do Antigravity (stream-json) ----------

export interface AgyParseState {
  cwd: string
  done: boolean
  /** Passos de ferramenta já anunciados (o mesmo passo chega como ACTIVE e depois DONE) */
  tools: Set<number>
}

interface AgyStep {
  conversation_id?: string
  step_index?: number
  state?: string
  step_type?: string
  text_delta?: string
  tool_name?: string
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string; error?: string }
  duration_seconds?: number
}

/** Título curto de uma ferramenta do Antigravity, em português. */
export function describeAgyTool(name: string, params: Record<string, unknown>, cwd: string): { title: string; detail?: string } {
  const file = rel(cwd, params.AbsolutePath ?? params.TargetFile ?? params.File ?? params.path)
  switch (name) {
    case 'run_command':
    case 'run_terminal_command':
      return { title: 'Rodou comando', detail: String(params.CommandLine ?? params.command ?? '') }
    case 'view_file':
    case 'read_file':
    case 'view_file_outline':
      return { title: 'Leu', detail: file }
    case 'write_to_file':
      return { title: 'Escreveu', detail: file }
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_file':
      return { title: 'Editou', detail: file }
    case 'grep_search':
    case 'find_by_name':
    case 'codebase_search':
    case 'list_dir':
      return { title: 'Buscou', detail: String(params.Query ?? params.Pattern ?? params.SearchPath ?? params.DirectoryPath ?? '') }
    case 'search_web':
    case 'read_url_content':
      return { title: 'Consultou a web', detail: String(params.query ?? params.Url ?? '') }
    default:
      return { title: name.replace(/_/g, ' ') }
  }
}

export function parseAgyLine(line: string, st: AgyParseState): AgentChatEvent[] {
  let o: { event?: string; conversation_id?: string; step_update?: AgyStep; result?: { status?: string; error?: string; duration_seconds?: number; conversation_id?: string } }
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  const out: AgentChatEvent[] = []
  if (o.event === 'init' && o.conversation_id) {
    out.push({ type: 'session', sessionId: o.conversation_id })
  } else if (o.event === 'step_update' && o.step_update) {
    const s = o.step_update
    if (s.step_type === 'agent_response') {
      if (s.text_delta) out.push({ type: 'text', delta: s.text_delta })
    } else if (s.step_type === 'tool' || s.tool_name) {
      const idx = s.step_index ?? -1
      const id = `agy-${idx}`
      const name = s.tool_name ?? s.tool_info?.name ?? 'tool'
      if (!st.tools.has(idx)) {
        st.tools.add(idx)
        out.push({ type: 'tool', id, name, ...describeAgyTool(name, s.tool_info?.parameters ?? {}, st.cwd) })
      }
      if (s.state === 'DONE' || s.state === 'ERROR') {
        out.push({ type: 'toolResult', id, ok: s.state !== 'ERROR' && !s.tool_info?.error, output: (s.tool_info?.output ?? s.tool_info?.error ?? '').replace(/\r\n/g, '\n').slice(-4000) })
      }
    } else if (/thinking|reasoning|planning/i.test(s.step_type ?? '')) {
      out.push({ type: 'thinking' })
    }
  } else if (o.event === 'result' && o.result) {
    st.done = true
    const ok = !o.result.status || /success/i.test(o.result.status)
    out.push({ type: 'done', ok, error: ok ? undefined : o.result.error ?? `Antigravity terminou com status ${o.result.status}`, durationMs: o.result.duration_seconds ? Math.round(o.result.duration_seconds * 1000) : undefined })
  } else if (o.event === 'error') {
    st.done = true
    out.push({ type: 'done', ok: false, error: String((o as { message?: string }).message ?? 'O Antigravity falhou.') })
  }
  return out
}

// ---------- execução ----------

function terminate(child: ChildProcessWithoutNullStreams, provider: CliProvider) {
  if (child.exitCode !== null) return
  // Claude: SIGINT encerra a vez e grava a sessão; Codex: SIGTERM
  child.kill(provider === 'claude' ? 'SIGINT' : 'SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 3000).unref()
}

export async function sendToAgent(uid: string, text: string, opts: AgentSendOptions, attachments: AgentAttachment[] = []): Promise<void> {
  const w = wins.get(uid)
  if (!w) throw new Error('Janela do agente não encontrada.')
  if (w.child) {
    if (!w.turnDone) throw new Error('O agente ainda está respondendo. Aguarde ou interrompa.')
    await w.exited // a resposta acabou, mas o processo ainda está saindo
  }
  if (opts.provider && opts.provider !== w.info.provider) {
    if (w.info.sessionId) throw new Error('A conversa já começou com outro provedor. Abra um agente novo para trocar.')
    w.info.provider = opts.provider
  }
  const provider = w.info.provider
  const bin = await findBinary(BIN[provider])
  if (!bin) {
    const hints: Record<CliProvider, string> = {
      claude: 'Claude Code não encontrado. Instale em claude.com/claude-code e faça login rodando "claude".',
      codex: 'Codex CLI não encontrado. Instale com "npm i -g @openai/codex" e rode "codex login".',
      agy: 'Antigravity CLI não encontrado. Instale o Antigravity (Google) e rode "agy" uma vez para fazer login.'
    }
    throw new Error(hints[provider])
  }
  const clean: AgentSendOptions & { resume: string | null } = {
    model: safeModel(opts.model ?? ''),
    effort: opts.effort,
    mode: normalizeMode(opts.mode),
    resume: w.info.sessionId
  }
  w.info.model = clean.model
  w.info.effort = clean.effort
  w.info.mode = clean.mode
  if (!w.win.isDestroyed()) w.win.setTitle(title(w.info))

  const instructions = getSettings().agentInstructions?.trim() ?? ''
  // Codex e Antigravity: as instruções do usuário e o formato de perguntas entram no primeiro pedido da sessão
  // (a sessão guarda o histórico)
  const intro =
    provider !== 'claude' && !w.info.sessionId
      ? `<custom_instructions>\n${[instructions, QUESTION_FORMAT].filter(Boolean).join('\n\n')}\n</custom_instructions>\n\n`
      : ''
  const { prompt, inlineImages } = composeMessage(provider, intro + (provider === 'codex' && clean.mode === 'plan' ? CODEX_PLAN_INSTRUCTIONS : '') + text, attachments)
  const args =
    provider === 'claude'
      ? claudeArgs({ ...clean, images: inlineImages.length, instructions })
      : provider === 'codex'
        ? codexArgs({ ...clean, images: inlineImages.map((i) => i.path) })
        : agyArgs({ ...clean, prompt })
  const input = provider === 'claude' ? claudeInputMessage(prompt, inlineImages) : provider === 'agy' ? '' : prompt
  const shellMode = needsShell(bin)
  const child = spawn(shellMode ? `"${bin}"` : bin, args, {
    cwd: w.info.cwd,
    shell: shellMode,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' }
  })
  w.child = child
  w.turnDone = false
  w.exited = new Promise((resolve) => child.on('close', () => resolve()))
  w.info.running = true
  // a nova conversa começou: não dá mais para voltar à anterior
  w.info.previousSessionId = null

  const claudeSt: ClaudeParseState = { cwd: w.info.cwd, streamed: 0, done: false }
  const codexSt: CodexParseState = { emitted: new Map(), error: null, done: false }
  const agySt: AgyParseState = { cwd: w.info.cwd, done: false, tools: new Set() }
  const parse = (line: string) =>
    provider === 'claude' ? parseClaudeLine(line, claudeSt) : provider === 'codex' ? parseCodexLine(line, codexSt) : parseAgyLine(line, agySt)
  const isDone = () => (provider === 'claude' ? claudeSt.done : provider === 'codex' ? codexSt.done : agySt.done)

  let buf = ''
  let stderr = ''
  let answer = ''
  const firstTurn = !w.info.sessionId
  const handle = (line: string) => {
    if (!line.trim()) return
    for (const ev of parse(line)) {
      if (ev.type === 'session' && ev.sessionId) {
        if (w.info.sessionId !== ev.sessionId) {
          w.info.sessionId = ev.sessionId
          broadcastWindows()
        }
      }
      if (ev.type === 'text' && answer.length < 3000) answer += ev.delta
      if (ev.type === 'done') {
        w.turnDone = true
        // Claude: o stdin ficou aberto para mensagens no meio da resposta; fechar faz o processo sair
        if (provider === 'claude') child.stdin.end()
      }
      if (ev.type === 'files') fileStats(w.info.cwd, ev.paths).then(({ stats, repos }) => emit(w, { type: 'files', paths: ev.paths, stats, repos }))
      if (ev.type === 'done' && ev.ok && firstTurn && !w.info.title && !w.info.renamed) {
        // título dado pela IA depois da primeira resposta; enquanto isso vale o pedido resumido
        w.info.title = shortTitle(text)
        if (!w.win.isDestroyed()) w.win.setTitle(title(w.info))
        emit(w, { type: 'title', title: w.info.title })
        generateTitle(provider, text, answer).then((t) => {
          if (!t || w.info.renamed || w.win.isDestroyed()) return
          w.info.title = t
          w.win.setTitle(title(w.info))
          if (w.info.sessionId) setHistoryTitle(w.info.sessionId, t, false)
          emit(w, { type: 'title', title: t })
        })
      }
      emit(w, ev)
    }
  }
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    lines.forEach(handle)
  })
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8')
    if (stderr.length > 20000) stderr = stderr.slice(-20000)
  })
  child.stdin.on('error', () => undefined)
  child.on('error', (e) => {
    w.child = null
    w.info.running = false
    emit(w, { type: 'done', ok: false, error: e.message })
  })
  child.on('close', (code, signal) => {
    if (buf.trim()) handle(buf)
    w.child = null
    w.info.running = false
    if (!isDone()) {
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ')
      let error = tail || `${PROVIDER_NAME[provider]} saiu com código ${code}`
      if (/auth|login|oauth|credential|unauthorized|401/i.test(error)) error = 'Sem login. Abra ⚙ Configurações e clique em "Entrar".'
      // interrompido por nós (terminate) ou por sinal: morto por sinal, o código de saída é nulo
      if (child.killed || signal || code === 130 || code === 143) error = 'Interrompido.'
      emit(w, { type: 'done', ok: false, error })
    }
  })
  if (provider === 'claude') child.stdin.write(input)
  else child.stdin.end(input)
}

/** Texto final do pedido e imagens em linha: imagens (Claude: blocos base64; Codex: -i), o resto pelo caminho no texto. */
function composeMessage(provider: CliProvider, text: string, attachments: AgentAttachment[]): { prompt: string; inlineImages: AgentAttachment[] } {
  const files = attachments.filter((a) => a.path && existsSync(a.path))
  const { inline, byPath } = splitAttachments(files)
  // Antigravity não tem imagem em linha: tudo vai pelo caminho
  const inlineImages = provider === 'agy' ? [] : inline
  const pathFiles = provider === 'agy' ? files : byPath
  return { prompt: text + attachmentNote(pathFiles), inlineImages }
}

/**
 * Entrega uma mensagem no meio da resposta, sem interromper: o Claude Code lê o stdin durante a vez e passa
 * a mensagem ao modelo no próximo passo (depois da ferramenta em andamento). Codex e Antigravity não têm isso.
 * false: não há resposta em andamento (ou o CLI não suporta) — o chamador manda do jeito normal.
 */
export function steerAgent(uid: string, text: string, attachments: AgentAttachment[] = []): boolean {
  const w = wins.get(uid)
  if (!w?.child || w.turnDone || w.info.provider !== 'claude' || !w.child.stdin.writable) return false
  const { prompt, inlineImages } = composeMessage('claude', text, attachments)
  w.child.stdin.write(claudeInputMessage(prompt, inlineImages))
  return true
}

/** Raiz do repositório git que contém a pasta (null: fora do git, pasta inexistente ou git ausente) */
async function gitTop(dir: string): Promise<string | null> {
  try {
    const r = await runGit(dir, ['rev-parse', '--show-toplevel'])
    return r.code === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

/**
 * Linhas acrescentadas/removidas nos arquivos que o agente alterou, em relação ao último commit (git diff --numstat).
 * Arquivos de outro repositório (fora do projeto da janela) são contados lá e vêm identificados em `repos`.
 */
export async function fileStats(cwd: string, paths: string[]): Promise<{ stats: Record<string, FileStat | null>; repos: Record<string, FileRepo> }> {
  const stats: Record<string, FileStat | null> = {}
  const repos: Record<string, FileRepo> = {}
  for (const p of paths) stats[p] = null
  // caminho real (sem links simbólicos, como /var → /private/var no macOS), igual ao que o git devolve
  const abs = (p: string) => {
    const full = path.resolve(cwd, p)
    try {
      return realpathSync.native(full)
    } catch {
      return full
    }
  }
  const home = await gitTop(cwd)
  // agrupa os arquivos pelo repositório a que pertencem (um rev-parse por pasta distinta)
  const tops = new Map<string, Promise<string | null>>()
  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const dir = path.dirname(abs(p))
    if (!tops.has(dir)) tops.set(dir, gitTop(dir))
    const top = await tops.get(dir)!
    if (!top) continue
    if (top !== home) repos[p] = { root: top, name: path.basename(top) }
    const g = groups.get(top)
    if (g) g.push(p)
    else groups.set(top, [p])
  }
  for (const [top, group] of groups) await countIn(top, abs, group, stats)
  return { stats, repos }
}

/** Preenche `stats` para os arquivos de um repositório (todos dentro de `top`). */
async function countIn(top: string, abs: (p: string) => string, paths: string[], stats: Record<string, FileStat | null>) {
  try {
    const byAbs = new Map(paths.map((p) => [abs(p), p]))
    const { stdout } = await runGit(top, ['diff', '--numstat', 'HEAD', '--', ...paths.map(abs)])
    for (const line of stdout.split('\n')) {
      const [a, d, ...rest] = line.split('\t')
      const key = byAbs.get(path.resolve(top, rest.join('\t')))
      if (key && a !== '-' && d !== '-') stats[key] = { add: Number(a) || 0, del: Number(d) || 0 }
    }
    // arquivo novo ainda não rastreado: tudo é acréscimo
    for (const [full, key] of byAbs) {
      if (stats[key] || !existsSync(full)) continue
      const tracked = (await runGit(top, ['ls-files', '--error-unmatch', '--', full])).code === 0
      if (!tracked) {
        const text = readFileSync(full, 'utf8')
        stats[key] = { add: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, del: 0 }
      }
    }
  } catch {
    // git ausente ou falha inesperada: fica sem contagem
  }
}

/** Renomeia a conversa. Vazio: volta a aceitar o título da IA (gerado na próxima resposta). */
export function setTitle(uid: string, raw: string): string {
  const w = wins.get(uid)
  if (!w) throw new Error('Janela do agente não encontrada.')
  const t = raw.replace(/\s+/g, ' ').trim()
  w.info.title = t
  w.info.renamed = !!t
  if (!w.win.isDestroyed()) w.win.setTitle(title(w.info))
  if (w.info.sessionId) setHistoryTitle(w.info.sessionId, t || titleOf(loadTranscript(w.info.sessionId) ?? []) || 'Conversa', !!t)
  return t
}

const shortTitle = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 90)

/** Pede à mesma IA um título curto para a conversa, numa chamada separada e barata (não entra na sessão). */
export async function generateTitle(provider: CliProvider, request: string, answer: string): Promise<string | null> {
  const bin = await findBinary(BIN[provider])
  if (!bin) return null
  const prompt = `Dê um título curto para a conversa abaixo: até 6 palavras, em português do Brasil, sem aspas, sem ponto final, sem explicação. Responda só o título.\n\nPedido do usuário:\n${request.slice(0, 1500)}\n\nResposta do agente (resumo):\n${answer.slice(0, 1500)}`
  try {
    let text = ''
    if (provider === 'claude') {
      const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--model', 'haiku']
      const r = await runCli(bin, args, prompt, os.tmpdir(), 60_000, undefined, { MAX_THINKING_TOKENS: '0' })
      const env = JSON.parse(r.stdout) as { is_error?: boolean; result?: string }
      if (env.is_error) return null
      text = String(env.result ?? '')
    } else if (provider === 'agy') {
      const r = await runCli(bin, ['--output-format', 'json', '--effort', 'low', '--mode', 'plan', `--print=${prompt}`], '', os.tmpdir(), 60_000)
      try {
        const env = JSON.parse(r.stdout) as { response?: string; result?: { response?: string } }
        text = String(env.response ?? env.result?.response ?? r.stdout)
      } catch {
        text = r.stdout
      }
    } else {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ovseer-title-'))
      try {
        const out = path.join(dir, 'title.txt')
        // --ephemeral: não grava sessão (senão aparece no monitor de agentes como uma conversa)
        const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort="low"', '--output-last-message', out, '-']
        await runCli(bin, args, prompt, dir, 60_000)
        text = await readFile(out, 'utf8').catch(() => '')
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    const t = text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^["'“”«]+|["'“”»]+$/g, '').replace(/[.。]$/, '').trim() ?? ''
    return t && t.length <= 80 ? t : null
  } catch {
    return null
  }
}

/** Zera a janela para uma conversa nova com o mesmo agente: encerra a resposta em curso e esquece a sessão do CLI. */
export async function newChat(uid: string) {
  const w = wins.get(uid)
  if (!w) throw new Error('Janela do agente não encontrada.')
  if (w.child) {
    terminate(w.child, w.info.provider)
    await w.exited
  }
  // a conversa anterior fica ao alcance de "voltar" enquanto a nova não recebe a primeira mensagem
  w.info.previousSessionId = w.info.sessionId
  w.info.sessionId = null
  w.info.resumeId = undefined
  w.info.firstMessage = undefined
  w.info.title = ''
  w.info.renamed = false
  w.info.running = false
  w.turnDone = true
  if (!w.win.isDestroyed()) w.win.setTitle(title(w.info))
  broadcastWindows()
}

/** Desfaz "Nova conversa": a janela volta à anterior. Só enquanto a nova ainda não começou. */
export function backToPreviousChat(uid: string): boolean {
  const w = wins.get(uid)
  if (!w) throw new Error('Janela do agente não encontrada.')
  const prevId = w.info.previousSessionId
  if (!prevId || w.info.sessionId || w.child) return false
  const prev = findHistory(prevId)
  w.info.previousSessionId = null
  w.info.sessionId = prevId
  w.info.resumeId = prevId
  w.info.title = prev?.title ?? ''
  w.info.renamed = !!prev?.renamed
  if (!w.win.isDestroyed()) w.win.setTitle(title(w.info))
  broadcastWindows()
  return true
}

export function cancelAgent(uid: string) {
  const w = wins.get(uid)
  if (w?.child) terminate(w.child, w.info.provider)
}

export function shutdownAgents() {
  for (const w of wins.values()) if (w.child) terminate(w.child, w.info.provider)
}
