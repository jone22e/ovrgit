import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSession } from '../shared/types'

/**
 * Acompanha as tarefas do Codex (app do ChatGPT / Codex CLI) pelos registros locais em ~/.codex/sessions.
 * Cada sessão é um arquivo JSONL; lemos só o que foi acrescentado. Nada sai do computador.
 *
 * Eventos usados: session_meta (pasta e linha/branch), mensagem do usuário (título),
 * event_msg/task_started e event_msg/task_complete (início/fim, duração, última mensagem do agente).
 */

interface Tracked extends AgentSession {
  file: string
  offset: number
  partial: string
}

const sessionsDir = () => process.env.OVRGIT_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions')
const STALE_MS = 30 * 60_000
const KEEP_FINISHED_MS = 3 * 60 * 60_000

const tracked = new Map<string, Tracked>()
let watcher: FSWatcher | null = null
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

function apply(s: Tracked, line: string, live: boolean) {
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
    if (t && !t.startsWith('<')) s.title = t.replace(/\s+/g, ' ').slice(0, 90)
  } else if (kind === 'event_msg/task_started') {
    s.running = true
    s.stale = false
    s.startedAt = Number(p.started_at) ? Number(p.started_at) * 1000 : Date.now()
    s.completedAt = null
  } else if (kind === 'event_msg/task_complete') {
    s.running = false
    s.completedAt = Number(p.completed_at) ? Number(p.completed_at) * 1000 : Date.now()
    s.durationMs = Number(p.duration_ms) || null
    s.lastMessage = typeof p.last_agent_message === 'string' ? p.last_agent_message.slice(0, 600) : null
    if (live && s.completedAt >= startedAt - 5000) handlers?.onFinished(publicView(s))
  }
}

function readNew(file: string, live: boolean) {
  let st
  try {
    st = statSync(file)
  } catch {
    return
  }
  let s = tracked.get(file)
  if (!s) {
    s = {
      file, offset: 0, partial: '', id: path.basename(file), source: 'codex', title: '', cwd: '', branch: null,
      running: false, stale: false, startedAt: st.birthtimeMs, completedAt: null, durationMs: null, lastMessage: null,
      updatedAt: st.mtimeMs
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
    const len = st.size - s.offset
    const buf = Buffer.alloc(Math.min(len, 32 * 1024 * 1024))
    const n = readSync(fd, buf, 0, buf.length, s.offset)
    s.offset += n
    const text = s.partial + buf.subarray(0, n).toString('utf8')
    const lines = text.split('\n')
    s.partial = lines.pop() ?? ''
    for (const l of lines) if (l.trim()) apply(s, l, live)
    s.updatedAt = st.mtimeMs
  } finally {
    closeSync(fd)
  }
}

/** Arquivos de sessão mexidos recentemente (pastas AAAA/MM/DD de hoje e de ontem). */
function recentFiles(): string[] {
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
        if (Date.now() - statSync(full).mtimeMs < 12 * 3600_000) out.push(full)
      }
    } catch {
      /* dia sem sessões */
    }
  }
  return out
}

function publicView(s: Tracked): AgentSession {
  const { file: _f, offset: _o, partial: _p, ...rest } = s
  return { ...rest }
}

export function listAgents(): AgentSession[] {
  const now = Date.now()
  const list: AgentSession[] = []
  for (const s of tracked.values()) {
    if (!s.cwd) continue
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

function onFileEvent(file: string) {
  clearTimeout(debounce.get(file))
  debounce.set(
    file,
    setTimeout(() => {
      readNew(file, true)
      emit()
    }, 250)
  )
}

export function startAgentWatch(h: AgentHandlers) {
  stopAgentWatch()
  handlers = h
  startedAt = Date.now()
  const root = sessionsDir()
  if (!existsSync(root)) return
  for (const f of recentFiles()) readNew(f, false)
  emit()
  try {
    watcher = watch(root, { recursive: true }, (_ev, name) => {
      if (name && String(name).endsWith('.jsonl')) onFileEvent(path.join(root, String(name)))
    })
  } catch {
    watcher = null
  }
  // reserva: o fs.watch pode perder eventos; a cada 5s confere os arquivos recentes
  poll = setInterval(() => {
    for (const f of recentFiles()) readNew(f, true)
    emit()
  }, 5000)
}

export function stopAgentWatch() {
  watcher?.close()
  watcher = null
  if (poll) clearInterval(poll)
  poll = null
  tracked.clear()
}
