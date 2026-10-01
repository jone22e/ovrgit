import { describe, expect, it } from 'vitest'
import { describeCommand, nowLabel } from '../src/shared/activity'

describe('describeCommand', () => {
  it('traduz busca, leitura e git', () => {
    expect(describeCommand('rg -n -S "vendedor_id.*permissoes" backend/src')).toBe('Buscando no código: vendedor_id.*permissoes')
    expect(describeCommand("sed -n '1,330p' backend/src/produtos/produtoListRoutes.ts")).toBe('Lendo produtoListRoutes.ts')
    expect(describeCommand('nl -ba backend/src/a.ts | sed -n 10,20p')).toBe('Lendo a.ts')
    expect(describeCommand('/usr/bin/git status --short')).toBe('Conferindo o estado do git')
    expect(describeCommand('cd /x && git diff --check && git status')).toBe('Conferindo as alterações')
  })
  it('traduz testes, typecheck, build e scripts', () => {
    expect(describeCommand('npm test')).toBe('Rodando os testes')
    expect(describeCommand('npm run typecheck')).toBe('Rodando o typecheck')
    expect(describeCommand('npx vitest run test/x.test.ts')).toBe('Rodando os testes')
    expect(describeCommand('pnpm build')).toBe('Gerando o build')
    expect(describeCommand("/Users/jone/.nvm/versions/node/v24.15.0/bin/node --input-type=module -e 'x'")).toBe('Rodando um trecho de código')
    expect(describeCommand('node scripts/migrate.ts')).toBe('Rodando migrate.ts')
  })
  it('cai num rótulo genérico para o resto', () => {
    expect(describeCommand('mkdir -p backend/src/produtos')).toBe('Criando pasta')
    expect(describeCommand('foo --bar')).toBe('Rodando foo')
    expect(describeCommand('')).toBe('Rodando comando')
  })
})

describe('nowLabel', () => {
  it('passa os títulos para o presente, com o nome do arquivo', () => {
    expect(nowLabel({ title: 'Leu', detail: '/a/b/App.vue' })).toBe('Lendo App.vue')
    expect(nowLabel({ title: 'Editou', detail: 'src/store.ts' })).toBe('Editando store.ts')
    expect(nowLabel({ title: 'Rodou comando', detail: 'npm test' })).toBe('Rodando os testes')
    expect(nowLabel({ title: 'Consultou a web', detail: 'https://x' })).toBe('Pesquisando na web')
    expect(nowLabel({ title: 'Qualquer coisa' })).toBe('Qualquer coisa')
  })
})
