import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const NAMES = ['favicon.svg', 'favicon.png', 'favicon.ico', 'icon.svg', 'icon.png', 'logo.svg', 'logo.png', 'apple-touch-icon.png']

// lugares comuns em projetos web (Vite, Next, CRA, Nuxt, Angular, monorepos)
const DIRS = ['', 'public', 'static', 'assets', 'src', 'src/assets', 'src/app', 'app', 'src/public', 'www', 'web', 'resources']
const PARENTS = ['', 'frontend', 'client', 'web', 'app', 'site', 'apps/web', 'apps/frontend', 'packages/web', 'packages/frontend']

const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
const MAX_BYTES = 256 * 1024
const cache = new Map<string, string | null>()

function candidates(root: string): string[] {
  const out: string[] = []
  const parents = [...PARENTS]
  // monorepos com nomes livres: apps/<qualquer>, packages/<qualquer>
  for (const group of ['apps', 'packages']) {
    try {
      for (const d of readdirSync(path.join(root, group))) parents.push(`${group}/${d}`)
    } catch {
      /* não existe */
    }
  }
  for (const parent of parents) for (const dir of DIRS) for (const n of NAMES) out.push(path.join(root, parent, dir, n))
  return out
}

/** Procura o favicon do projeto e devolve como data URL (ou null). */
export function findFavicon(root: string): string | null {
  if (cache.has(root)) return cache.get(root)!
  let result: string | null = null
  for (const file of candidates(root)) {
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) continue
      const mime = MIME[path.extname(file).toLowerCase()]
      if (!mime) continue
      result = `data:${mime};base64,${readFileSync(file).toString('base64')}`
      break
    } catch {
      /* próximo candidato */
    }
  }
  cache.set(root, result)
  return result
}
