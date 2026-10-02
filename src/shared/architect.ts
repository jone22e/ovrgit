/**
 * Modo Arquiteto: descoberta → conceito → arquitetura → execução, com aprovação em cada etapa.
 *
 * 1. Descoberta: uma primeira interpretação do pedido, rápida (modelo rápido, esforço baixo, mapa do projeto
 *    pronto e poucas leituras), num resumo curto de formato fixo.
 * 2. Conceito visual (se houver interface): um mockup em HTML, feito num painel próprio da janela e por uma IA
 *    que pode ser outra; o usuário pede revisões e aprova uma versão.
 * 3. Plano avançado: o plano completo com checklist, a partir do resumo e do conceito aprovados.
 * 4. Execução: implementa marcando o checklist.
 *
 * As etapas 3 e 4 são o "Plano com Checklist"; aqui ficam os textos das etapas 1 a 3 e o trato do HTML do conceito.
 */

import { CHECKLIST_FORMAT } from './checklist'

export type ArchPhase = 'discovery' | 'concept' | 'plan' | 'execute'

export const ARCH_PHASES: { id: ArchPhase; label: string }[] = [
  { id: 'discovery', label: 'Descoberta' },
  { id: 'concept', label: 'Conceito' },
  { id: 'plan', label: 'Plano' },
  { id: 'execute', label: 'Execução' }
]

/** Uma versão do conceito visual */
export interface DesignVersion {
  html: string
  /** O que o usuário pediu nesta revisão (vazio na primeira) */
  note: string
  at: number
}

/** Estado do Modo Arquiteto de uma conversa (fica na vez da descoberta e vai junto na transcrição) */
export interface ArchState {
  phase: ArchPhase
  /** O pedido envolve interface? (marcador da descoberta); indefinido se o agente não disse */
  hasUi?: boolean
  /** Resumo aprovado na descoberta */
  brief?: string
  design?: {
    provider: 'claude' | 'codex' | 'agy'
    model: string
    effort: string
    versions: DesignVersion[]
    /** Versão em exibição */
    current: number
    /** Versão aprovada (índice), ou 'skipped' se o conceito foi pulado */
    approved?: number | 'skipped'
    /** Arquivo onde o conceito aprovado foi salvo, para o plano e a execução lerem */
    file?: string
  }
}

/** Instrução da etapa 1. O mapa do projeto vem logo depois, montado pelo app. */
export const ARCH_DISCOVERY = `Esta é a etapa de DESCOBERTA do Modo Arquiteto: uma primeira interpretação do pedido, para o usuário conferir se você entendeu. Não é o plano de implementação.

Seja rápido (o usuário espera a resposta em menos de um minuto):
- Use o mapa do projeto que acompanha esta mensagem. Abra no máximo 5 arquivos, só os que mudam o entendimento. Sem buscas longas, sem pesquisar na web, sem rodar comandos.
- Não altere nada.

Responda exatamente neste formato, em tópicos de uma linha (no máximo 5 por seção), sem parágrafos, sem detalhes de implementação, sem checklist:

# <título curto do que será feito>
## Objetivo
## Problema
## Funcionalidades
## Usuários
## Telas e módulos
## Decisões e dúvidas
## Riscos

Dúvidas e decisões em aberto vão na seção "Decisões e dúvidas" (não use o formato de perguntas ao usuário nesta etapa).
Na última linha, sozinha, escreva "[interface] sim" se o pedido envolve tela ou front-end, ou "[interface] não" se não envolve.`

const INTERFACE_RE = /^[ \t]*\[interface\][ \t]*(sim|n[aã]o|yes|no)\b[^\n]*$/im

/** O que a descoberta disse sobre haver interface (indefinido se não disse) */
export function hasInterface(text: string): boolean | undefined {
  const m = INTERFACE_RE.exec(text)
  return m ? /^(sim|yes)$/i.test(m[1]) : undefined
}

/** Tira do texto exibido a linha "[interface] sim/não" (é um sinal para o app, não para o usuário) */
export const stripArchMarkers = (text: string) => text.replace(new RegExp(INTERFACE_RE.source + '\\n?', 'gim'), '')

/**
 * Pedido da etapa 3, enviado à conversa principal (no modo Plano com Checklist). `visible` é o que aparece na
 * conversa; `hidden` vai junto para o agente: o que o plano precisa ter, com a exigência do checklist repetida
 * aqui (só nas instruções de sistema ela se perdia atrás do pedido de "plano completo").
 */
