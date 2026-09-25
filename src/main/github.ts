import os from 'node:os'
import path from 'node:path'
import type { OperationResult, PublishInfo, StepResult } from '../shared/types'
import { findBinary, runCli } from './cli'
import { slugify } from '../shared/parse'
import { status } from './git'

async function gh(): Promise<string | null> {
  return findBinary('gh')
}

/** Dados para a tela de publicação: usuário do gh (se logado) e nome sugerido do repositório. */
export async function publishInfo(root: string): Promise<PublishInfo> {
  const suggestedName = slugify(path.basename(root)) || 'repositorio'
  const bin = await gh()
  if (!bin) return { ghUser: null, suggestedName }
  const r = await runCli(bin, ['api', 'user', '--jq', '.login'], '', os.tmpdir(), 15_000).catch(() => null)
  const user = r && r.code === 0 ? r.stdout.trim() : ''
  return { ghUser: user || null, suggestedName }
}

/** Cria o repositório no GitHub com o gh e publica a branch atual. */
export async function publishToGitHub(root: string, name: string, isPrivate: boolean): Promise<OperationResult> {
  const steps: StepResult[] = []
  const bin = await gh()
  if (!bin) return { ok: false, steps, error: 'GitHub CLI (gh) não encontrado.' }
  const repo = slugify(name)
  if (!repo) return { ok: false, steps, error: 'Informe um nome para o repositório.' }
  const st = await status(root)
  if (!st.hasCommits) return { ok: false, steps, error: 'Faça um commit antes de publicar.' }
  if (st.hasRemote) return { ok: false, steps, error: 'O repositório já tem um remote "origin".' }
  const r = await runCli(
    bin,
    ['repo', 'create', repo, isPrivate ? '--private' : '--public', '--source', root, '--remote', 'origin', '--push'],
    '',
    root,
    120_000
  )
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n')
    steps.push({ label: 'Criar repositório no GitHub', ok: false, detail })
    return { ok: false, steps, error: detail }
  }
  const url = (r.stdout.match(/https:\/\/github\.com\/\S+/) ?? [])[0]
  steps.push({ label: `Repositório criado no GitHub (${isPrivate ? 'privado' : 'público'})`, ok: true, detail: url })
  steps.push({ label: `Branch publicada: origin/${st.branch}`, ok: true })
  return { ok: true, steps, prUrl: null }
}

/** PR da branch atual no GitHub (aberto ou já mergeado), via gh. Null se não houver ou sem gh. */
export async function findPullRequest(root: string): Promise<string | null> {
  const bin = await gh()
  if (!bin) return null
  const st = await status(root)
  if (!st.branch || !st.hasRemote) return null
  const r = await runCli(
    bin,
    ['pr', 'list', '--head', st.branch, '--state', 'all', '--limit', '1', '--json', 'url'],
    '',
    root,
    15_000
  )
  if (r.code !== 0) return null
  try {
    const list = JSON.parse(r.stdout) as { url?: string }[]
    return list[0]?.url ?? null
  } catch {
    return null
  }
}
