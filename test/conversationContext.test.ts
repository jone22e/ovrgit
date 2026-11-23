import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { FileChange } from '../src/shared/types'

const userData = mkdtempSync(path.join(os.tmpdir(), 'ovseer-conversations-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

it('usa pedidos de conversas que alteraram arquivos selecionados, sem confundir repositórios', async () => {
  const dir = path.join(userData, 'agent-history')
  mkdirSync(dir, { recursive: true })
  const item = (id: string, cwd: string) => ({ sessionId: id, cwd, updatedAt: Date.now() })
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: [item('related', '/repo'), item('other', '/outro')] }))
  const turn = (user: string, file: string) => ({
    user, blocks: [{ kind: 'files', paths: [file] }], startedAt: Date.now()
  })
  writeFileSync(path.join(dir, 'related.json'), JSON.stringify({ turns: [
    { user: 'Quero corrigir a cobrança duplicada.', blocks: [] },
    turn('Implemente a correção.', 'src/pagamento.ts')
  ] }))
  writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ turns: [turn('Pedido de outro projeto.', 'src/pagamento.ts')] }))

  const { conversationContext } = await import('../src/main/agentHistory')
  const files: FileChange[] = [{ path: 'src/pagamento.ts', kind: 'modified', staged: false, unstaged: true }]
  const context = conversationContext('/repo', files)
  expect(context).toContain('Quero corrigir a cobrança duplicada.')
  expect(context).toContain('Implemente a correção.')
  expect(context).toContain('src/pagamento.ts')
  expect(context).not.toContain('Pedido de outro projeto.')
  expect(conversationContext('/repo', [{ ...files[0], path: 'src/sem-relacao.ts' }])).toBe('')
})
