/**
 * Arquivos gerados pelo agente (planilhas, relatórios, exportações, PDFs…): uma regra no prompt para que não
 * sejam salvos no meio do código-fonte, e a detecção dos caminhos na resposta para a janela mostrar cada um
 * como um cartão com "Abrir" e "Mostrar na pasta".
 */

/** Extensões que contam como "arquivo gerado para o usuário" (não código do projeto) */
const EXTS = 'xlsx|xlsm|xls|csv|tsv|pdf|docx|doc|odt|ods|pptx|ppt|key|numbers|pages|zip|tar\\.gz|tgz|7z|png|jpe?g|gif|webp|svg|mp4|mov|mp3|wav|ics|sql\\.gz|sqlite|db'

/** Pasta onde o agente deve salvar esses arquivos: tmp/ dentro do projeto (fora do código, ignorada pelo git) */
export function artifactsDir(cwd: string): string {
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}tmp`
}

export function artifactsRule(dir: string): string {
  return `<arquivos_gerados>
Planilhas, relatórios, exportações, PDFs, imagens e outros arquivos produzidos para o usuário (que não fazem
parte do código do projeto) nunca devem ser salvos misturados com o código-fonte: acabam versionados por
engano. Salve-os em ${dir} (crie a pasta se não existir e garanta que "tmp/" esteja no .gitignore do
projeto). Na resposta final, informe o caminho completo do arquivo gerado: o app o mostra como um cartão com
"Abrir".
</arquivos_gerados>`
}

const PATH_RE = new RegExp(
  // caminho absoluto (Unix ou Windows), sem espaços, terminando numa extensão de arquivo gerado
  `(?:file://)?((?:/|~/|[A-Za-z]:\\\\)[^\\s\`"'<>()\\[\\]]*?\\.(?:${EXTS}))(?![\\w.])`,
  'gi'
)

/** Caminhos de arquivos gerados citados num texto (sem repetir, na ordem em que aparecem) */
export function findArtifacts(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/[.,;:!?]+$/, '')
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/** Nome e pasta de um caminho (os dois separadores) */
export function splitPath(p: string): { name: string; dir: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return { name: p.slice(i + 1), dir: p.slice(0, Math.max(i, 0)) }
}

export type ArtifactKind = 'sheet' | 'doc' | 'pdf' | 'image' | 'archive' | 'media' | 'data' | 'file'

export function artifactKind(name: string): ArtifactKind {
  const ext = name.toLowerCase().replace(/^.*\./, '')
  if (/^(xlsx|xlsm|xls|csv|tsv|ods|numbers)$/.test(ext)) return 'sheet'
  if (/^(docx|doc|odt|pages|pptx|ppt|key)$/.test(ext)) return 'doc'
  if (ext === 'pdf') return 'pdf'
  if (/^(png|jpg|jpeg|gif|webp|svg)$/.test(ext)) return 'image'
  if (/^(zip|gz|tgz|7z)$/.test(ext)) return 'archive'
  if (/^(mp4|mov|mp3|wav)$/.test(ext)) return 'media'
  if (/^(sqlite|db|ics)$/.test(ext)) return 'data'
  return 'file'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