export function archPlanRequest(conceptFile?: string): { visible: string; hidden: string } {
  return {
    visible: conceptFile
      ? `Entendimento e conceito visual aprovados (${conceptFile}). Faça o plano completo.`
      : 'Entendimento aprovado. Faça o plano completo.',
    hidden: `<modo_arquiteto etapa="plano">
Esta é a etapa de PLANEJAMENTO AVANÇADO do Modo Arquiteto. O entendimento acima está aprovado.${
      conceptFile ? ` O conceito visual aprovado está em ${conceptFile}: leia esse arquivo; as telas implementadas devem seguir esse layout.` : ''
    }
Explore o código o quanto for preciso e entregue o plano completo de implementação: arquitetura, arquivos a criar e alterar, modelo de dados, fluxos, casos de borda e testes.
${CHECKLIST_FORMAT}
</modo_arquiteto>`
  }
}

/** Regras fixas do conceito visual, para a IA do design */
export const DESIGN_RULES = `Você é o designer do Modo Arquiteto. Sua tarefa é desenhar o CONCEITO VISUAL do que foi pedido: um mockup navegável só com os olhos, para o usuário aprovar o layout antes de qualquer código.

Regras do mockup:
- Um único documento HTML completo e autossuficiente: CSS dentro de <style>, nenhum arquivo externo (sem fontes, imagens, ícones ou scripts de fora), nenhum JavaScript. Ícones, se precisar, em SVG embutido.
- Conteúdo realista em português do Brasil (nomes, números e textos plausíveis para o domínio), nada de "lorem ipsum".
- Se houver mais de uma tela, coloque cada uma num <section data-tela="Nome da tela">, uma abaixo da outra, cada qual com um título pequeno acima.
- Siga a identidade visual do projeto: você pode ler até 5 arquivos de estilo ou de telas existentes para pegar cores, tipografia e componentes. Não altere nenhum arquivo e não rode comandos.
- Layout responsivo: tem que funcionar em largura de desktop e em 390 px.
- Enxuto: mostre o essencial de cada tela (até cerca de 400 linhas no total).

Responda SOMENTE com o HTML, dentro de um único bloco \`\`\`html. Nenhuma explicação antes ou depois.`

/** Pedido de uma versão do conceito: a primeira parte do resumo aprovado; as revisões, do HTML atual e do que ajustar */
export function designRequest(o: { request: string; brief: string; currentHtml?: string; note?: string; history?: string[] }): string {
  const parts = [`Pedido original do usuário:\n${o.request.trim()}`, `Entendimento aprovado:\n${o.brief.trim()}`]
  if (o.currentHtml) {
    const earlier = (o.history ?? []).filter(Boolean)
    if (earlier.length) parts.push(`Revisões já aplicadas nas versões anteriores:\n${earlier.map((n) => `- ${n}`).join('\n')}`)
    parts.push(`Versão atual do conceito:\n\`\`\`html\n${o.currentHtml}\n\`\`\``)
    parts.push(`Revisão pedida agora pelo usuário (aplique só isso e mantenha o resto como está):\n${(o.note ?? '').trim()}`)
    parts.push('Devolva o HTML completo da nova versão.')
  } else {
    parts.push('Desenhe a primeira versão do conceito visual.')
  }
  return parts.join('\n\n')
}

/**
 * HTML do conceito a partir da resposta da IA: o conteúdo do bloco ```html (ainda aberto, enquanto a resposta
 * chega) ou, sem bloco, o trecho que começa em <!doctype ou <html. Vazio se ainda não há nada de HTML.
 */
export function extractHtml(text: string): string {
  const fence = /```(?:html)?[ \t]*\r?\n([\s\S]*?)(?:```|$)/i.exec(text)
  if (fence && /<[a-z!]/i.test(fence[1])) return fence[1].trim()
  const start = text.search(/<!doctype html|<html[\s>]/i)
  return start >= 0 ? text.slice(start).replace(/```\s*$/, '').trim() : ''
}

/**
 * Prepara o HTML do conceito para a prévia: tira o que executa ou navega sozinho e põe no começo do <head> uma
 * política de conteúdo que impede qualquer carga de fora (o documento veio de uma IA e roda isolado, sem scripts).
 */
export function previewDocument(input: string): string {
  // nada que execute ou navegue sozinho: scripts, redirecionamento por meta e <base>
  const html = input
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${csp}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${csp}</head>`)
  return `<!doctype html><html><head>${csp}</head><body>${html}</body></html>`
}

/** Telas do conceito (os <section data-tela="…">), para o seletor de telas do painel */
export function designScreens(html: string): string[] {
  return [...html.matchAll(/<section[^>]*\bdata-tela=["']([^"']+)["']/gi)].map((m) => m[1].trim()).filter(Boolean)
}
