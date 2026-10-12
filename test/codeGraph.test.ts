import { describe, expect, it } from 'vitest'
import { aliasesFromTsconfig, buildGraph, chunkFiles, chunkPrompt, dedupeCandidates, extractImports, featureGraph, fileDigest, isFeatureFile, isMapFile, parseCandidates, parseReduce, reducePrompt, resolveImport, type ProjectMap } from '../src/shared/codeGraph'

const files = new Set([
  'src/main/index.ts', 'src/main/git.ts', 'src/shared/types.ts', 'src/renderer/src/store.ts', 'src/renderer/src/App.vue',
  'src/renderer/src/components/Icon.vue', 'src/renderer/src/utils/index.ts', 'src/renderer/src/styles.css', 'src/renderer/src/base.css',
  'app/models/user.py', 'app/services/__init__.py', 'app/services/mail.py', 'app/Http/Controllers/UserController.php', 'app/Models/User.php',
  'src/main.rs', 'src/net/mod.rs', 'src/net/http.rs', 'pkg/db/db.go', 'cmd/api/main.go'
])
const r = { files, aliases: { '@shared': 'src/shared', '@': 'src/renderer/src' }, goModule: 'example.com/app' }

describe('mapa do projeto: imports', () => {
  it('JS/TS: import, export from, require, import() e tipos', () => {
    const text = `
import { a } from './git'
import type { T } from '@shared/types'
export * from "../shared/types"
const x = require('./git.js')
const lazy = () => import('@/store')
import 'vue'
`
    expect(extractImports(text, 'src/main/index.ts').sort()).toEqual(['./git', '@shared/types', '../shared/types', './git.js', '@/store', 'vue'].sort())
  })
  it('Vue: o script do componente', () => {
    expect(extractImports(`<script setup lang="ts">\nimport Icon from './components/Icon.vue'\n</script>`, 'src/renderer/src/App.vue')).toEqual(['./components/Icon.vue'])
  })
  it('CSS: @import e @use', () => {
    expect(extractImports(`@import './base.css';\n@use "sass:math";`, 'src/renderer/src/styles.css')).toEqual(['./base.css', 'sass:math'])
  })
  it('Python, PHP, Rust e Go', () => {
    expect(extractImports(`from app.models import user\nimport os, app.services.mail\nfrom . import mail`, 'app/services/x.py').sort()).toEqual(['py:app.models', 'py:os', 'py:app.services.mail', 'py:.'].sort())
    expect(extractImports(`<?php\nnamespace App;\nuse App\\Models\\User;\nuse Illuminate\\Http\\Request as R;\nrequire_once __DIR__ . '/helpers.php';`, 'app/x.php')).toEqual(['php:App\\Models\\User', 'php:Illuminate\\Http\\Request', '/helpers.php'])
    expect(extractImports(`mod net;\npub mod cli;\nuse crate::net::http::Client;`, 'src/main.rs')).toEqual(['rs:mod:net', 'rs:mod:cli', 'rs:crate:net::http::Client'])
    expect(extractImports(`import (\n\t"fmt"\n\tdb "example.com/app/pkg/db"\n)`, 'cmd/api/main.go')).toEqual(['go:fmt', 'go:example.com/app/pkg/db'])
  })
})

