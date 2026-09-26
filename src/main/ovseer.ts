import { app, safeStorage, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type {
  OvseerComment, OvseerDeliveryInput, OvseerLinkInput, OvseerMember, OvseerNewTask, OvseerStatus, OvseerTask,
  OvseerTaskDetail
} from '../shared/types'
import { getSettings } from './settings'

/**
 * Integração com o Ovseer: login (token de integração obtido pelo navegador) e vínculo de commits a tarefas.
 *
 * Login no padrão "loopback" (como gh e VS Code): o OvrGit abre um servidor local temporário em 127.0.0.1,
 * abre o navegador na página de autorização do Ovseer e recebe o token de volta nesse endereço.
 */

const tokenFile = () => path.join(app.getPath('userData'), 'ovseer-token.bin')
const baseUrl = () => getSettings().ovseerUrl.replace(/\/+$/, '')

function readToken(): string | null {
  try {
    const raw = readFileSync(tokenFile())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch {
    return null
  }
}

function writeToken(token: string) {
  // criptografado com o Keychain (Mac) / DPAPI (Windows)
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8')
  writeFileSync(tokenFile(), data, { mode: 0o600 })
}

class OvseerError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
  }
}

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const token = readToken()
  if (!token) throw new OvseerError('Conecte o OvrGit ao Ovseer nas Configurações.', 401)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`${baseUrl()}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) {
      if (res.status === 401) rmSync(tokenFile(), { force: true }) // token revogado/expirado
      throw new OvseerError(data?.error ?? `Ovseer respondeu ${res.status}`, res.status)
    }
    return data as T
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new OvseerError('O Ovseer não respondeu a tempo.', 0)
    if (e instanceof OvseerError) throw e
    throw new OvseerError(`Não foi possível falar com ${baseUrl()} (${(e as Error).message}).`, 0)
  } finally {
    clearTimeout(timer)
  }
}

export async function status(): Promise<OvseerStatus> {
  if (!readToken()) return { connected: false, url: baseUrl() }
  try {
    const me = await api<{ user: OvseerStatus['user']; workspaces: OvseerStatus['workspaces'] }>('GET', '/api/ovrgit/me')
    return { connected: true, url: baseUrl(), user: me.user, workspaces: me.workspaces }
  } catch (e) {
    const err = e as OvseerError
    return { connected: err.status !== 401 && !!readToken(), url: baseUrl(), error: err.message }
  }
}

let pending: { server: http.Server; timer: ReturnType<typeof setTimeout> } | null = null

export function cancelLogin() {
  if (!pending) return
  clearTimeout(pending.timer)
  pending.server.close()
  pending = null
}

const PAGE = (title: string, text: string) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>${title}</title><body style="font-family:system-ui;background:#1e1e1e;color:#e5e5e5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#a9a3b8">${text}</p></div></body></html>`

/** Abre o navegador para autorizar o OvrGit no Ovseer e aguarda o token (até 5 minutos). */
export function login(): Promise<OvseerStatus> {
  cancelLogin()
  const state = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const sameState = url.searchParams.get('state') === state
      if (sameState && url.searchParams.get('error') === 'denied') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE('Conexão recusada', 'Pode fechar esta aba.'))
        cancelLogin()
        reject(new Error('A conexão foi recusada no Ovseer.'))
        return
      }
      const token = url.searchParams.get('token')
      const ok = sameState && !!token && /^ovg_[A-Za-z0-9_-]{20,}$/.test(token)
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        ok
          ? PAGE('OvrGit conectado', 'Pode fechar esta aba e voltar ao OvrGit.')
          : PAGE('Não foi possível conectar', 'Tente de novo pelo OvrGit.')
      )
      if (!ok) return
      writeToken(token!)
      cancelLogin()
      status().then(resolve, reject)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const callback = `http://127.0.0.1:${port}/callback`
      const target = `${baseUrl()}/connect/ovrgit?callback=${encodeURIComponent(callback)}&state=${state}`
      shell.openExternal(target)
    })
    const timer = setTimeout(() => {
      cancelLogin()
      reject(new Error('Tempo esgotado esperando a autorização no navegador.'))
    }, 5 * 60_000)
    pending = { server, timer }
  })
}

export async function logout(): Promise<OvseerStatus> {
  try {
    await api('DELETE', '/api/ovrgit/token')
  } catch {
    /* mesmo offline, esquece o token local */
  }
  rmSync(tokenFile(), { force: true })
  return { connected: false, url: baseUrl() }
}

export async function tasks(workspaceId: string): Promise<OvseerTask[]> {
  const r = await api<{ tasks: OvseerTask[] }>('GET', `/api/ovrgit/tasks?workspaceId=${encodeURIComponent(workspaceId)}`)
  return r.tasks
}

export async function linkCommits(input: OvseerLinkInput): Promise<number> {
  if (!input.commits.length) return 0
  const r = await api<{ linked: number }>('POST', '/api/ovrgit/commits', input)
  return r.linked
}

export async function members(workspaceId: string): Promise<OvseerMember[]> {
  const r = await api<{ members: OvseerMember[] }>('GET', `/api/ovrgit/members?workspaceId=${encodeURIComponent(workspaceId)}`)
  return r.members
}

