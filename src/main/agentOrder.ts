import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentStatus } from '../shared/types'

/** Ordem dos concluídos, por sessão e última resposta. Sobrevive à reabertura das janelas. */
interface Entry { turnId: string; rank: number }
interface Saved { next: number; items: Record<string, Entry> }

const file = () => path.join(app.getPath('userData'), 'agent-order.json')
let cache: Saved | null = null

function load(): Saved {
  if (cache) return cache
  const items: Record<string, Entry> = {}
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Saved>
    for (const [id, entry] of Object.entries(saved.items ?? {})) {
      if (entry && typeof entry.turnId === 'string' && Number.isSafeInteger(entry.rank) && entry.rank > 0) items[id] = entry
    }
  } catch {
    /* a primeira resposta concluída cria o arquivo */
  }
  cache = { next: Math.max(0, ...Object.values(items).map((x) => x.rank)), items }
  return cache
}

function save(data: Saved) {
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file())
  } catch (e) {
    console.error('Ordem dos agentes: não consegui salvar:', (e as Error).message)
  }
}

export function completedOrder(sessionId: string | null, turnId: string | undefined, status: AgentStatus): number | undefined {
  if (status !== 'done' || !sessionId || !turnId) return undefined
  const data = load()
  const previous = data.items[sessionId]
  if (previous?.turnId === turnId) return previous.rank
  const rank = ++data.next
  data.items[sessionId] = { turnId, rank }
  save(data)
  return rank
}
