import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CreatedCommit, OperationResult, StepResult } from '../shared/types'
import { currentOperation, git, refExists, status } from './git'

/**
 * Salvar versão com só alguns trechos de um arquivo.
 *
 * Monta a versão num índice temporário (GIT_INDEX_FILE): parte do último commit, adiciona os arquivos
 * inteiros e aplica só os trechos escolhidos dos parciais. A pasta de trabalho nunca é tocada, então o
 * que ficou de fora continua na lista de alterações.
 */

export interface PartialSpec {
  path: string
  /** índices dos trechos (hunks) incluídos, na ordem do diff contra HEAD */
  hunks: number[]
}

/** Separa um diff de um arquivo em cabeçalho e trechos (@@ … @@). */
export function splitHunks(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split('\n')
  const first = lines.findIndex((l) => l.startsWith('@@'))
  if (first < 0) return { header: diff, hunks: [] }
  const header = lines.slice(0, first).join('\n') + '\n'
  const hunks: string[] = []
  let cur: string[] = []
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@') && cur.length) {
      hunks.push(cur.join('\n') + '\n')
      cur = []
    }
    cur.push(l)
  }
  if (cur.length) hunks.push(cur.join('\n').replace(/\n*$/, '') + '\n')
  return { header, hunks }
}

/** Mesmo diff mostrado na tela (contra HEAD, com 3 linhas de contexto): os índices dos trechos batem. */
export function fileDiff(root: string, file: string) {
  return git(root, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file])
}

export async function commitWithHunks(
  root: string,
  fullFiles: string[],
  partial: PartialSpec[],
  message: string
): Promise<OperationResult> {
  const steps: StepResult[] = []
  const fail = (e: unknown, label = 'Salvar versão') => {
    const error = e instanceof Error ? e.message : String(e)
    steps.push({ label, ok: false, detail: error })
    return { ok: false, steps, error } as OperationResult
  }
  if (!message.trim()) return fail(new Error('Descreva o que você fez.'))
  if (await currentOperation(root)) return fail(new Error('Termine de juntar as versões antes de salvar.'))
  if (!(await refExists(root, 'HEAD'))) return fail(new Error('Salve a primeira versão com os arquivos inteiros.'))
  if (!fullFiles.length && !partial.some((p) => p.hunks.length)) return fail(new Error('Nenhum trecho selecionado.'))

  const st = await status(root)
  const known = new Map(st.files.map((f) => [f.path, f]))
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovrgit-index-'))
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
  try {
    await git(root, ['read-tree', 'HEAD'], undefined, env)
    // arquivos inteiros (inclui o caminho antigo de renomeados)
    const full = fullFiles.flatMap((p) => {
      const f = known.get(p)
      return f?.origPath ? [p, f.origPath] : [p]
    })
    if (full.length) {
      await git(root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], full.join('\0') + '\0', env)
    }
    // trechos escolhidos
    for (const spec of partial) {
      if (!spec.hunks.length) continue
      const f = known.get(spec.path)
      if (!f || f.kind === 'untracked' || f.kind === 'renamed') {
        throw new Error(`${spec.path}: esse tipo de alteração só pode ser salvo inteiro.`)
      }
      const { header, hunks } = splitHunks(await fileDiff(root, spec.path))
      const chosen = spec.hunks.filter((i) => i >= 0 && i < hunks.length).map((i) => hunks[i])
      if (!chosen.length) continue
      await git(root, ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], header + chosen.join(''), env)
    }
    const diffCheck = await git(root, ['diff', '--cached', '--name-only', 'HEAD'], undefined, env)
    if (!diffCheck.trim()) throw new Error('Nada para salvar com essa seleção.')
    await git(root, ['commit', '-q', '-m', message.trim()], undefined, env)
    // o índice de verdade ainda aponta para a versão anterior nesses caminhos: sincroniza sem mexer nos arquivos
    const touched = diffCheck.trim().split('\n')
    await git(root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], touched.join('\0') + '\0')
    const sha = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const partialCount = partial.filter((p) => p.hunks.length).length
    steps.push({
      label: `Versão salva: ${message.trim().split('\n')[0]}`,
      ok: true,
      detail: `${touched.length} arquivo(s)${partialCount ? `, ${partialCount} só com parte das mudanças` : ''} · ${sha.slice(0, 7)}`
    })
    const commits: CreatedCommit[] = [{ sha, message: message.trim() }]
    return { ok: true, steps, commits }
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
