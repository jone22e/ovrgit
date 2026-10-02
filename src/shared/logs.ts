/**
 * Leitura amigável da saída de um serviço ("modo interativo" da janela do terminal): cada linha vira um registro
 * com nível, hora, mensagem e campos extras. Linhas em JSON (pino, winston, bunyan, zap, structlog…) são
 * desmontadas; texto comum tem o nível e a hora reconhecidos quando aparecem.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'none'

export interface LogEntry {
  level: LogLevel
  /** Hora formatada (HH:MM:SS), se a linha trouxer */
  time?: string
  /** Mensagem principal */
  message: string
  /** Campos extras da linha em JSON (sem os já usados) */
  fields?: Record<string, unknown>
  /** Linha original, sem códigos de cor */
  raw: string
  /** Veio de JSON */
  json: boolean
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

const LEVEL_WORDS: Record<string, LogLevel> = {
  trace: 'trace', verbose: 'trace', silly: 'trace',
  debug: 'debug', dbg: 'debug',
  info: 'info', information: 'info', notice: 'info', log: 'info',
  warn: 'warn', warning: 'warn',
  error: 'error', err: 'error', critical: 'error',
  fatal: 'fatal', panic: 'fatal', emerg: 'fatal'
}
/** Níveis numéricos do pino/bunyan */
const LEVEL_NUMBERS: [number, LogLevel][] = [[60, 'fatal'], [50, 'error'], [40, 'warn'], [30, 'info'], [20, 'debug'], [0, 'trace']]

function levelOf(v: unknown): LogLevel | undefined {
  if (typeof v === 'number') return LEVEL_NUMBERS.find(([n]) => v >= n)?.[1]
  if (typeof v === 'string') return LEVEL_WORDS[v.toLowerCase()]
  return undefined
}

/** "HH:MM:SS" a partir de epoch (ms ou s), ISO ou já no formato de hora */
export function formatTime(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN
    if (!Number.isFinite(ms)) return undefined
    return clock(new Date(ms))
  }
  if (typeof v === 'string') {
    const t = v.trim()
    const hm = /^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{1,2}:\d{2}:\d{2})(?:[.,]\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?$/.exec(t)
    if (hm) {
      // com fuso: converte para a hora local; só hora: usa como está
      if (/\d{4}-\d{2}-\d{2}/.test(t) && /(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
        const d = new Date(t.replace(' ', 'T').replace(/\s(?=[+-]\d{2}:?\d{2}$)/, ''))
        if (!Number.isNaN(d.getTime())) return clock(d)
      }
      return hm[1].padStart(8, '0')
    }
    if (/^\d{10,13}$/.test(t)) return formatTime(Number(t))
    const d = new Date(t)
    if (!Number.isNaN(d.getTime()) && /\d{4}/.test(t)) return clock(d)
  }
  return undefined
}
const clock = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')

const LEVEL_KEYS = ['level', 'severity', 'lvl', 'loglevel', 'log_level', '@level']
const TIME_KEYS = ['time', 'timestamp', 'ts', '@timestamp', 'datetime', 'date', 't']
const MSG_KEYS = ['msg', 'message', 'event', 'error_message', 'error', 'text', 'log']

export function parseLogLine(line: string): LogEntry {
  const raw = stripAnsi(line).replace(/\r$/, '')
  const t = raw.trim()
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return fromJson(obj, raw)
    } catch {
      /* não era JSON válido: segue como texto */
    }
  }
  return fromText(raw)
}

function fromJson(obj: Record<string, unknown>, raw: string): LogEntry {
  const used = new Set<string>()
  let level: LogLevel = 'none'
  for (const k of LEVEL_KEYS) {
    const l = levelOf(obj[k])
    if (l) {
      level = l
      used.add(k)
      break
    }
  }
  let time: string | undefined
  for (const k of TIME_KEYS) {
    const f = formatTime(obj[k])
    if (f) {
      time = f
      used.add(k)
      break
    }
  }
  let message = ''
  for (const k of MSG_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) {
      message = v.trim()
      used.add(k)
      break
    }
  }
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!used.has(k)) fields[k] = v
  if (!message) {
    // sem mensagem: o primeiro campo de texto curto vira o título
    const first = Object.entries(fields).find(([, v]) => typeof v === 'string' && (v as string).length < 120)
    message = first ? `${first[0]}: ${first[1] as string}` : '{…}'
    if (first) delete fields[first[0]]
  }
  return { level, time, message, fields: Object.keys(fields).length ? fields : undefined, raw, json: true }
}

