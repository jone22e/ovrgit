import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshImportCandidate } from '../shared/types'

/**
 * Importar conexões SSH: do ~/.ssh/config (formato padrão, lido por quase todos os clientes)
 * e de CSV/TSV (planilha ou exportação de outros apps).
 */

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

/** Lê os blocos "Host" do ~/.ssh/config (ignora curingas como Host * e Host *.exemplo). */
export function parseSshConfig(text: string): SshImportCandidate[] {
  const out: SshImportCandidate[] = []
  let cur: SshImportCandidate[] = []
  const flush = () => {
    out.push(...cur)
    cur = []
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\S+)\s*=?\s*(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      flush()
      cur = value
        .split(/\s+/)
        .filter((h) => !/[*?!]/.test(h))
        .map((alias) => ({ name: alias, host: alias, user: '', port: 22, identityFile: null, group: null }))
    } else if (key === 'match') {
      flush()
    } else if (cur.length) {
      for (const c of cur) {
        if (key === 'hostname') c.host = value
        else if (key === 'user') c.user = value
        else if (key === 'port') c.port = Number(value) || 22
        else if (key === 'identityfile' && !c.identityFile) c.identityFile = expandHome(value)
      }
    }
  }
  flush()
  return out
}

export function readSshConfig(): SshImportCandidate[] {
  try {
    return parseSshConfig(readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8'))
  } catch {
    return []
  }
}

/** CSV/TSV com cabeçalho. Aceita nomes comuns de coluna (inclusive os usados pelo Termius). */
export function parseCsv(text: string): SshImportCandidate[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const sep = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/;/g)?.length ?? 0) ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ','
  const split = (l: string) => {
    const cells: string[] = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]
      if (ch === '"') {
        if (quoted && l[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = !quoted
      } else if (ch === sep && !quoted) {
        cells.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    cells.push(cur.trim())
    return cells
  }
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z/]/g, ''))
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)))
  const iName = col('label', 'name', 'nome', 'alias')
  const iHost = col('hostname/ip', 'hostname', 'host', 'address', 'endereco', 'ip')
  const iUser = col('username', 'user', 'usuario', 'login')
  const iPort = col('port', 'porta')
  const iGroup = col('groups', 'group', 'grupo', 'folder', 'pasta')
  const iKey = col('identityfile', 'key', 'chave')
  if (iHost < 0) return []
  const out: SshImportCandidate[] = []
  for (const l of lines.slice(1)) {
    const c = split(l)
    const host = c[iHost]?.trim()
    if (!host) continue
    out.push({
      name: (iName >= 0 && c[iName]) || host,
      host,
      user: iUser >= 0 ? c[iUser] ?? '' : '',
      port: iPort >= 0 ? Number(c[iPort]) || 22 : 22,
      identityFile: iKey >= 0 && c[iKey] ? expandHome(c[iKey]) : null,
      group: iGroup >= 0 && c[iGroup] ? c[iGroup].split(/[/|>]/)[0].trim() : null
    })
  }
  return out
}
