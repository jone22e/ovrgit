import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  CommitInfo, FeaturePreview, FileChange, OperationResult, RepoOperation, RepoStatus, StepResult
} from '../shared/types'
import { LOG_FORMAT, parseLog, parseStatus, pullRequestUrl, slugify } from '../shared/parse'

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string
  ) {
    super(message)
  }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

let gitBinary: string | null = null

/** Localiza o executável do git. Apps abertos pelo Finder/Explorer não herdam o PATH do terminal. */
function resolveGit(): string {
  if (gitBinary) return gitBinary
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe')
    ]
    gitBinary = candidates.find((c) => existsSync(c)) ?? 'git'
  } else {
    const candidates = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
    gitBinary = candidates.find((c) => existsSync(c)) ?? 'git'
  }
  return gitBinary
}

const MAX_OUTPUT = 20 * 1024 * 1024

export function run(cwd: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveGit(), ['-c', 'core.quotepath=false', '-c', 'color.ui=never', ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        LANG: 'C'
      }
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size <= MAX_OUTPUT) out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') reject(new GitError('Git não encontrado. Instale o Git e reinicie o app.', null, ''))
      else reject(e)
    })
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    )
    child.stdin.end(input ?? '')
  })
}

/** Executa o git e lança GitError se o código de saída não for 0. */
export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await run(cwd, args, input)
  if (r.code !== 0) {
    const msg = errorText(r) || `git ${args[0]} falhou (código ${r.code})`
    throw new GitError(msg, r.code, r.stderr)
  }
  return r.stdout
}

/** Junta stdout e stderr e remove ruído (progresso de fetch, dicas), mantendo o que explica a falha. */
function errorText(r: RunResult): string {
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\s*(From |[0-9a-f]{7,}\.\.|\* branch|hint:)/.test(l))
  const important = lines.filter((l) => /conflict|error|fatal|rejected|denied|could not|cannot|failed|unable/i.test(l))
  return (important.length ? important : lines).slice(0, 12).join('\n').trim()
}

const nulList = (files: string[]) => files.join('\0') + '\0'

export async function findRoot(dir: string): Promise<string> {
  const r = await run(dir, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) throw new GitError('A pasta selecionada não é um repositório Git.', r.code, r.stderr)
  return path.resolve(r.stdout.trim())
}

async function remotes(root: string): Promise<string[]> {
  return (await git(root, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean)
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return (await run(root, ['rev-parse', '--verify', '--quiet', ref])).code === 0
}

export async function status(root: string): Promise<RepoStatus> {
  const [out, rems, operation] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    remotes(root),
    currentOperation(root)
  ])
  const s = parseStatus(out)
  const conflicts = s.files.filter((f) => f.kind === 'conflict').length
  return { root, name: path.basename(root), hasRemote: rems.includes('origin'), operation, conflicts, ...s }
}

/** Detecta merge/rebase/cherry-pick/revert interrompidos (geralmente por conflito). */
export async function currentOperation(root: string): Promise<RepoOperation> {
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).trim())
  const has = (p: string) => existsSync(path.join(gitDir, p))
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return null
}

const OP_LABEL: Record<Exclude<RepoOperation, null>, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert'
}

const PULL_STASH_MSG = 'ovrgit: stash antes do pull'

/** Restaura o stash que o OvrGit criou antes do pull, se ele ainda existir. */
async function popPullStash(root: string, steps: StepResult[]) {
  const list = await git(root, ['stash', 'list', '--format=%gd%x1f%s'])
  const ref = list
    .split('\n')
    .map((l) => l.split('\x1f'))
    .find(([, subject]) => subject?.includes(PULL_STASH_MSG))?.[0]
  if (!ref) return
  try {
    await git(root, ['stash', 'pop', ref])
    steps.push({ label: 'Alterações locais restauradas', ok: true })
  } catch (e) {
    steps.push({
      label: 'Restaurar alterações (stash pop)',
      ok: false,
      detail: `${(e as Error).message}\nSuas alterações continuam salvas em "git stash list".`
    })
  }
}

export type ConflictChoice = 'mine' | 'theirs' | 'resolved'