describe('mapa do projeto: resolução', () => {
  it('relativo, com extensão implícita, index e .js → .ts', () => {
    expect(resolveImport('src/main/index.ts', './git', r)).toBe('src/main/git.ts')
    expect(resolveImport('src/main/index.ts', './git.js', r)).toBe('src/main/git.ts')
    expect(resolveImport('src/main/index.ts', '../shared/types', r)).toBe('src/shared/types.ts')
    expect(resolveImport('src/renderer/src/App.vue', './utils', r)).toBe('src/renderer/src/utils/index.ts')
    expect(resolveImport('src/renderer/src/App.vue', './components/Icon.vue', r)).toBe('src/renderer/src/components/Icon.vue')
  })
  it('apelidos e pacotes externos', () => {
    expect(resolveImport('src/main/index.ts', '@shared/types', r)).toBe('src/shared/types.ts')
    expect(resolveImport('src/main/index.ts', '@/store', r)).toBe('src/renderer/src/store.ts')
    expect(resolveImport('src/main/index.ts', 'vue', r)).toBeNull()
    expect(resolveImport('src/main/index.ts', './nada', r)).toBeNull()
  })
  it('Python: absoluto, relativo e pacote', () => {
    expect(resolveImport('app/services/x.py', 'py:app.models.user', r)).toBe('app/models/user.py')
    expect(resolveImport('app/services/x.py', 'py:app.services', r)).toBe('app/services/__init__.py')
    expect(resolveImport('app/services/x.py', 'py:.mail', r)).toBe('app/services/mail.py')
    expect(resolveImport('app/services/x.py', 'py:os', r)).toBeNull()
  })
  it('PHP (PSR-4), Rust e Go', () => {
    expect(resolveImport('app/x.php', 'php:App\\Models\\User', r)).toBe('app/Models/User.php')
    expect(resolveImport('app/x.php', 'php:Illuminate\\Http\\Request', r)).toBeNull()
    expect(resolveImport('src/main.rs', 'rs:mod:net', r)).toBe('src/net/mod.rs')
    expect(resolveImport('src/main.rs', 'rs:crate:net::http::Client', r)).toBe('src/net/http.rs')
    expect(resolveImport('cmd/api/main.go', 'go:example.com/app/pkg/db', r)).toBe('pkg/db/db.go')
    expect(resolveImport('cmd/api/main.go', 'go:fmt', r)).toBeNull()
  })
  it('apelidos do tsconfig', () => {
    expect(aliasesFromTsconfig({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['src/shared/*'], '@/*': ['src/renderer/src/*'] } } }, files)).toEqual({ '@shared': 'src/shared', '@': 'src/renderer/src' })
    expect(aliasesFromTsconfig(null, files)).toEqual({ '@': 'src' })
  })
  it('arquivos que entram no mapa', () => {
    expect(isMapFile('src/a.ts')).toBe(true)
    expect(isMapFile('package-lock.json')).toBe(false)
    expect(isMapFile('src/env.d.ts')).toBe(false)
    expect(isMapFile('logo.png')).toBe(false)
  })
})

