import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RemoteRepo } from '../shared/types'
import { findBinary, runCli } from './cli'
import { findRoot } from './git'

/** Clonar repositório: lista os repositórios do GitHub (via gh) e copia para a pasta escolhida. */

export async function listGithubRepos(): Promise<RemoteRepo[] | null> {
  const gh = process.env.OVRGIT_GH_BIN || (await findBinary('gh'))
  if (!gh) return null
  const r = await runCli(
    gh,
    ['api', 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'],
    '',
    os.homedir(),
    30_000
  )
  if (r.code !== 0) return null
  try {
    const rows = JSON.parse(r.stdout) as {
      full_name: string
      description: string | null
      private: boolean
      updated_at: string
      clone_url: string
      ssh_url: string
    }[]
    return rows.map((x) => ({
      name: x.full_name,
      description: x.description,
      private: x.private,
      updatedAt: x.updated_at,
      httpsUrl: x.clone_url,
      sshUrl: x.ssh_url
    }))
  } catch {
    return null
  }
}

const VALID_URL = /^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/

/** Nome da pasta a partir do endereço: .../loja.git → loja */
export function folderFromUrl(url: string) {
  return (url.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '').replace(/\.git$/, '')
}

export interface CloneProgress {
  phase: string
  percent: number | null
}

let current: ReturnType<typeof spawn> | null = null

export function cancelClone() {
  current?.kill()
  current = null
}

export async function cloneRepo(
  url: string,
  parent: string,
  name: string,
  onProgress: (p: CloneProgress) => void
): Promise<string> {
  const clean = url.trim()
  if (!VALID_URL.test(clean) || clean.startsWith('-')) throw new Error('Endereço inválido. Use https://… ou git@servidor:dono/repo.git')
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('A pasta de destino não existe.')
  const folder = name.trim()
  if (!folder || /[\\/]|^\.\.?$/.test(folder) || folder.startsWith('-')) throw new Error('Nome de pasta inválido.')
  const target = path.join(parent, folder)
  if (existsSync(target)) throw new Error(`Já existe uma pasta "${folder}" em ${parent}. Escolha outro nome.`)

  const gitBin = (await findBinary('git')) ?? 'git'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(gitBin, ['clone', '--progress', '--', clean, target], {
      cwd: parent,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' }
    })
    current = child
    let tail = ''
    const PHASES: Record<string, string> = {
      'Counting objects': 'Contando arquivos',
      'Compressing objects': 'Preparando no servidor',
      'Receiving objects': 'Baixando',
      'Resolving deltas': 'Montando o projeto',
      'Updating files': 'Criando os arquivos'
    }
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      tail = (tail + text).slice(-2000)
      const parts = text.split(/[\r\n]/).filter(Boolean)
      const last = parts.at(-1) ?? ''
      const m = /(?:remote: )?([A-Z][a-z]+ [a-z]+):\s+(\d+)%/.exec(last)
      if (m) onProgress({ phase: PHASES[m[1]] ?? m[1], percent: Number(m[2]) })
    })
    child.on('error', reject)
    child.on('close', (code) => {
      current = null
      if (code === 0) return resolve()
      const msg = tail.split('\n').filter((l) => /fatal|error|denied|not found|could not/i.test(l)).join(' ').trim()
      reject(
        new Error(
          /Authentication|denied|could not read Username/i.test(tail)
            ? 'Sem permissão para esse repositório. Confira o login (GitHub CLI ou chave SSH).'
            : msg || `A cópia falhou (código ${code}).`
        )
      )
    })
  })
  return findRoot(target)
}

/** Pasta sugerida: a pasta-mãe do projeto mais recente (ex.: ~/Flexi), senão a pasta pessoal. */
export function suggestedParent(recent: string[]): string {
  for (const p of recent) {
    const parent = path.dirname(p)
    if (existsSync(parent)) return parent
  }
  return os.homedir()
}
