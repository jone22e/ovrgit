import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CheckFinding, OperationResult } from '../shared/types'
import { runJsonTask } from './ai'
import { git, run, status } from './git'
import { getSettings } from './settings'

/**
 * Ajudas para quem não conhece Git: checagem antes de salvar (sem IA), revisão com IA,
 * explicação de versões e proposta de resolução de conflitos.
 */

const KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
/** Linha do corpo de uma chave (base64 comprido): distingue uma chave real de um cabeçalho citado em código/teste. */
const KEY_BODY = /^\s*[A-Za-z0-9+/=]{40,}\s*$/
/** Arquivos de teste: console.log e afins costumam ser de propósito (exemplos, saídas) */
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z0-9]+$/i

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'uma chave de acesso da AWS'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'um token do GitHub'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'uma chave de API (sk-…)'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'um token do Slack'],
  [/(api[_-]?key|secret|token|passw(or)?d|senha)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'uma senha ou chave escrita no código']
]
const DEBUG_PATTERNS: [RegExp, string][] = [
  [/\bconsole\.log\(/, 'console.log esquecido'],
  [/^\s*debugger;?\s*$/, 'debugger esquecido'],
  [/\b(var_dump|dd)\(/, 'comando de depuração esquecido'],
  [/\bbinding\.pry\b|\bpdb\.set_trace\(/, 'ponto de parada de depuração esquecido']
]
const RISKY_FILES: [RegExp, string][] = [
  [/(^|\/)\.env(\.|$)/, 'arquivo .env costuma ter senhas e não deve ir para o servidor'],
  [/\.(pem|key|p12|pfx)$/i, 'parece ser um arquivo de chave/certificado'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)$/, 'parece ser uma chave SSH privada']
]
const BIG_FILE = 5 * 1024 * 1024

/** Checagem rápida (sem IA) do que vai ser salvo. */
export async function quickCheck(root: string, files: string[]): Promise<CheckFinding[]> {
  const st = await status(root)
  const wanted = new Set(files)
  const findings: CheckFinding[] = []
  for (const f of st.files.filter((x) => wanted.has(x.path))) {
    for (const [re, why] of RISKY_FILES) {
      if (re.test(f.path) && f.kind !== 'deleted') findings.push({ file: f.path, severity: 'high', message: `Arquivo sensível: ${why}.` })
    }
    if (f.kind === 'deleted') continue
    try {
      const size = statSync(path.join(root, f.path)).size
      if (size > BIG_FILE) findings.push({ file: f.path, severity: 'medium', message: `Arquivo grande (${(size / 1024 / 1024).toFixed(1)} MB): deixa o projeto pesado para todos.` })
    } catch {
      /* sumiu */
    }
    // linhas novas: diff contra a última versão, ou o arquivo inteiro se for novo
    let added: { line: number; text: string }[] = []
    if (f.kind === 'untracked') {
      try {
        const text = readFileSync(path.join(root, f.path), 'utf8')
        if (!text.includes('\0')) added = text.split('\n').slice(0, 5000).map((t, i) => ({ line: i + 1, text: t }))
      } catch {
        /* binário/ilegível */
      }
    } else {
      const d = await run(root, ['diff', '--unified=0', '--no-color', 'HEAD', '--', f.path])
      let n = 0
      for (const l of d.stdout.split('\n')) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
        if (m) n = Number(m[1])
        else if (l.startsWith('+') && !l.startsWith('+++')) added.push({ line: n++, text: l.slice(1) })
      }
    }
    const seen = new Set<string>()
    const isTest = TEST_FILE.test(f.path)
    for (let i = 0; i < added.length; i++) {
      const { line, text } = added[i]
      // chave privada só conta se o corpo vier logo depois (um cabeçalho sozinho é só texto citado)
      if (KEY_HEADER.test(text) && !seen.has('key') && added.slice(i + 1, i + 3).some((a) => KEY_BODY.test(a.text))) {
        seen.add('key')
        findings.push({ file: f.path, line, severity: 'high', message: 'Parece ter uma chave privada. Se for real, não salve: ela ficaria no histórico para sempre.' })
      }
      if (/^(<{7}|>{7}|={7})( |$)/.test(text)) {
        findings.push({ file: f.path, line, severity: 'high', message: 'Sobrou uma marca de conflito (<<<<<<< / >>>>>>>) no arquivo.' })
      }
      for (const [re, what] of SECRET_PATTERNS) {
        if (re.test(text) && !seen.has(what)) {
          seen.add(what)
          findings.push({ file: f.path, line, severity: 'high', message: `Parece ter ${what}. Se for real, não salve: ela ficaria no histórico para sempre.` })
        }
      }
      for (const [re, what] of isTest ? [] : DEBUG_PATTERNS) {
        if (re.test(text) && !seen.has(what)) {
          seen.add(what)
          findings.push({ file: f.path, line, severity: 'low', message: `${what[0].toUpperCase()}${what.slice(1)}.` })
        }
      }
    }
  }
  return findings
}

/** Revisão com IA das alterações selecionadas. */
export async function aiReview(root: string, context: string): Promise<CheckFinding[]> {
  const r = await runJsonTask<{ findings?: { file?: string; line?: number; severity?: string; message?: string }[] }>(
    getSettings(),
    `Você revisa alterações de código antes de serem salvas num repositório Git.
Responda SEMPRE em português do Brasil, em linguagem simples, e SOMENTE com JSON no formato pedido.
Aponte só problemas reais e relevantes: bugs prováveis, dados sensíveis, código esquecido de teste/depuração,
erros de lógica, tratamento de erro faltando em ponto crítico. No máximo 8 itens. Sem elogios.
"severity": high (pode quebrar ou vazar algo), medium (deveria corrigir), low (detalhe).
Se estiver tudo bem, devolva "findings": [].`,
    {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              severity: { type: 'string', enum: ['high', 'medium', 'low'] },
              message: { type: 'string' }
            },
            required: ['file', 'severity', 'message']
          }
        }
      },
      required: ['findings']
    },
    'Revise as alterações abaixo.',
    context
  )
  return (r.findings ?? [])
    .filter((f) => f.message)
    .slice(0, 8)
    .map((f) => ({
      file: String(f.file ?? ''),
      line: Number.isFinite(f.line) ? Number(f.line) : undefined,
      severity: (['high', 'medium', 'low'].includes(String(f.severity)) ? f.severity : 'medium') as CheckFinding['severity'],
      message: String(f.message)
    }))
}

