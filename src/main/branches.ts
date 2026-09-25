import type { BranchInfo, CleanupCandidate, OperationResult, StepResult } from '../shared/types'
import { currentOperation, git, refExists, run, status } from './git'
import { firstLine, friendlyGitError } from '../shared/gitErrors'

/**
 * Linhas de trabalho (branches), em linguagem simples:
 * - trocar levando as alterações junto, ou guardando e trazendo de volta ao retornar;
 * - limpar cópias de segurança automáticas e linhas já incorporadas à principal.
 */

const SWITCH_PREFIX = 'ovrgit-troca:'
const MAIN_NAMES = ['main', 'master', 'develop', 'dev']
const SEP = '\x1f'

function fail(steps: StepResult[], e: unknown, label?: string): OperationResult {
  const raw = e instanceof Error ? e.message : String(e)
  // erro do Git em frase simples; o texto original fica em "Detalhes técnicos"
  const friendly = friendlyGitError(raw)
  const detail = friendly ?? firstLine(raw)
  if (label) steps.push({ label, ok: false, detail, tech: raw.trim() !== detail ? raw.trim() : undefined })
  const error = friendly ?? raw
  return { ok: false, steps, error }
}

async function validName(root: string, name: string) {
  return (await run(root, ['check-ref-format', '--branch', name])).code === 0 && !name.startsWith('-')
}

export async function listBranches(root: string): Promise<BranchInfo[]> {
  const fmt = ['%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:iso-strict)', '%(subject)'].join(SEP)
  const [localOut, remoteOut, st] = await Promise.all([
    run(root, ['for-each-ref', 'refs/heads', `--format=${fmt}`]),
    run(root, ['for-each-ref', 'refs/remotes/origin', `--format=${fmt}`]),
    status(root)
  ])
  const list: BranchInfo[] = []
  const locals = new Set<string>()
  for (const line of localOut.stdout.split('\n').filter(Boolean)) {
    const [name, upstream, track, date, subject] = line.split(SEP)
    locals.add(name)
    const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
    const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
    list.push({
      name,
      where: 'local',
      current: name === st.branch,
      published: !!upstream && !/gone/.test(track),
      ahead,
      behind,
      date,
      subject,
      backup: name.startsWith('backup/auto-')
    })
  }
  for (const line of remoteOut.stdout.split('\n').filter(Boolean)) {
    const [full, , , date, subject] = line.split(SEP)
    const name = full.replace(/^origin\//, '')
    if (name === 'HEAD' || full === 'origin' || locals.has(name)) continue
    list.push({ name, where: 'remote', current: false, published: true, ahead: 0, behind: 0, date, subject, backup: false })
  }
  return list
}

async function findSwitchStash(root: string, branch: string): Promise<string | null> {
  const r = await run(root, ['stash', 'list', '--format=%gd%x1f%s'])
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [ref, subject] = line.split(SEP)
    if (subject.replace(/^On [^:]+: /, '') === `${SWITCH_PREFIX} ${branch}`) return ref
  }
  return null
}

/**
 * Troca de linha de trabalho.
 * - mode "carry": leva as alterações não salvas junto (se não houver conflito);
 * - mode "stash": guarda as alterações desta linha; elas voltam sozinhas quando o usuário retornar a ela.
 */
export async function switchBranch(root: string, name: string, mode: 'carry' | 'stash'): Promise<OperationResult> {
  const steps: StepResult[] = []
  if (!(await validName(root, name))) return fail(steps, new Error(`Nome inválido: ${name}`))
  if (await currentOperation(root)) return fail(steps, new Error('Termine de juntar as versões antes de trocar de linha.'))
  const st = await status(root)
  if (st.branch === name) return { ok: true, steps }
  const isLocal = await refExists(root, `refs/heads/${name}`)
  const isRemote = !isLocal && (await refExists(root, `refs/remotes/origin/${name}`))
  if (!isLocal && !isRemote) return fail(steps, new Error(`A linha "${name}" não existe.`))

  let stashed = false
  if (mode === 'stash' && st.files.length && st.branch) {
    try {
      await git(root, ['stash', 'push', '--include-untracked', '-m', `${SWITCH_PREFIX} ${st.branch}`])
      stashed = true
      steps.push({ label: `Alterações de "${st.branch}" guardadas`, ok: true, detail: 'Voltam sozinhas quando você retornar a essa linha.' })
    } catch (e) {
      return fail(steps, e, 'Guardar alterações')
    }
  }

  try {
    if (isLocal) await git(root, ['switch', name])
    else await git(root, ['switch', '--track', `origin/${name}`])
    steps.push({ label: `Agora em "${name}"`, ok: true, detail: isRemote ? 'Trazida do servidor para o seu computador.' : undefined })
  } catch (e) {
    const msg = (e as Error).message
    if (stashed) {
      // não conseguiu trocar: devolve o que foi guardado para não "sumir" nada
      await run(root, ['stash', 'pop'])
    }
    const conflict = /would be overwritten|overwritten by checkout/i.test(msg)
    return fail(
      steps,
      new Error(
        conflict
          ? 'Suas alterações não salvas conflitam com a outra linha. Use "Guardar e trocar" ou salve uma versão antes.'
          : msg
      ),
      'Trocar de linha'
    )
  }

  // alterações guardadas quando o usuário saiu desta linha: traz de volta
  const back = await findSwitchStash(root, name)
  if (back) {
    const r = await run(root, ['stash', 'pop', back])
    steps.push(
      r.code === 0
        ? { label: 'Suas alterações desta linha voltaram', ok: true }
        : { label: 'Não deu para trazer de volta as alterações guardadas', ok: false, detail: 'Elas continuam em Histórico → Guardadas.' }
    )
  }
  return { ok: steps.every((s) => s.ok), steps, error: steps.find((s) => !s.ok)?.detail }
}

