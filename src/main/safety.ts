import type { OperationResult, SavedChanges, StepResult } from '../shared/types'
import { currentOperation, git, localCommits, refExists, run, status } from './git'

/**
 * Operações de "voltar atrás", pensadas para quem não conhece Git:
 * - descartar manda as alterações para a Lixeira (um stash), de onde dá para recuperar;
 * - desfazer/editar a última versão só quando ela ainda não foi enviada ao servidor.
 */

const TRASH_PREFIX = 'ovrgit-lixeira:'
const PULL_PREFIX = 'ovrgit: stash antes do pull'

function fail(steps: StepResult[], e: unknown, label?: string): OperationResult {
  const error = e instanceof Error ? e.message : String(e)
  if (label) steps.push({ label, ok: false, detail: error })
  return { ok: false, steps, error }
}

const nul = (files: string[]) => files.join('\0') + '\0'

function stamp() {
  return new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Descarta alterações de arquivos, guardando uma cópia na Lixeira (stash). */
export async function discard(root: string, files: string[]): Promise<OperationResult> {
  const steps: StepResult[] = []
  if (!files.length) return fail(steps, new Error('Nenhum arquivo selecionado.'))
  if (await currentOperation(root)) return fail(steps, new Error('Termine de juntar as versões antes de descartar.'))
  const st = await status(root)
  const wanted = new Set(files)
  const paths = st.files.filter((f) => wanted.has(f.path)).flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]))
  if (!paths.length) return fail(steps, new Error('Esses arquivos não têm alterações.'))
  try {
    if (!st.hasCommits) {
      // repositório sem nenhuma versão: não há para onde voltar, só remove os arquivos novos
      await git(root, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], nul(paths))
      await git(root, ['clean', '-f', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], nul(paths))
    } else {
      await git(
        root,
        ['stash', 'push', '--include-untracked', '-m', `${TRASH_PREFIX} ${files.length} arquivo(s) em ${stamp()}`, '--pathspec-from-file=-', '--pathspec-file-nul'],
        nul(paths)
      )
    }
    steps.push({ label: `${files.length} arquivo(s) descartado(s)`, ok: true, detail: st.hasCommits ? 'Uma cópia ficou na Lixeira (Histórico → Guardadas).' : undefined })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, 'Descartar')
  }
}

async function lastIsLocal(root: string) {
  if (!(await refExists(root, 'HEAD'))) return { ok: false, reason: 'Ainda não há nenhuma versão salva.' }
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
  if (!(await localCommits(root)).has(head)) {
    return { ok: false, reason: 'Essa versão já foi enviada para o servidor, então não dá para desfazer daqui.' }
  }
  const parents = (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length - 1
  if (parents > 1) {
    return { ok: false, reason: 'Essa versão juntou atualizações de outra linha; desfazer por aqui misturaria as mudanças. Peça ajuda para desfazer.' }
  }
  return { ok: true, reason: '' }
}

/** Desfaz a última versão salva: as alterações voltam para a lista, nada se perde. */
export async function undoLastCommit(root: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  if (await currentOperation(root)) return fail(steps, new Error('Termine de juntar as versões antes de desfazer.'))
  const check = await lastIsLocal(root)
  if (!check.ok) return fail(steps, new Error(check.reason))
  try {
    const subject = (await git(root, ['log', '-1', '--pretty=%s'])).trim()
    const hasParent = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD~1'])).code === 0
    if (hasParent) await git(root, ['reset', '--mixed', '-q', 'HEAD~1'])
    else {
      // era a primeira versão do projeto: remove a referência e mantém os arquivos
      await git(root, ['update-ref', '-d', 'HEAD'])
      await git(root, ['reset', '-q'])
    }
    steps.push({ label: `Versão desfeita: ${subject}`, ok: true, detail: 'As alterações voltaram para a lista, prontas para salvar de novo.' })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, 'Desfazer')
  }
}

/** Troca a mensagem da última versão (só se ainda não foi enviada). */
export async function editLastMessage(root: string, message: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  if (!message.trim()) return fail(steps, new Error('Escreva a nova mensagem.'))
  const check = await lastIsLocal(root)
  if (!check.ok) return fail(steps, new Error(check.reason))
  try {
    // --only sem caminhos: muda só a mensagem, sem incluir nada do que estiver marcado
    await git(root, ['commit', '--amend', '--only', '-q', '-m', message.trim()])
    steps.push({ label: 'Mensagem atualizada', ok: true })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, 'Editar mensagem')
  }
}

/** Lista as alterações guardadas (stash), com nomes amigáveis. */
export async function savedChanges(root: string): Promise<SavedChanges[]> {
  const r = await run(root, ['stash', 'list', '--format=%gd%x1f%s%x1f%cI'])
  if (r.code !== 0 || !r.stdout.trim()) return []
  const list: SavedChanges[] = []
  for (const line of r.stdout.trim().split('\n')) {
    const [ref, subject, date] = line.split('\x1f')
    const msg = subject.replace(/^On [^:]+: /, '')
    const kind: SavedChanges['kind'] = msg.startsWith(TRASH_PREFIX) ? 'trash' : msg.startsWith(PULL_PREFIX) ? 'pull' : 'other'
    const label =
      kind === 'trash'
        ? `Descartado: ${msg.slice(TRASH_PREFIX.length).trim()}`
        : kind === 'pull'
          ? 'Guardado automaticamente antes de baixar atualizações'
          : msg.replace(/^WIP on [^:]+: [0-9a-f]+ /, 'Guardado: ')
    const files = await run(root, ['stash', 'show', '--include-untracked', '--name-only', ref])
    list.push({ ref, kind, label, date, files: files.code === 0 ? files.stdout.split('\n').filter(Boolean) : [] })
  }
  return list
}

const validRef = (ref: string) => /^stash@\{\d+\}$/.test(ref)

/** Traz de volta alterações guardadas (e remove da lista se der certo). */
export async function restoreSaved(root: string, ref: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  if (!validRef(ref)) return fail(steps, new Error('Item inválido.'))
  try {
    await git(root, ['stash', 'pop', ref])
    steps.push({ label: 'Alterações recuperadas', ok: true, detail: 'Elas voltaram para a lista de alterações.' })
    return { ok: true, steps }
  } catch (e) {
    const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U'])).trim()
    if (conflicts) {
      steps.push({
        label: 'Recuperado, mas alguns arquivos precisam de uma decisão',
        ok: false,
        detail: `${conflicts}\nO arquivo mudou desde que foi guardado. Escolha qual versão manter na lista.`
      })
      return { ok: false, steps, error: steps[0].detail }
    }
    return fail(steps, e, 'Recuperar')
  }
}

/** Apaga de vez um item guardado. */
export async function dropSaved(root: string, ref: string): Promise<OperationResult> {
  const steps: StepResult[] = []
  if (!validRef(ref)) return fail(steps, new Error('Item inválido.'))
  try {
    await git(root, ['stash', 'drop', ref])
    steps.push({ label: 'Apagado de vez', ok: true })
    return { ok: true, steps }
  } catch (e) {
    return fail(steps, e, 'Apagar')
  }
}