/** Explica uma versão (commit) em linguagem simples. */
export async function explainCommit(root: string, hash: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Versão inválida.')
  const show = await git(root, ['show', '--stat=100', '--patch', '--unified=1', '--no-color', '--format=Título: %s%nAutor: %an%nData: %ad%n%n%b', hash])
  const r = await runJsonTask<{ explanation?: string }>(
    getSettings(),
    `Você explica mudanças de código para alguém que NÃO é programador.
Responda SEMPRE em português do Brasil, SOMENTE com JSON no formato pedido.
Em "explanation": 2 a 5 frases curtas, sem jargão técnico, dizendo o que mudou no sistema e por quê (se der para inferir).
Se ajudar, termine com uma lista curta "- ..." dos pontos principais.`,
    { type: 'object', properties: { explanation: { type: 'string' } }, required: ['explanation'] },
    'Explique esta versão (commit).',
    show.slice(0, 14000)
  )
  return String(r.explanation ?? '').trim()
}

/** Proposta da IA para resolver um arquivo em conflito (não grava nada). */
export async function proposeResolution(root: string, file: string): Promise<{ content: string; explanation: string }> {
  const st = await status(root)
  if (!st.files.some((f) => f.path === file && f.kind === 'conflict')) throw new Error('Esse arquivo não está em conflito.')
  const text = readFileSync(path.join(root, file), 'utf8')
  if (text.length > 60000) throw new Error('Arquivo grande demais para resolver com IA. Resolva no editor.')
  const r = await runJsonTask<{ content?: string; explanation?: string }>(
    getSettings(),
    `Você resolve conflitos de merge do Git.
O arquivo tem blocos entre <<<<<<< (versão local), ======= e >>>>>>> (versão que veio do servidor).
Combine as duas versões preservando a intenção de ambas sempre que possível. Não invente código novo.
Responda SOMENTE com JSON: "content" = o arquivo COMPLETO já resolvido, sem nenhuma marca de conflito;
"explanation" = 1 a 3 frases em português simples dizendo como combinou.`,
    { type: 'object', properties: { content: { type: 'string' }, explanation: { type: 'string' } }, required: ['content', 'explanation'] },
    `Resolva o conflito do arquivo ${file}.`,
    text
  )
  const content = String(r.content ?? '')
  if (!content.trim() || /^(<{7}|>{7}) /m.test(content)) throw new Error('A IA não conseguiu uma proposta limpa. Resolva no editor.')
  return { content, explanation: String(r.explanation ?? '').trim() }
}

/** Grava a versão resolvida e marca o arquivo como resolvido. */
export async function applyResolution(root: string, file: string, content: string): Promise<OperationResult> {
  const st = await status(root)
  if (!st.files.some((f) => f.path === file && f.kind === 'conflict')) {
    return { ok: false, steps: [], error: 'Esse arquivo não está mais em conflito.' }
  }
  if (/^(<{7}|>{7}) /m.test(content)) return { ok: false, steps: [], error: 'O conteúdo ainda tem marcas de conflito.' }
  writeFileSync(path.join(root, file), content)
  await git(root, ['add', '--', file])
  return { ok: true, steps: [{ label: `Conflito resolvido com a IA: ${file}`, ok: true }] }
}

/** Relatório da entrega: compara o plano da tarefa com as versões vinculadas. */
export async function deliveryReport(plan: string, commits: string[]): Promise<{ adherence: 'as_planned' | 'changed'; summary: string }> {
  const r = await runJsonTask<{ adherence?: string; summary?: string }>(
    getSettings(),
    `Você ajuda a preparar o relatório de entrega de uma tarefa.
Compare o PLANO da tarefa com as VERSÕES (commits) feitas. Responda SOMENTE com JSON, em português do Brasil.
"adherence": "as_planned" se o que foi feito corresponde ao plano, ou "changed" se houve mudança de escopo.
"summary": 2 a 5 frases objetivas do que foi entregue e, se mudou, o que mudou em relação ao plano.`,
    {
      type: 'object',
      properties: { adherence: { type: 'string', enum: ['as_planned', 'changed'] }, summary: { type: 'string' } },
      required: ['adherence', 'summary']
    },
    'Compare o plano com o que foi feito.',
    `PLANO:\n${plan.slice(0, 8000)}\n\nVERSÕES:\n${commits.map((c) => `- ${c}`).join('\n').slice(0, 6000)}`
  )
  return { adherence: r.adherence === 'changed' ? 'changed' : 'as_planned', summary: String(r.summary ?? '').trim() }
}