/** Resolve um arquivo em conflito: fica com a minha versão, com a remota, ou marca como resolvido (git add). */
export async function resolveConflict(root: string, file: string, choice: ConflictChoice): Promise<OperationResult> {
  const steps: StepResult[] = []
  try {
    if (choice !== 'resolved') {
      // no rebase os lados se invertem: "ours" é a branch remota sobre a qual estamos reaplicando
      const rebase = (await currentOperation(root)) === 'rebase'
      const side = (choice === 'mine') !== rebase ? '--ours' : '--theirs'
      await git(root, ['checkout', side, '--', file])
    }
    await git(root, ['add', '--', file])
    const label = { mine: 'Mantida a minha versão', theirs: 'Mantida a versão remota', resolved: 'Marcado como resolvido' }
    steps.push({ label: `${label[choice]}: ${file}`, ok: true })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, `Resolver ${file}`)
  }
}

export async function abortOperation(root: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  const op = await currentOperation(root)
  if (!op) return fail(steps, new Error('Nenhuma operação em andamento.'))
  try {
    await git(root, [op, '--abort'])
    steps.push({ label: `${OP_LABEL[op]} abortado; o repositório voltou ao estado anterior`, ok: true })
    if (op === 'rebase' && (await run(root, ['config', '--local', '--unset', PENDING_PUSH_KEY])).code === 0)
      steps.push({
        label: 'A feature continua criada, mas sem atualizar com a main',
        ok: true,
        detail: 'Use "Enviar" para mandá-la assim mesmo, ou tente de novo mais tarde.'
      })
  } catch (e) {
    return fail(steps, e, `Abortar ${OP_LABEL[op]}`)
  }
  await popPullStash(root, steps)
  return { ok: steps.every((s) => s.ok), steps, error: steps.find((s) => !s.ok)?.detail }
}

export async function continueOperation(root: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  const op = await currentOperation(root)
  if (!op) return fail(steps, new Error('Nenhuma operação em andamento.'))
  const st = await status(root)
  if (st.conflicts) return fail(steps, new Error(`Ainda há ${st.conflicts} arquivo(s) em conflito.`))
  try {
    if (op === 'merge') {
      // leva as edições feitas para resolver os conflitos (arquivos rastreados; nada de arquivos soltos)
      await git(root, ['add', '-u'])
      await git(root, ['commit', '--no-edit'])
    } else {
      await git(root, ['-c', 'core.editor=true', op, '--continue'])
    }
    steps.push({ label: `${OP_LABEL[op]} concluído`, ok: true })
  } catch (e) {
    return fail(steps, e, `Concluir ${OP_LABEL[op]}`)
  }
  let prUrl: string | null = null
  if ((await currentOperation(root)) === null) {
    await popPullStash(root, steps)
    if (op === 'rebase') prUrl = await finishPendingFeature(root, steps)
  }
  return { ok: steps.every((s) => s.ok), steps, prUrl, error: steps.find((s) => !s.ok)?.detail }
}

const MAX_DIFF = 400 * 1024

export async function diff(root: string, file: FileChange): Promise<string> {
  let text: string
  if (file.kind === 'untracked') {
    // --no-index sai com código 1 quando há diferença
    text = (await run(root, ['diff', '--no-index', '--', '/dev/null', file.path])).stdout
  } else {
    const paths = file.origPath ? [file.origPath, file.path] : [file.path]
    const hasHead = await refExists(root, 'HEAD')
    if (hasHead) {
      text = await git(root, ['diff', '-M', 'HEAD', '--', ...paths])
    } else {
      const staged = await git(root, ['diff', '--cached', '--', ...paths])
      const unstaged = await git(root, ['diff', '--', ...paths])
      text = staged + unstaged
    }
  }
  if (text.length > MAX_DIFF) text = text.slice(0, MAX_DIFF) + '\n\n… diff truncado (arquivo muito grande)'
  return text
}

export async function log(root: string, limit = 50): Promise<CommitInfo[]> {
  if (!(await refExists(root, 'HEAD'))) return []
  return parseLog(await git(root, ['log', `-n${limit}`, `--pretty=format:${LOG_FORMAT}`]))
}

