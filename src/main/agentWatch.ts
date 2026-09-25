import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSession } from '../shared/types'

/**
 * Acompanha agentes de IA pelos registros locais que eles mesmos gravam. Nada sai do computador.
 *
 * - Codex (app do ChatGPT / Codex CLI): ~/.codex/sessions/AAAA/MM/DD/*.jsonl
 *   session_meta (pasta e linha), task_started / task_complete (início, fim, duração, última mensagem).
 * - Claude (app Claude / Claude Code): ~/.claude/projects/<projeto>/<sessão>.jsonl
 *   cada linha traz cwd e gitBranch; pedido do usuário abre a vez, resposta com stop_reason "end_turn" fecha.
 *
 * Cada sessão é um arquivo JSONL; lemos só o que foi acrescentado.
 */

interface Tracked extends AgentSession {
  file: string
  offset: number
  partial: string
  /** Título dado pelo app Claude à conversa */
  customTitle?: string
}

const sessionsDir = () => process.env.OVRGIT_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions')
const claudeDir = () => process.env.OVRGIT_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects')
/** Arquivos muito grandes: na primeira leitura, só o final (o estado atual está lá) */
const TAIL_BYTES = 4 * 1024 * 1024
const STALE_MS = 30 * 60_000
const KEEP_FINISHED_MS = 3 * 60 * 60_000

const tracked = new Map<string, Tracked>()
let watchers: FSWatcher[] = []
let poll: ReturnType<typeof setInterval> | null = null
let startedAt = 0
const debounce = new Map<string, ReturnType<typeof setTimeout>>()

export interface AgentHandlers {
  onUpdate: (list: AgentSession[]) => void
  onFinished: (s: AgentSession) => void
}
let handlers: AgentHandlers | null = null

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
    .join(' ')
    .trim()
}

