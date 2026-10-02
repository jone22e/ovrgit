import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { designMap, projectMap } from '../src/main/projectMap'

const dirs: string[] = []
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ovseer-map-'))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('identidade visual do projeto', () => {
  it('levanta bibliotecas, arquivos de estilo, variáveis e fontes', () => {
    const dir = project({
      'package.json': JSON.stringify({ dependencies: { vue: '3', 'element-plus': '2' }, devDependencies: { sass: '1', vitest: '1' } }),
      'src/styles/tokens.css': ':root {\n  --cor-primaria: #0f766e;\n  --raio: 8px;\n}\nbody { font-family: Inter, sans-serif; }\n@media (max-width: 600px) { .a { color: red; } }',
      'src/styles/_variables.scss': '$espaco: 12px;\n',
      'src/components/Card.vue': '<template><div /></template>',
      'node_modules/x/theme.css': ':root { --nao: 1; }'
    })
    const d = designMap(dir)
    expect(d).toContain('element-plus, sass')
    expect(d).not.toContain('vitest')
    expect(d).toContain('src/styles/tokens.css')
    expect(d).toContain('--cor-primaria: #0f766e')
    expect(d).toContain('$espaco: 12px')
    expect(d).toContain('Fontes: Inter, sans-serif')
    expect(d).not.toContain('--nao')
    expect(d).not.toContain('@media')
    // e vai dentro do mapa da descoberta
    expect(projectMap(dir)).toContain('Identidade visual existente')
  })

  it('projeto sem estilo: nada a dizer', () => {
    const dir = project({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }), 'src/api/users.ts': '' })
    expect(designMap(dir)).toBe('')
    expect(projectMap(dir)).not.toContain('Identidade visual')
  })
})