/**
 * Resolve os caminhos de um commit parcial.
 * - `add`: só o que ainda existe na working tree ou no índice (git add falha com caminhos sumidos)
 * - `commit`: inclui também o caminho antigo dos renomeados, senão a remoção ficaria de fora
 */
async function resolvePaths(root: string, files: string[]): Promise<{ add: string[]; commit: string[] }> {
  const st = await status(root)
  const wanted = new Set(files)
  const add: string[] = []
  const commit = new Set<string>()
  for (const f of st.files) {
    if (!wanted.has(f.path)) continue
    commit.add(f.path)
    if (f.origPath) commit.add(f.origPath)
    const stagedDeletion = f.kind === 'deleted' && !f.unstaged
    if (!stagedDeletion) add.push(f.path)
  }
  return { add, commit: [...commit] }
}

export async function commit(root: string, files: string[], message: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  try {
    if (!message.trim()) throw new Error('Informe a mensagem do commit.')
    const op = await currentOperation(root)
    if (op) throw new Error(`Há um ${OP_LABEL[op]} em andamento. Resolva os conflitos e use "Concluir ${OP_LABEL[op]}".`)
    const paths = await resolvePaths(root, files)
    if (!paths.commit.length) throw new Error('Nenhum arquivo selecionado.')
    if (paths.add.length)
      await git(root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], nulList(paths.add))
    // --only (implícito com pathspec) garante que só estes arquivos entram no commit
    await git(
      root,
      ['commit', '-m', message.trim(), '--pathspec-from-file=-', '--pathspec-file-nul'],
      nulList(paths.commit)
    )
    steps.push({ label: `Commit: ${message.split('\n')[0]}`, ok: true, detail: `${files.length} arquivo(s)` })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e)
  }
}

export async function commitGroups(
  root: string,
  groups: { files: string[]; message: string }[]
): Promise<OperationResult> {
  const steps: StepResult[] = []
  for (const g of groups) {
    const r = await commit(root, g.files, g.message)
    steps.push(...r.steps)
    if (!r.ok) return { ok: false, steps, error: r.error }
  }
  return { ok: true, steps }
}

function fail(steps: StepResult[], e: unknown, label?: string): OperationResult {
  const error = e instanceof Error ? e.message : String(e)
  if (label) steps.push({ label, ok: false, detail: error })
  return { ok: false, steps, error }
}

export async function pull(root: string, allowStash: boolean): Promise<OperationResult> {
  const steps: StepResult[] = []
  const st = await status(root)
  if (!st.branch) return fail(steps, new Error('HEAD destacado: faça checkout de uma branch antes de Baixar.'))
  if (!st.upstream) return fail(steps, new Error('A branch ainda não existe no remoto. Use Enviar primeiro.'))
  const dirty = st.files.length > 0
  if (dirty && !allowStash) return { ok: false, steps, error: 'DIRTY' }

  let stashed = false
  if (dirty) {
    try {
      await git(root, ['stash', 'push', '-u', '-m', PULL_STASH_MSG])
      stashed = true
      steps.push({ label: 'Alterações locais guardadas (stash)', ok: true })
    } catch (e) {
      return fail(steps, e, 'Stash')
    }
  }

  try {
    const out = await git(root, ['pull', '--no-rebase', '--no-edit'])
    steps.push({ label: 'Baixar', ok: true, detail: out.trim().split('\n').pop() })
  } catch (e) {
    const op = await currentOperation(root)
    if (op) {
      const conflicted = (await git(root, ['diff', '--name-only', '--diff-filter=U'])).trim().split('\n').filter(Boolean)
      steps.push({
        label: `Conflito no merge: ${conflicted.length} arquivo(s)`,
        ok: false,
        detail: `${conflicted.slice(0, 15).join('\n')}${conflicted.length > 15 ? `\n… e mais ${conflicted.length - 15}` : ''}`
      })
      if (stashed)
        steps.push({
          label: 'Suas alterações locais estão guardadas',
          ok: true,
          detail: 'Elas voltam sozinhas quando você concluir ou abortar o merge.'
        })
      return {
        ok: false,
        steps,
        error: `Baixar parou por conflito em ${conflicted.length} arquivo(s). Resolva os conflitos ou aborte o merge.`
      }
    }
    fail(steps, e, 'Baixar')
    if (stashed) await popStash(root, steps)
    return { ok: false, steps, error: steps.find((s) => s.label === 'Baixar')?.detail }
  }

  if (stashed) await popStash(root, steps)
  return { ok: steps.every((s) => s.ok), steps, error: steps.find((s) => !s.ok)?.detail }
}