/** Pedido do usuário sem o que o app injeta (arquivos anexados, imagens, links crus). */
export function cleanRequest(t: string): string {
  const m = /##\s*My request[^\n:]*:\s*([\s\S]*)$/i.exec(t)
  let x = m ? m[1] : t
  if (!m && /^\s*# Files mentioned by the user/i.test(x)) return ''
  x = x
    .replace(/<image\b[\s\S]*?<\/image>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(https?:\/\/[^\]\s]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return x.slice(0, 500)
}

/** Texto do agente sem marcação de markdown, para caber numa prévia. */
export function plainText(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// nomes das conversas dados pelo app (os mesmos da barra lateral do ChatGPT/Codex)
let names = { mtime: 0, map: new Map<string, string>() }
function threadName(id: string): string | null {
  const file = path.join(path.dirname(sessionsDir()), 'session_index.jsonl')
  try {
    const st = statSync(file)
    if (st.mtimeMs !== names.mtime) {
      const len = Math.min(st.size, 512 * 1024)
      const buf = Buffer.alloc(len)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, len, st.size - len)
      } finally {
        closeSync(fd)
      }
      const map = new Map<string, string>()
      for (const l of buf.toString('utf8').split('\n')) {
        try {
          const o = JSON.parse(l) as { id?: string; thread_name?: string }
          if (o.id && o.thread_name) map.set(o.id, o.thread_name)
        } catch {
          /* linha cortada no começo do trecho */
        }
      }
      names = { mtime: st.mtimeMs, map }
    }
  } catch {
    return null
  }
  return names.map.get(id) ?? null
}

function finished(s: Tracked, live: boolean) {
  if (live && s.completedAt && s.completedAt >= startedAt - 5000) handlers?.onFinished(publicView(s))
}

function apply(s: Tracked, line: string, live: boolean) {
  if (s.source === 'claude') return applyClaude(s, line, live)
  let o: { type?: string; payload?: Record<string, unknown> }
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  const p = o.payload ?? {}
  const kind = `${o.type}/${p.type ?? ''}`
  if (o.type === 'session_meta') {
    s.id = String(p.id ?? s.id)
    if (typeof p.cwd === 'string') s.cwd = p.cwd
    const git = p.git as { branch?: string } | undefined
    if (git?.branch) s.branch = git.branch
  } else if (o.type === 'turn_context') {
    if (typeof p.cwd === 'string') s.cwd = p.cwd
  } else if (kind === 'response_item/message' && p.role === 'user' && !s.title) {
    // primeira mensagem de verdade do usuário (ignora blocos de contexto injetados, que começam com "<")
    const t = textOf(p.content)
    if (t && !t.startsWith('<')) {
      s.request = cleanRequest(t)
      s.title = s.request.slice(0, 90)
    }
  } else if (kind === 'event_msg/task_started') {
    s.running = true
    s.stale = false
    s.startedAt = Number(p.started_at) ? Number(p.started_at) * 1000 : Date.now()
    s.completedAt = null
  } else if (kind === 'event_msg/task_complete') {
    s.running = false
    s.completedAt = Number(p.completed_at) ? Number(p.completed_at) * 1000 : Date.now()
    s.durationMs = Number(p.duration_ms) || null
    s.lastMessage = typeof p.last_agent_message === 'string' ? plainText(p.last_agent_message).slice(0, 600) : null
    finished(s, live)
  }
}

interface ClaudeLine {
  type?: string
  subtype?: string
  cwd?: string
  gitBranch?: string
  sessionId?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  customTitle?: string
  summary?: string
  message?: { role?: string; stop_reason?: string | null; content?: unknown }
}

/** Texto digitado pelo usuário (não resultado de ferramenta nem mensagem interna). */
function claudeUserText(o: ClaudeLine): string | null {
  if (o.isMeta || o.isSidechain) return null
  const c = o.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((x) => x?.type === 'tool_result') ? textOf(c) : ''
  const t = text.trim()
  return t && !t.startsWith('<') ? t : null
}

function applyClaude(s: Tracked, line: string, live: boolean) {
  let o: ClaudeLine
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (o.sessionId) s.id = o.sessionId
  if (o.cwd) s.cwd = o.cwd
  if (o.gitBranch && o.gitBranch !== 'HEAD') s.branch = o.gitBranch
  if (o.type === 'custom-title' && o.customTitle) s.customTitle = o.customTitle
  if (o.type === 'summary' && o.summary && !s.customTitle) s.customTitle = o.summary
  if (o.isSidechain) return
  const ts = o.timestamp ? Date.parse(o.timestamp) || Date.now() : Date.now()

  if (o.type === 'user') {
    const text = claudeUserText(o)
    if (text?.startsWith('[Request interrupted')) {
      // o usuário parou no meio: encerra sem avisar como "terminou"
      s.running = false
      s.completedAt = ts
      s.durationMs = ts - s.startedAt
      return
    }
    if (text) {
      s.running = true
      s.stale = false
      s.startedAt = ts
      s.completedAt = null
      s.request = cleanRequest(text)
      s.title = s.request.slice(0, 90)
    }
  } else if (o.type === 'assistant') {
    const stop = o.message?.stop_reason
    if (stop === 'end_turn') {
      if (!s.running) return // resposta curta fora de uma vez (ex.: aviso de tarefa em segundo plano)
      s.running = false
      s.completedAt = ts
      s.durationMs = ts - s.startedAt
      const txt = textOf(o.message?.content)
      s.lastMessage = txt ? plainText(txt).slice(0, 600) : s.lastMessage
      finished(s, live)
    } else if (!s.running) {
      // atividade sem pedido novo: leitura começou no meio do arquivo, ou o agente retomou sozinho
      s.running = true
      s.stale = false
      s.startedAt = ts
      s.completedAt = null
    }
  }
}

function readNew(file: string, live: boolean, source: AgentSession['source']) {
  let st
  try {
    st = statSync(file)
  } catch {
    return
  }
  let s = tracked.get(file)
  if (!s) {
    s = {
      file, offset: 0, partial: '', id: path.basename(file, '.jsonl'), source, title: '', cwd: '', branch: null,
      running: false, stale: false, startedAt: st.birthtimeMs, completedAt: null, durationMs: null, lastMessage: null,
      updatedAt: st.mtimeMs
    }
    // primeira leitura de um arquivo enorme: só o final; a primeira linha (cortada) é descartada
    if (st.size > TAIL_BYTES) {
      s.offset = st.size - TAIL_BYTES
      s.partial = '\u0000'
      // a primeira linha tem a identidade da sessão (no Codex: id, pasta e linha de trabalho)
      const first = firstLine(file)
      if (first) apply(s, first, false)
    }
    tracked.set(file, s)
  }
  if (st.size < s.offset) {
    s.offset = 0 // arquivo recriado
    s.partial = ''
  }
  if (st.size === s.offset) return
  const fd = openSync(file, 'r')
  try {
    const len = Math.min(st.size - s.offset, 32 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, s.offset)
    s.offset += n
    let text = s.partial + buf.subarray(0, n).toString('utf8')
    if (s.partial === '\u0000') text = text.slice(text.indexOf('\n') + 1)
    const lines = text.split('\n')
    s.partial = lines.pop() ?? ''
    for (const l of lines) if (l.trim()) apply(s, l, live)
    s.updatedAt = st.mtimeMs
  } finally {
    closeSync(fd)
  }
}

function firstLine(file: string): string | null {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const end = text.indexOf('\n')
    return end > 0 ? text.slice(0, end) : null
  } finally {
    closeSync(fd)
  }
}