/** Cria uma linha nova a partir da atual (levando as alterações não salvas junto). */
export async function createBranch(root: string, name: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  const clean = name.trim()
  if (!(await validName(root, clean))) return fail(steps, new Error(`Nome inválido: ${clean}`))
  if (await refExists(root, `refs/heads/${clean}`)) return fail(steps, new Error(`Já existe uma linha chamada "${clean}".`))
  try {
    await git(root, ['switch', '-c', clean])
    steps.push({ label: `Linha "${clean}" criada`, ok: true, detail: 'Você já está nela. Suas alterações não salvas vieram junto.' })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, 'Criar linha')
  }
}

/**
 * Linha de trabalho de uma tarefa: feature/road-18-correcao-do-salvamento.
 * Se já existir (local ou no servidor), só troca para ela, levando as alterações junto.
 */
export async function startTaskBranch(root: string, key: string, title: string, prefix: string): Promise<OperationResult> {
  const slug = `${key}-${title}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  const name = `${prefix.replace(/\/+$/, '') || 'feature'}/${slug}`
  const exists = (await refExists(root, `refs/heads/${name}`)) || (await refExists(root, `refs/remotes/origin/${name}`))
  return exists ? switchBranch(root, name, 'carry') : createBranch(root, name)
}

/** Candidatas à limpeza: cópias de segurança automáticas e linhas já incorporadas à principal. */
export async function cleanupCandidates(root: string): Promise<CleanupCandidate[]> {
  const st = await status(root)
  const branches = (await listBranches(root)).filter((b) => b.where === 'local' && !b.current)
  // principal: a do servidor (origin/main) e a local (main); incorporada em qualquer uma é segura de remover
  const bases: string[] = []
  for (const n of MAIN_NAMES) {
    if (await refExists(root, `refs/remotes/origin/${n}`)) bases.push(`origin/${n}`)
    if (await refExists(root, `refs/heads/${n}`)) bases.push(n)
    if (bases.length) break
  }
  const merged = new Set<string>()
  for (const base of bases) {
    const r = await run(root, ['branch', '--format=%(refname:short)', '--merged', base])
    r.stdout.split('\n').filter(Boolean).forEach((b) => merged.add(b))
  }
  const out: CleanupCandidate[] = []
  const weekAgo = Date.now() - 7 * 86400_000
  for (const b of branches) {
    if (b.backup) {
      // a data da cópia está no nome (backup/auto-AAAA-MM-DD-HHMMSS); a da versão pode ser bem mais antiga
      const m = /^backup\/auto-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(b.name)
      const created = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(b.date)
      out.push({ name: b.name, reason: 'backup', date: created.toISOString(), suggested: created.getTime() < weekAgo })
    } else if (merged.has(b.name) && !MAIN_NAMES.includes(b.name) && b.name !== st.branch) {
      out.push({ name: b.name, reason: 'merged', date: b.date, suggested: true })
    }
  }
  return out
}

/** Remove linhas: incorporadas com -d (seguro); cópias de segurança com -D. */
export async function deleteBranches(root: string, names: string[]): Promise<OperationResult> {
  const steps: StepResult[] = []
  const candidates = new Map((await cleanupCandidates(root)).map((c) => [c.name, c]))
  for (const name of names) {
    const c = candidates.get(name)
    if (!c) {
      steps.push({ label: `"${name}" não pode ser removida por aqui`, ok: false })
      continue
    }
    const r = await run(root, ['branch', c.reason === 'backup' ? '-D' : '-d', name])
    steps.push(r.code === 0 ? { label: `Removida: ${name}`, ok: true } : { label: `Não removida: ${name}`, ok: false, detail: r.stderr.trim() })
  }
  const removed = steps.filter((s) => s.ok).length
  return { ok: steps.every((s) => s.ok), steps, error: removed === names.length ? undefined : 'Algumas linhas não foram removidas.' }
}