async function popStash(root: string, steps: StepResult[]) {
  try {
    await git(root, ['stash', 'pop'])
    steps.push({ label: 'Alterações locais restauradas', ok: true })
  } catch (e) {
    steps.push({
      label: 'Restaurar alterações (stash pop)',
      ok: false,
      detail: `${(e as Error).message}\nSuas alterações continuam salvas em "git stash list".`
    })
  }
}

export async function push(root: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  const st = await status(root)
  if (!st.branch) return fail(steps, new Error('HEAD destacado: faça checkout de uma branch antes de Enviar.'))
  if (!st.hasCommits) return fail(steps, new Error('Faça um commit antes de Enviar.'))
  try {
    if (st.upstream) {
      await git(root, ['push'])
      steps.push({ label: `Enviado para ${st.upstream}`, ok: true })
    } else {
      if (!st.hasRemote) throw new Error('O repositório não tem remote "origin".')
      await git(root, ['push', '-u', 'origin', st.branch])
      steps.push({ label: `Enviado para origin/${st.branch} (branch criada no remoto)`, ok: true })
    }
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, 'Enviar')
  }
}

/** Ref remota que representa a "base" da branch atual (normalmente origin/main). */
async function baseRef(root: string, st: RepoStatus): Promise<string | null> {
  if (st.upstream) return st.upstream
  if (st.branch && (await refExists(root, `refs/remotes/origin/${st.branch}`))) return `origin/${st.branch}`
  return null
}