const RECENT_MS = 12 * 3600_000

/** Sessões do Codex mexidas recentemente (pastas AAAA/MM/DD de hoje e de ontem). */
function codexFiles(): string[] {
  const root = sessionsDir()
  const out: string[] = []
  const days = [0, 1].map((d) => {
    const dt = new Date(Date.now() - d * 86400_000)
    return path.join(root, String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0'))
  })
  for (const dir of days) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        const full = path.join(dir, f)
        if (Date.now() - statSync(full).mtimeMs < RECENT_MS) out.push(full)
      }
    } catch {
      /* dia sem sessões */
    }
  }
  return out
}

/** Sessões do Claude mexidas recentemente (uma pasta por projeto, sem as subpastas de subagentes). */
function claudeFiles(): string[] {
  const root = claudeDir()
  const out: string[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return out
  }
  for (const d of dirs) {
    const dir = path.join(root, d)
    try {
      if (Date.now() - statSync(dir).mtimeMs > 7 * 86400_000) continue
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        const full = path.join(dir, f)
        if (Date.now() - statSync(full).mtimeMs < RECENT_MS) out.push(full)
      }
    } catch {
      /* sem permissão */
    }
  }
  return out
}

function scanAll(live: boolean) {
  for (const f of codexFiles()) readNew(f, live, 'codex')
  for (const f of claudeFiles()) readNew(f, live, 'claude')
}

function publicView(s: Tracked): AgentSession {
  const { file: _f, offset: _o, partial: _p, customTitle, ...rest } = s
  const title = (s.source === 'codex' ? threadName(s.id) : customTitle) || s.title
  return { ...rest, title }
}

export function listAgents(): AgentSession[] {
  const now = Date.now()
  const list: AgentSession[] = []
  for (const s of tracked.values()) {
    if (!s.cwd || (!s.title && !s.customTitle)) continue
    // sem movimento há muito tempo "trabalhando": o app provavelmente foi fechado no meio
    s.stale = s.running && now - s.updatedAt > STALE_MS
    if (s.running && !s.stale) list.push(publicView(s))
    else if (!s.running && s.completedAt && now - s.completedAt < KEEP_FINISHED_MS) list.push(publicView(s))
  }
  return list.sort((a, b) => Number(b.running) - Number(a.running) || (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))
}

function emit() {
  handlers?.onUpdate(listAgents())
}

function onFileEvent(file: string, source: AgentSession['source']) {
  clearTimeout(debounce.get(file))
  debounce.set(
    file,
    setTimeout(() => {
      readNew(file, true, source)
      emit()
    }, 250)
  )
}

function watchDir(root: string, source: AgentSession['source'], accept: (rel: string) => boolean) {
  if (!existsSync(root)) return
  try {
    watchers.push(
      watch(root, { recursive: true }, (_ev, name) => {
        const rel = name ? String(name) : ''
        if (rel.endsWith('.jsonl') && accept(rel)) onFileEvent(path.join(root, rel), source)
      })
    )
  } catch {
    /* sem watch recursivo: fica só a conferência periódica */
  }
}

export function startAgentWatch(h: AgentHandlers) {
  stopAgentWatch()
  handlers = h
  startedAt = Date.now()
  scanAll(false)
  emit()
  watchDir(sessionsDir(), 'codex', () => true)
  // Claude: só <projeto>/<sessão>.jsonl (subagentes ficam em subpastas e não contam)
  watchDir(claudeDir(), 'claude', (rel) => rel.split(/[\\/]/).length === 2)
  // reserva: o fs.watch pode perder eventos; a cada 5s confere os arquivos recentes
  poll = setInterval(() => {
    scanAll(true)
    emit()
  }, 5000)
}

export function stopAgentWatch() {
  for (const w of watchers) w.close()
  watchers = []
  if (poll) clearInterval(poll)
  poll = null
  tracked.clear()
}