export async function createTask(input: OvseerNewTask): Promise<{ id: string; code: string }> {
  return api('POST', '/api/ovrgit/tasks', input)
}

// ---------------------------------------------------------------------------------------------
// Tempo real: canal SSE do Ovseer (/api/ovrgit/stream). Reconecta sozinho com espera crescente.
// ---------------------------------------------------------------------------------------------

let streamCtrl: AbortController | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 2000

export interface StreamHandlers {
  onChange: () => void
  onLive: (live: boolean) => void
}

export function stopStream() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  streamCtrl?.abort()
  streamCtrl = null
}

export function startStream(h: StreamHandlers) {
  stopStream()
  const token = readToken()
  if (!token) return h.onLive(false)
  const ctrl = new AbortController()
  streamCtrl = ctrl
  let debounce: ReturnType<typeof setTimeout> | null = null

  const retry = () => {
    h.onLive(false)
    if (ctrl.signal.aborted) return
    retryTimer = setTimeout(() => startStream(h), retryDelay)
    retryDelay = Math.min(retryDelay * 2, 60_000)
  }

  fetch(`${baseUrl()}/api/ovrgit/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: ctrl.signal
  })
    .then(async (res) => {
      if (res.status === 401) {
        rmSync(tokenFile(), { force: true })
        h.onLive(false)
        h.onChange() // a interface percebe que desconectou
        return
      }
      if (!res.ok || !res.body) return retry()
      retryDelay = 2000
      h.onLive(true)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          if (/^event: change$/m.test(event)) {
            // várias mudanças seguidas viram uma única atualização
            if (debounce) clearTimeout(debounce)
            debounce = setTimeout(h.onChange, 400)
          }
        }
      }
      retry()
    })
    .catch(() => {
      if (!ctrl.signal.aborted) retry()
    })
}

export interface DeliveryCommit {
  id: string
  title: string
  url: string
  repository: string | null
  occurred_at: string | null
}

export async function delivery(taskId: string): Promise<{ commits: DeliveryCommit[]; plan?: string }> {
  return api('GET', `/api/ovrgit/tasks/${encodeURIComponent(taskId)}/delivery`)
}

export async function submitDelivery(taskId: string, input: OvseerDeliveryInput): Promise<void> {
  await api('POST', `/api/ovrgit/tasks/${encodeURIComponent(taskId)}/completion`, input)
}

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/** Envia um anexo (ou o áudio de explicação, com purpose "plan_audio") para a tarefa. */
export async function uploadAttachment(
  taskId: string,
  file: { name: string; type: string; data: Uint8Array<ArrayBuffer> },
  purpose?: 'plan_audio'
): Promise<void> {
  const token = readToken()
  if (!token) throw new OvseerError('Conecte o OvrGit ao Ovseer nas Configurações.', 401)
  if (file.data.byteLength > ATTACHMENT_MAX_BYTES) throw new OvseerError(`${file.name} passa de 25 MB.`, 400)
  const form = new FormData()
  form.append('file', new Blob([file.data], { type: file.type || 'application/octet-stream' }), file.name)
  if (purpose) form.append('purpose', purpose)
  const res = await fetch(`${baseUrl()}/api/client/tasks/${encodeURIComponent(taskId)}/attachments/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const code = data?.error ?? `Ovseer respondeu ${res.status}`
    const msg =
      code === 'attachment-file-too-large'
        ? `${file.name} passa de 25 MB.`
        : code === 's3-not-configured'
          ? 'O Ovseer não está com armazenamento de arquivos configurado.'
          : code
    throw new OvseerError(msg, res.status)
  }
}

export async function taskDetail(taskId: string): Promise<OvseerTaskDetail> {
  return api('GET', `/api/ovrgit/tasks/${encodeURIComponent(taskId)}`)
}

/** Inicia, pausa ou retoma a tarefa (mesmas regras do Ovseer). */
export async function setTaskStatus(taskId: string, status: 'doing' | 'paused' | 'blocked', acknowledged: boolean) {
  await api('POST', `/api/client/tasks/${encodeURIComponent(taskId)}/status`, {
    status,
    approval_guidance_acknowledged: acknowledged
  })
}

export async function attachmentUrl(taskId: string, index: number): Promise<string> {
  const r = await api<{ url: string }>('GET', `/api/client/tasks/${encodeURIComponent(taskId)}/attachments/${index}/access-url`)
  return r.url
}

export async function approvalAudioUrl(taskId: string): Promise<string> {
  const r = await api<{ url: string }>('GET', `/api/client/tasks/${encodeURIComponent(taskId)}/plan-review/audio-access-url`)
  return r.url
}

export async function taskComments(taskId: string): Promise<OvseerComment[]> {
  const rows = await api<{ id: string; type: string; content?: string; user_name?: string; created_at?: string }[]>(
    'GET',
    `/api/client/task-activities?task_id=${encodeURIComponent(taskId)}`
  )
  return (Array.isArray(rows) ? rows : [])
    .filter((a) => a.type === 'comment' && a.content)
    .slice(0, 30)
    .map((a) => ({ id: a.id, author: a.user_name ?? 'Alguém', text: String(a.content), date: a.created_at ?? null }))
}