export async function featurePreview(root: string): Promise<FeaturePreview> {
  let st = await status(root)
  if (st.hasRemote) {
    await run(root, ['fetch', 'origin']) // se falhar (offline), segue com o que tem
    st = await status(root)
  }
  const base = await baseRef(root, st)
  const remoteNew = base ? Number((await git(root, ['rev-list', '--count', `HEAD..${base}`])).trim()) || 0 : 0
  let localCommits = 0
  const changed = new Set(st.files.map((f) => f.path))
  if (base) {
    localCommits = Number((await git(root, ['rev-list', '--count', `${base}..HEAD`])).trim()) || 0
    if (localCommits > 0) {
      const names = await git(root, ['diff', '--name-only', '-z', `${base}...HEAD`])
      names.split('\0').filter(Boolean).forEach((n) => changed.add(n))
    }
  } else if (st.hasCommits) {
    localCommits = Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim()) || 0
  }
  return {
    branch: st.branch,
    baseRef: base,
    localCommits,
    remoteNew,
    changedFiles: changed.size,
    hasRemote: st.hasRemote,
    dirty: st.files.length > 0
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Move o trabalho local para uma nova branch de feature, já atualizada com a versão atual do remoto:
 *
 *   fetch → backup → cria a feature → main = origin/main → rebase da feature sobre origin/main → push
 *
 * A branch base é reposicionada com `git branch -f` (sem checkout/reset --hard), e o rebase usa
 * --autostash, então alterações não commitadas nunca se perdem. Se o rebase parar em conflito, o push
 * fica pendente e é feito automaticamente ao concluir o rebase (ver continueOperation).
 */
export async function createFeature(root: string, rawName: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  const slug = slugify(rawName)
  if (!slug) return fail(steps, new Error('Informe um nome válido para a feature.'))
  const feature = `feature/${slug}`

  const st = await status(root)
  if (!st.branch) return fail(steps, new Error('HEAD destacado: faça checkout de uma branch primeiro.'))
  if (!st.hasCommits) return fail(steps, new Error('O repositório ainda não tem commits.'))
  if (st.operation) return fail(steps, new Error(`Conclua ou aborte o ${OP_LABEL[st.operation]} antes.`))
  if (st.conflicts) return fail(steps, new Error('Resolva os conflitos antes.'))
  if ((await run(root, ['check-ref-format', '--branch', feature])).code !== 0)
    return fail(steps, new Error(`Nome de branch inválido: ${feature}`))
  if (await refExists(root, `refs/heads/${feature}`)) return fail(steps, new Error(`A branch ${feature} já existe.`))

  const baseBranch = st.branch

  // 1. versão atual do remoto
  let fetched = false
  if (st.hasRemote) {
    try {
      await git(root, ['fetch', 'origin'])
      fetched = true
      steps.push({ label: 'Main atual baixada do remoto (fetch)', ok: true })
    } catch (e) {
      steps.push({ label: 'Fetch origin', ok: false, detail: `${(e as Error).message} (continuando com a versão local)` })
    }
  }

  // 2. backup de tudo como está
  const backup = `backup/auto-${timestamp()}`
  try {
    await git(root, ['branch', backup])
    steps.push({ label: `Backup criado: ${backup}`, ok: true })
  } catch (e) {
    return fail(steps, e, 'Criar backup')
  }

  // 3. feature a partir do trabalho local
  try {
    await git(root, ['switch', '-c', feature])
    steps.push({ label: `Feature criada: ${feature}`, ok: true })
  } catch (e) {
    return fail(steps, e, 'Criar feature')
  }

  // 4. main local = versão atual do remoto
  const base = await baseRef(root, { ...st, branch: baseBranch })
  if (!base) {
    steps.push({ label: `${baseBranch} mantida (não existe no remoto)`, ok: true })
  } else {
    try {
      const localOnly = Number((await git(root, ['rev-list', '--count', `${base}..${backup}`])).trim()) || 0
      const remoteNew = Number((await git(root, ['rev-list', '--count', `${backup}..${base}`])).trim()) || 0
      await git(root, ['branch', '-f', baseBranch, base])
      const parts = [
        remoteNew ? `${remoteNew} commit(s) novo(s) do remoto` : '',
        localOnly ? `${localOnly} commit(s) local(is) movido(s) para a feature` : ''
      ].filter(Boolean)
      steps.push({
        label: `${baseBranch} atualizada = ${base}${parts.length ? ` (${parts.join(', ')})` : ''}`,
        ok: true
      })
    } catch (e) {
      steps.push({ label: `Atualizar ${baseBranch}`, ok: false, detail: (e as Error).message })
    }

    // 5. feature em cima da main atualizada
    const upToDate = (await run(root, ['merge-base', '--is-ancestor', base, 'HEAD'])).code === 0
    if (upToDate) {
      steps.push({ label: `Feature já está sobre a versão atual de ${base}`, ok: true })
    } else {
      const r = await run(root, ['-c', 'core.editor=true', 'rebase', '--autostash', base])
      if (r.code !== 0) {
        if ((await currentOperation(root)) === 'rebase') {
          // push fica pendente até o usuário resolver e concluir o rebase
          await git(root, ['config', '--local', PENDING_PUSH_KEY, `${feature} ${baseBranch}`])
          const conflicted = (await git(root, ['diff', '--name-only', '--diff-filter=U'])).trim().split('\n').filter(Boolean)
          steps.push({
            label: `Conflito ao atualizar a feature com ${base}: ${conflicted.length} arquivo(s)`,
            ok: false,
            detail: `${conflicted.join('\n')}\n\nResolva os conflitos e clique em "Concluir rebase": a feature será enviada automaticamente.`
          })
          return { ok: false, steps, error: 'A feature foi criada, mas há conflitos com a versão atual da main.' }
        }
        steps.push({ label: `Atualizar feature com ${base}`, ok: false, detail: errorText(r) })
        return { ok: false, steps, error: errorText(r) }
      }
      steps.push({ label: `Seus commits reaplicados sobre a versão atual de ${base} (rebase)`, ok: true })
    }
  }

  // 6. envia
  const pushed = await pushFeature(root, feature, baseBranch, st.hasRemote, steps)
  const ok = steps.every((s) => s.ok || (s.label.startsWith('Fetch') && !fetched))
  return { ok, steps, prUrl: pushed, error: ok ? undefined : steps.find((s) => !s.ok)?.detail }
}

const PENDING_PUSH_KEY = 'ovrgit.pendingFeaturePush'

async function pushFeature(
  root: string,
  feature: string,
  baseBranch: string,
  hasRemote: boolean,
  steps: StepResult[]
): Promise<string | null> {
  if (!hasRemote) {
    steps.push({ label: 'Sem remote "origin": push ignorado', ok: true })
    return null
  }
  try {
    await git(root, ['push', '-u', 'origin', feature])
    steps.push({ label: 'Feature enviada para origin', ok: true })
    const url = (await git(root, ['remote', 'get-url', 'origin'])).trim()
    return pullRequestUrl(url, feature, baseBranch)
  } catch (e) {
    steps.push({ label: 'Enviar feature para origin', ok: false, detail: (e as Error).message })
    return null
  }
}

/** Se um Criar Feature parou em conflito no rebase, termina o trabalho (push) após o rebase ser concluído. */
async function finishPendingFeature(root: string, steps: StepResult[]): Promise<string | null> {
  const pending = (await run(root, ['config', '--local', '--get', PENDING_PUSH_KEY])).stdout.trim()
  if (!pending) return null
  await run(root, ['config', '--local', '--unset', PENDING_PUSH_KEY])
  const [feature, baseBranch] = pending.split(' ')
  const st = await status(root)
  if (st.branch !== feature) return null
  return pushFeature(root, feature, baseBranch, st.hasRemote, steps)
}

/**
 * Contexto enviado à IA. Para agrupar por assunto basta saber *o que* mudou em cada arquivo,
 * então mandamos só as linhas alteradas (sem linhas de contexto), com um limite por arquivo.
 * Menos texto de entrada = resposta bem mais rápida.
 */
export async function aiContext(root: string, files: FileChange[], budget = 14000): Promise<string> {
  const hasHead = await refExists(root, 'HEAD')
  const base = hasHead ? ['HEAD'] : ['--cached']
  const tracked = files.some((f) => f.kind !== 'untracked')
  const [stat, patch] = tracked
    ? await Promise.all([
        git(root, ['diff', '-M', '--numstat', ...base]),
        git(root, ['diff', '-M', '--unified=0', '--no-prefix', '--no-color', ...base])
      ])
    : ['', '']

  const counts = new Map<string, string>()
  for (const line of stat.split('\n')) {
    const [add, del, ...rest] = line.split('\t')
    if (rest.length) counts.set(rest.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, ''), `+${add} -${del}`)
  }

  const perFile = Math.max(160, Math.min(900, Math.floor(budget / Math.max(files.length, 1))))
  const changes = new Map<string, string>()
  for (const section of splitPatch(patch)) {
    const header = /^diff --git (\S+) (\S+)/.exec(section)
    if (!header) continue
    const body = section
      .split('\n')
      .filter((l) => /^[+-](?![+-]{2} )/.test(l) && l.trim().length > 2)
      .map((l) => l.slice(0, 160))
      .join('\n')
    changes.set(header[2], body.length > perFile ? `${body.slice(0, perFile)}\n…` : body)
  }

  const fs = await import('node:fs/promises')
  const out: string[] = [`${files.length} arquivos alterados. Para cada um: tipo, caminho, (+adições -remoções) e trecho das linhas alteradas.`]
  for (const f of files) {
    out.push('', `### [${f.kind}] ${f.path}${f.origPath ? ` (antes: ${f.origPath})` : ''} ${counts.get(f.path) ?? ''}`.trimEnd())
    if (f.kind === 'untracked') {
      try {
        const content = (await fs.readFile(path.join(root, f.path), 'utf8')).slice(0, perFile)
        out.push(/\0/.test(content) ? '(binário)' : content)
      } catch {
        out.push('(não foi possível ler)')
      }
    } else {
      const c = changes.get(f.path)
      if (c) out.push(c)
    }
  }
  const text = out.join('\n')
  return text.length > budget * 1.3 ? `${text.slice(0, budget * 1.3)}\n… (contexto truncado)` : text
}

function splitPatch(patch: string): string[] {
  if (!patch) return []
  return patch.split(/^(?=diff --git )/m).filter(Boolean)
}
