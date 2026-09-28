import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentHistoryItem, AgentTurn, AgentWindowInfo } from '../shared/types'

/**
 * Histórico das conversas abertas pelo OvrGit. A sessão em si fica com o CLI (é retomada por id);
 * aqui guardamos o índice (para listar) e a transcrição como apareceu na janela (para mostrar ao reabrir).
 */

const MAX_ITEMS = 300
const dir = () => path.join(app.getPath('userData'), 'agent-history')
const indexFile = () => path.join(dir(), 'index.json')
const transcriptFile = (sessionId: string) => path.join(dir(), `${sessionId.replace(/[^\w-]/g, '_')}.json`)

let cache: AgentHistoryItem[] | null = null

function load(): AgentHistoryItem[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(indexFile(), 'utf8')) as { items?: AgentHistoryItem[] }
    cache = Array.isArray(raw.items) ? raw.items : []
  } catch {
    cache = []
  }
  return cache
}

function writeJson(file: string, data: unknown) {
  mkdirSync(dir(), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

function save(items: AgentHistoryItem[]) {
  cache = items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS)
  writeJson(indexFile(), { items: cache })
}

/** Título curto a partir do primeiro pedido. */
export function titleOf(turns: AgentTurn[]): string {
  const first = turns.find((t) => t.user.trim())?.user ?? ''
  return first.replace(/\s+/g, ' ').trim().slice(0, 90)
}

export function listHistory(cwd?: string): AgentHistoryItem[] {
  const all = load()
  if (!cwd) return [...all]
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return all.filter((i) => norm(i.cwd) === norm(cwd))
}

/** Grava a transcrição e atualiza o índice (título, modelo, quando). */
export function saveTranscript(info: AgentWindowInfo, turns: AgentTurn[]) {
  if (!info.sessionId || !turns.length) return
  const clean = turns.map((t) => ({ ...t, blocks: t.blocks.map((b) => (b.kind === 'tool' ? { ...b, open: false } : b)) }))
  writeJson(transcriptFile(info.sessionId), { sessionId: info.sessionId, turns: clean })
  const items = load()
  const i = items.findIndex((x) => x.sessionId === info.sessionId)
  const now = Date.now()
  const item: AgentHistoryItem = {
    sessionId: info.sessionId,
    provider: info.provider,
    model: info.model,
    effort: info.effort,
    mode: info.mode,
    cwd: info.cwd,
    project: info.project,
    title: info.title || titleOf(turns) || items[i]?.title || 'Conversa',
    renamed: info.renamed,
    createdAt: items[i]?.createdAt ?? now,
    updatedAt: now,
    turns: turns.length
  }
  if (i >= 0) items[i] = item
  else items.push(item)
  save(items)
}

export function findHistory(sessionId: string): AgentHistoryItem | undefined {
  return load().find((i) => i.sessionId === sessionId)
}

/** Atualiza só o título no índice (a IA deu um, ou o usuário renomeou). */
export function setHistoryTitle(sessionId: string, title: string, renamed: boolean) {
  const items = load()
  const it = items.find((i) => i.sessionId === sessionId)
  if (!it) return
  it.title = title
  it.renamed = renamed
  it.updatedAt = Date.now()
  save(items)
}

export function loadTranscript(sessionId: string): AgentTurn[] | null {
  try {
    const raw = JSON.parse(readFileSync(transcriptFile(sessionId), 'utf8')) as { turns?: AgentTurn[] }
    return Array.isArray(raw.turns) ? raw.turns : null
  } catch {
    return null
  }
}

export function forget(sessionId: string) {
  save(load().filter((i) => i.sessionId !== sessionId))
  rmSync(transcriptFile(sessionId), { force: true })
}
