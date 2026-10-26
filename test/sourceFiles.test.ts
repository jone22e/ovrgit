import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, resolveSourcePath } from '../src/main/sourceFiles'

describe('caminho colado na busca de arquivos', () => {
  it('encontra um arquivo ignorado pelo Git, mesmo a partir de outro projeto', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ovseer-source-'))
    const physicalRoot = realpathSync(root)
    try {
      execFileSync('git', ['init', '-q', root])
      writeFileSync(path.join(root, '.gitignore'), 'tmp/\n')
      mkdirSync(path.join(root, 'tmp'))
      const file = path.join(root, 'tmp', 'plano.md')
      writeFileSync(file, '# Plano\n')
      expect(await listSourceFiles(root)).not.toContain('tmp/plano.md')
      expect(await resolveSourcePath(os.homedir(), file)).toEqual({ root: physicalRoot, path: 'tmp/plano.md' })
      expect(await resolveSourcePath(root, 'tmp/plano.md')).toEqual({ root: physicalRoot, path: 'tmp/plano.md' })
      expect(await resolveSourcePath(root, pathToFileURL(file).href)).toEqual({ root: physicalRoot, path: 'tmp/plano.md' })
      expect(await resolveSourcePath(root, 'tmp/ausente.md')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
