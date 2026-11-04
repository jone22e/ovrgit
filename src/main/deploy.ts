import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { shell, webContents } from 'electron'
import type { Service } from '../shared/types'
import {
  parseDeployManifest, type DeployLock, type DeployManifest, type DeployOperation, type DeployPlanResult, type DeployRelease, type DeploySnapshot
} from '../shared/deploy'
import { getSettings, saveSettings } from './settings'
import * as services from './services'

/**
 * Deploy pelo app: o repositório declara em `.ovseer/deploy.json` o comando que sobe o seu console local de
 * deploy e a porta. O app sobe o console como um serviço (reaproveitando o já cadastrado com o mesmo comando
 * e pasta) e conversa com a API dele: releases, fases, trava compartilhada e ações. As ações exigem o token
 * que o próprio console entrega no bootstrap e a origem dele, como a tela do console faz.
 */

export const MANIFEST_FILE = '.ovseer/deploy.json'

export function readManifest(root: string): { manifest: DeployManifest | null; error?: string } {
  const file = path.join(root, MANIFEST_FILE)
  if (!existsSync(file)) return { manifest: null }
  try {
    return { manifest: parseDeployManifest(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { manifest: null, error: (e as Error).message }
  }
}

function manifestOf(root: string): DeployManifest {
  const { manifest, error } = readManifest(root)
  if (!manifest) throw new Error(error ?? 'Este projeto não tem .ovseer/deploy.json.')
  return manifest
}

const originOf = (m: DeployManifest) => `http://127.0.0.1:${m.port}`

/** Token de mutação por repositório, entregue pelo bootstrap do console */
const tokens = new Map<string, string>()

interface Bootstrap {
  token: string
  active_operation: DeployOperation | null
  expected_test_total: number
  releases: DeployRelease[]
}

async function request<T>(origin: string, pathname: string, init: RequestInit = {}, ms = 4000): Promise<T> {
  const res = await fetch(`${origin}${pathname}`, { ...init, signal: AbortSignal.timeout(ms) })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error || `Falha HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function bootstrap(root: string, m: DeployManifest): Promise<Bootstrap> {
  const boot = await request<Bootstrap>(originOf(m), '/api/bootstrap', {}, 2500)
  tokens.set(root, boot.token)
  return boot
}

async function post<T>(root: string, pathname: string, body: unknown, ms = 15_000): Promise<T> {
  const m = manifestOf(root)
  if (!tokens.has(root)) await bootstrap(root, m)
  const origin = originOf(m)
  return request<T>(origin, pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Deploy-Console-Token': tokens.get(root)! },
    body: JSON.stringify(body)
  }, ms)
}

// ---------- o console como serviço ----------

const samePath = (a: string, b: string) => path.resolve(a || '') === path.resolve(b || '')

function findService(root: string, m: DeployManifest): Service | undefined {
  return getSettings().services.find((s) => samePath(s.cwd, root) && s.command.trim() === m.start)
}

const proposedService = (root: string, m: DeployManifest) => ({ name: `${m.name} · ${path.basename(root)}`, command: m.start, cwd: root })

/** Serviço que sobe o console: o já cadastrado com o mesmo comando e pasta, ou um novo (a tela confirma antes) */
function consoleService(root: string, m: DeployManifest): Service {
  const found = findService(root, m)
  if (found) return found
  const created: Service = { id: randomUUID(), ...proposedService(root, m) }
  const next = saveSettings({ services: [...getSettings().services, created] })
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) wc.send('settings:changed', next)
  return created
}

export async function startConsole(root: string): Promise<void> {
  const m = manifestOf(root)
  await services.startService(consoleService(root, m).id)
}

const serviceRunning = (root: string, m: DeployManifest) => {
  const s = findService(root, m)
  return !!s && services.serviceStates().find((st) => st.id === s.id)?.status === 'running'
}

// ---------- leitura ----------

export async function snapshot(root: string): Promise<DeploySnapshot> {
  const m = manifestOf(root)
  const origin = originOf(m)
  let boot: Bootstrap
  try {
    boot = await bootstrap(root, m)
  } catch {
    tokens.delete(root)
    const found = findService(root, m)
    const service = found
      ? { registered: true, name: found.name, command: found.command, cwd: found.cwd }
      : { registered: false, ...proposedService(root, m) }
    return { console: serviceRunning(root, m) ? 'starting' : 'stopped', origin, operation: null, releases: [], current: null, expectedTests: 0, service }
  }
  const releases = Array.isArray(boot.releases) ? boot.releases : []
  let current: DeployRelease | null = releases[0] ?? null
  if (current) {
    try {
      current = (await request<{ release: DeployRelease }>(origin, `/api/releases/${encodeURIComponent(current.tag)}`)).release
    } catch {
      /* fica o resumo do bootstrap */
    }
  }
  return { console: 'ready', origin, operation: boot.active_operation ?? null, releases, current, expectedTests: Number(boot.expected_test_total) || 0 }
}

/** Trava compartilhada: o console consulta o S3, então demora um ou dois segundos */
export async function lock(root: string): Promise<DeployLock> {
  const m = manifestOf(root)
  return (await request<{ lock: DeployLock }>(originOf(m), '/api/lock', {}, 20_000)).lock
}

export async function log(root: string, tag: string, phase: string): Promise<string> {
  const m = manifestOf(root)
  const res = await fetch(`${originOf(m)}/api/releases/${encodeURIComponent(tag)}/logs/${encodeURIComponent(phase)}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`Falha HTTP ${res.status}`)
  return res.text()
}

// ---------- ações ----------

/** Gera o plano (preflight: git, AWS, trava); pode levar alguns minutos */
export const plan = (root: string, typesenseFirst: boolean) =>
  post<DeployPlanResult>(root, '/api/plan', { typesense_first: typesenseFirst }, 10 * 60_000)

export const run = async (root: string, planId: string) =>
  (await post<{ operation: DeployOperation }>(root, '/api/deploy', { confirmed: true, plan_id: planId })).operation

export const cancel = async (root: string, operationId: string, tag: string) => {
  await post(root, '/api/operations/cancel', { confirmation: 'CANCELAR', operation_id: operationId, release_tag: tag })
}

export const resume = async (root: string, tag: string) =>
  (await post<{ operation: DeployOperation }>(root, `/api/releases/${encodeURIComponent(tag)}/resume`, {})).operation

export const releaseLock = async (root: string) =>
  (await post<{ lock: DeployLock }>(root, '/api/lock/release', { confirmation: 'LIBERAR' }, 30_000)).lock

export function openConsole(root: string): Promise<void> {
  return shell.openExternal(originOf(manifestOf(root)))
}
