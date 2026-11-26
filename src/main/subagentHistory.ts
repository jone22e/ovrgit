import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SubagentDetail, SubagentSummary, SubagentUpdate } from '../shared/subagents'

/** Somente eventos observados no CLI. As conversas dos filhos não se misturam com a resposta do principal. */
export class SubagentHistory {
  private cache = new Map<string, SubagentDetail[]>()
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private directory: () => string) {}
  private file(sessionId: string) {
    if (!/^[\w-]{1,120}$/.test(sessionId)) throw new Error('Sessão inválida.')
    return path.join(this.directory(), `${sessionId}.json`)
  }
  private load(sessionId: string): SubagentDetail[] {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    let list: SubagentDetail[] = []
    try {
      const raw = JSON.parse(readFileSync(this.file(sessionId), 'utf8'))
      if (Array.isArray(raw)) list = raw.filter((a) => a && typeof a.id === 'string' && Array.isArray(a.blocks))
      // Processos da abertura anterior não sobrevivem ao encerramento do app.
      for (const a of list) if (a.status === 'live') { a.status = 'stopped'; a.activity = undefined }
    } catch { /* sessão sem histórico de subagentes */ }
    this.cache.set(sessionId, list)
    return list
  }
  list(sessionId: string | null): SubagentSummary[] {
    return sessionId ? this.load(sessionId).map(({ blocks: _blocks, prompt: _prompt, result: _result, requests: _requests, ...summary }) => ({ ...summary })) : []
  }
  detail(sessionId: string, id: string): SubagentDetail | null {
    const node = this.load(sessionId).find((a) => a.id === id)
    return node ? structuredClone(node) : null
  }
  apply(sessionId: string, update: SubagentUpdate) {
    const list = this.load(sessionId)
    let node = list.find((a) => a.id === update.id)
    const now = Date.now()
    if (!node) {
      node = { id: update.id, provider: update.provider, name: update.name || 'Subagente', status: 'live', createdAt: now, updatedAt: now, blocks: [] }
      list.push(node)
    }
    for (const field of ['name', 'nativeId', 'parentId', 'prompt', 'result', 'status', 'activity'] as const) {
      if (field === 'name' && node.name !== 'Subagente') continue
      if (field === 'prompt' && node.prompt && update.prompt) {
        if (node.prompt !== update.prompt && node.requests?.at(-1) !== update.prompt) node.requests = [...(node.requests ?? []), update.prompt].slice(-50)
        continue
      }
      if (update[field] !== undefined) Object.assign(node, { [field]: update[field] })
    }
    const ev = update.event
    if (ev?.type === 'text') {
      const last = node.blocks.at(-1)
      if (last?.kind === 'text') last.text = (last.text + ev.delta).slice(-100_000)
      else node.blocks.push({ kind: 'text', text: ev.delta.slice(-100_000) })
      node.activity = 'Escrevendo'
    } else if (ev?.type === 'tool') {
      if (!node.blocks.some((b) => b.kind === 'tool' && b.id === ev.id)) node.blocks.push({ kind: 'tool', id: ev.id, name: ev.name, title: ev.title, detail: ev.detail, ok: null, open: false })
      node.activity = ev.title
    } else if (ev?.type === 'toolResult') {
      const tool = node.blocks.find((b) => b.kind === 'tool' && b.id === ev.id)
      if (tool?.kind === 'tool') { tool.ok = ev.ok; tool.output = ev.output }
    } else if (ev?.type === 'thinking') node.activity = 'Pensando'
    else if (ev?.type === 'done') {
      node.status = ev.ok ? 'done' : 'error'
      if (ev.error) node.blocks.push({ kind: 'text', text: ev.error })
    }
    if (node.status !== 'live') node.activity = undefined
    node.blocks = node.blocks.slice(-500)
    node.updatedAt = now
    if (!this.pending.has(sessionId)) this.pending.set(sessionId, setTimeout(() => this.flush(sessionId), 500))
  }
  interrupt(sessionId: string) {
    for (const node of this.load(sessionId)) if (node.status === 'live') this.apply(sessionId, { id: node.id, provider: node.provider, status: 'stopped' })
  }
  flush(sessionId?: string) {
    const ids = sessionId ? [sessionId] : [...this.pending.keys()]
    for (const id of ids) {
      clearTimeout(this.pending.get(id)); this.pending.delete(id)
      try {
        mkdirSync(this.directory(), { recursive: true })
        const file = this.file(id)
        writeFileSync(`${file}.tmp`, JSON.stringify(this.load(id)))
        renameSync(`${file}.tmp`, file)
      } catch (e) { console.error('Não consegui salvar os subagentes:', e) }
    }
  }
}