describe('mapa do projeto: grafo dos imports e mapa funcional', () => {
  const texts = new Map([
    ['src/main/index.ts', `import { run } from './git'\nimport type { X } from '@shared/types'\nimport './git'`],
    ['src/main/git.ts', `import type { X } from '@shared/types'`],
    ['src/shared/types.ts', 'export type X = 1'],
    ['src/main/env.ts', '']
  ])
  const map = buildGraph('/p', texts, r)
  it('monta nós e ligações sem repetir', () => {
    expect(map.nodes.map((n) => n.id)).toEqual(['src/main/index.ts', 'src/main/git.ts', 'src/shared/types.ts', 'src/main/env.ts'])
    expect(map.edges).toEqual([
      { from: 'src/main/index.ts', to: 'src/main/git.ts' },
      { from: 'src/main/index.ts', to: 'src/shared/types.ts' },
      { from: 'src/main/git.ts', to: 'src/shared/types.ts' }
    ])
  })
  it('arquivos com funcionalidade, resumo e lotes', () => {
    expect(isFeatureFile('src/fiscal/danfe.ts')).toBe(true)
    expect(isFeatureFile('src/fiscal/danfe.test.ts')).toBe(false)
    expect(isFeatureFile('prisma/migrations/0001_init.sql')).toBe(false)
    expect(isFeatureFile('src/styles.css')).toBe(false)
    const text = ['import x from "y"', '', 'const a = 1', ...Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i}`), "router.get('/nota/:id/pdf', imprimir)", 'export async function enviarEmail() {}'].join('\n')
    const d = fileDigest(text)
    expect(d).toContain('import x from "y"')
    expect(d).toContain("router.get('/nota/:id/pdf', imprimir)")
    expect(d).toContain('export async function enviarEmail')
    expect(d).toContain('…')
    expect(d).not.toContain('const v39')
    const digests = [...Array.from({ length: 30 }, (_, i) => ({ path: `a/f${String(i).padStart(2, '0')}.ts`, digest: 'x' })), { path: 'b/g.ts', digest: 'y' }, { path: 'b/h.ts', digest: 'y' }]
    const chunks = chunkFiles(digests, 24)
    expect(chunks.map((c) => c.length)).toEqual([24, 8])
    expect(chunks[1].map((f) => f.path)).toContain('b/g.ts')
  })
  it('pedido do lote e leitura das candidatas (só caminhos do lote valem)', () => {
    const p = chunkPrompt('ovrgit', 'Git com IA', [{ path: 'src/a.ts', digest: 'export function imprimir() {}' }])
    expect(p).toContain('### src/a.ts')
    expect(p).toContain('FUNCIONALIDADES')
    const c = parseCandidates('```json\n{"features":[{"name":"Imprimir nota fiscal","area":"Nota fiscal","kind":"Action","description":"Gera o PDF","files":["./src/a.ts","src/nada.ts"]},{"name":"Sem arquivo","files":["src/nada.ts"]}]}\n```', 3, new Set(['src/a.ts']))
    expect(c).toEqual([{ id: 'c3-0', name: 'Imprimir nota fiscal', area: 'Nota fiscal', kind: 'action', description: 'Gera o PDF', files: ['src/a.ts'] }])
    expect(parseCandidates('nada', 1, new Set())).toEqual([])
  })
  it('consolidação: junta, cria área que faltou, recupera candidata esquecida e filtra ligações', () => {
    const cands = [
      { id: 'c0-0', name: 'Imprimir nota fiscal', area: 'Nota fiscal', kind: 'action', description: 'Gera o PDF', files: ['a.ts'] },
      { id: 'c1-0', name: 'Imprimir NF', area: 'Fiscal', files: ['b.ts'] },
      { id: 'c1-1', name: 'Enviar nota por email', area: 'Nota fiscal', files: ['c.ts'] },
      { id: 'c2-0', name: 'Login com Google', area: 'Acesso', files: ['d.ts'] }
    ]
    expect(reducePrompt('p', '', cands)).toContain('c1-1 | Enviar nota por email | Nota fiscal')
    const r = parseReduce('{"areas":[{"id":"fiscal","name":"Nota fiscal"}],"features":[{"id":"c0-0","name":"Imprimir nota fiscal","area":"fiscal","merge":["c1-0"]},{"id":"c1-1","area":"fiscal"}],"links":[{"from":"c1-1","to":"c0-0","why":"anexa o PDF"},{"from":"c1-1","to":"c1-0"},{"from":"c0-0","to":"c0-0"}]}', cands)
    expect(r?.areas.map((a) => a.id)).toEqual(['fiscal', 'acesso'])
    expect(r?.features.map((f) => [f.id, f.name, f.area, f.files])).toEqual([
      ['c0-0', 'Imprimir nota fiscal', 'fiscal', ['a.ts', 'b.ts']],
      ['c1-1', 'Enviar nota por email', 'fiscal', ['c.ts']],
      ['c2-0', 'Login com Google', 'acesso', ['d.ts']]
    ])
    expect(r?.links).toEqual([{ from: 'c1-1', to: 'c0-0', why: 'anexa o PDF' }])
    expect(parseReduce('nada', cands)).toBeNull()
    expect(dedupeCandidates([cands[0], { ...cands[0], id: 'c9-0', files: ['z.ts'] }]).map((c) => c.files)).toEqual([['a.ts', 'z.ts']])
  })
  it('gráfico funcional: áreas como núcleos, ligações da IA e as deduzidas dos imports', () => {
    const withAi: ProjectMap = {
      ...map,
      features: {
        provider: 'claude', model: '', at: 0,
        areas: [{ id: 'nucleo', name: 'Núcleo' }, { id: 'git', name: 'Git' }],
        features: [
          { id: 'iniciar', name: 'Iniciar o app', area: 'nucleo', files: ['src/main/index.ts', 'src/main/env.ts'] },
          { id: 'rodar-git', name: 'Rodar comandos git', area: 'git', files: ['src/main/git.ts'] },
          { id: 'tipos', name: 'Tipos compartilhados', area: 'nucleo', files: ['src/shared/types.ts', 'src/main/env.ts'] }
        ],
        links: [{ from: 'iniciar', to: 'rodar-git', why: 'chama ao abrir' }]
      }
    }
    const g = featureGraph(withAi)
    expect(g.nodes.map((n) => [n.id, n.kind, n.degree])).toEqual([
      ['area:nucleo', 'area', 0], ['area:git', 'area', 0],
      ['iniciar', 'feature', 2], ['rodar-git', 'feature', 2], ['tipos', 'feature', 2]
    ])
    expect(g.edges).toEqual([
      { from: 'area:nucleo', to: 'iniciar', kind: 'area' },
      { from: 'area:git', to: 'rodar-git', kind: 'area' },
      { from: 'area:nucleo', to: 'tipos', kind: 'area' },
      { from: 'iniciar', to: 'rodar-git', kind: 'ai', why: 'chama ao abrir' },
      // index.ts → types.ts e git.ts → types.ts (env.ts é de duas funcionalidades: não conta)
      { from: 'iniciar', to: 'tipos', kind: 'import', weight: 1 },
      { from: 'rodar-git', to: 'tipos', kind: 'import', weight: 1 }
    ])
    expect(featureGraph(map).nodes).toEqual([])
  })
})
