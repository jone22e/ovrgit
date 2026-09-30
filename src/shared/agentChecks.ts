import type { AgentBlock, AgentChecks } from './types'

/**
 * Verificações que o agente rodou (testes, typecheck, build, deploy), vistas nos comandos das ferramentas.
 * Usadas no gerenciador de agentes (etiquetas dos concluídos) e no resumo do dia.
 */

/** Comando que começa a linha ou vem depois de ; && || | ( (não conta quando é só texto buscado, ex.: rg deploy) */
const CMD = (re: string) => new RegExp(`(^|[;&|(]\\s*)(${re})`, 'm')
const TEST_CMD = CMD(String.raw`(npm|pnpm|yarn|bun)( run)? test\b|npx (vitest|jest)\b|vitest\b|jest\b|pytest\b|python -m pytest\b|node --test\b|go test\b|cargo test\b|phpunit\b`)
const TYPE_CMD = CMD(String.raw`(npx )?(tsc|vue-tsc)\b|(npm|pnpm|yarn|bun)( run)? typecheck\b|mypy\b|pyright\b`)
const BUILD_CMD = CMD(String.raw`(npm|pnpm|yarn|bun)( run)? build\b|(npx )?(vite|next|electron-vite) build\b`)
export const DEPLOY_CMD = CMD(String.raw`(npm|pnpm|yarn|bun) run [\w:-]*deploy|[\w./-]*deploy[\w.-]*\.sh\b|kubectl (apply|rollout)\b|aws ecs update-service\b|fly deploy\b|vercel\b`)

/** Quantos testes passaram, pela saída do comando (vitest, jest, node --test, pytest) */
export function testCount(out: string): number | undefined {
  const m = /Tests?:?\s+(\d+) passed/.exec(out) ?? /# pass (\d+)/.exec(out) ?? /(\d+) passed/.exec(out)
  return m ? Number(m[1]) : undefined
}

/** Verificações de uma resposta do agente; `paths`: arquivos que ela alterou (para saber se faltou o typecheck) */
export function checksOf(blocks: AgentBlock[], paths: string[]): AgentChecks | undefined {
  const out: AgentChecks = {}
  for (const b of blocks) {
    if (b.kind !== 'tool' || b.ok === null) continue
    const cmd = b.detail ?? ''
    if (TEST_CMD.test(cmd)) {
      const n = testCount(b.output ?? '')
      out.tests = { ok: b.ok && (out.tests?.ok ?? true), count: n ?? out.tests?.count }
    }
    if (TYPE_CMD.test(cmd)) out.typecheck = b.ok
    if (BUILD_CMD.test(cmd)) out.build = b.ok
    if (DEPLOY_CMD.test(cmd)) out.deploy = true
  }
  // mexeu em código tipado e não conferiu os tipos
  if (out.typecheck === undefined && paths.some((p) => /\.(ts|tsx|vue|mts|cts)$/.test(p))) out.typecheck = null
  return Object.keys(out).length ? out : undefined
}