const TEXT_LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|PANIC|CRITICAL)\b/i
const TEXT_TIME = /(?:^|[\s[(])(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?|\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?[AP]M)?)(?=$|[\s\])])/i

function fromText(raw: string): LogEntry {
  let message = raw.trim()
  let level: LogLevel = 'none'
  let time: string | undefined
  const lm = TEXT_LEVEL.exec(message)
  if (lm && lm.index < 60) level = LEVEL_WORDS[lm[1].toLowerCase()] ?? 'none'
  const tm = TEXT_TIME.exec(message)
  if (tm && tm.index < 40) {
    time = formatTime(tm[1].replace(/\s?([AP]M)$/i, ''))
    if (/[AP]M$/i.test(tm[1]) && time) {
      const [h, m, s] = time.split(':').map(Number)
      const pm = /PM$/i.test(tm[1])
      time = [((h % 12) + (pm ? 12 : 0)) % 24, m, s].map((n) => String(n).padStart(2, '0')).join(':')
    }
    // tira a hora e o par de colchetes/parênteses que a envolvia ("[hora] msg" → "msg")
    if (time) message = message.replace(tm[1], '').replace(/^\s*[[(]\s*[\])]\s*/, '').replace(/^\s*[[(]?\s*[\])]\s*/, '').trim()
  }
  // o nível no começo da linha ("INFO:", "[WARN]", "ERROR -") já está na coluna própria: sai da mensagem
  if (level !== 'none') message = message.replace(/^\s*[[(]?\s*(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|PANIC|CRITICAL)\s*[\])]?\s*[:\-–]?\s*/i, '').trim()
  return { level, time, message: message || raw, raw, json: false }
}

// ---------- reinícios (watchers de desenvolvimento) ----------

export interface RestartInfo {
  /** Arquivo cuja alteração causou o reinício, quando a linha diz */
  file?: string
  /** Ferramenta que reiniciou (tsx, nodemon, vite…) */
  tool?: string
}

const RESTART_PATTERNS: RegExp[] = [
  // tsx watch: "[tsx] change in ./src/x.ts Restarting..." / "[tsx] rerunning"
  /\[(tsx)\]\s+(?:change in\s+(\S+)\s+)?(?:restarting|rerunning)/i,
  // nodemon: "[nodemon] restarting due to changes..."
  /\[(nodemon)\]\s+restarting\b/i,
  // ts-node-dev: "[INFO] 11:35:08 Restarting: /path/file.ts has been modified"
  /\brestarting:\s+(\S+)\s+has been modified/i,
  // vite: "vite.config.ts changed, restarting server..." / "[vite] server restarted."
  /(\S+)\s+changed,\s+restarting server/i,
  // node --watch: "Restarting 'src/index.js'"
  /^restarting\s+['"]([^'"]+)['"]/i,
  // genérico: "Restarting...", "restarting due to", "Reiniciando..."
  /\b(?:restarting|reiniciando)\b(?:\.{2,}|…| due to| server| app| process)?/i
]

/** A linha anuncia um reinício do processo (watcher de desenvolvimento)? Devolve o que deu para saber. */
export function restartOf(message: string): RestartInfo | null {
  const m = stripAnsi(message)
  if (m.length > 300) return null
  for (const [i, re] of RESTART_PATTERNS.entries()) {
    const hit = re.exec(m)
    if (!hit) continue
    if (i === 0) return { tool: 'tsx', file: hit[2] }
    if (i === 1) return { tool: 'nodemon' }
    if (i === 2) return { tool: 'ts-node-dev', file: hit[1] }
    if (i === 3) return { tool: 'vite', file: hit[1] }
    if (i === 4) return { tool: 'node', file: hit[1] }
    // genérico: só quando a palavra abre a mensagem ou vem logo depois de uma etiqueta ("[app] Restarting...")
    return /^(?:\[[^\]]+\]\s*|\S+:\s*)?(?:restarting|reiniciando)\b/i.test(m.trim()) ? {} : null
  }
  return null
}

/** A linha indica que o processo voltou a atender (o reinício terminou)? */
export function isReadyLine(message: string): boolean {
  const m = stripAnsi(message)
  return /\b(?:listening|ready in|ready on|server (?:is )?(?:running|started|ready|up)|started (?:server|on|at)|running (?:on|at)|escutando|rodando em|servidor (?:iniciado|rodando|pronto)|compiled successfully|watching for file changes|started successfully|app listening|local:\s+https?:)/i.test(m)
}

