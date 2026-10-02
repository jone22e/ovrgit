import type { AgentEffort, AgentMode, CliProvider, KnownModels, ModelInfo } from './types'

/** Apelidos do Claude Code: seguem sempre a versão mais nova da família. */
export const CLAUDE_ALIASES = [
  { id: 'sonnet', label: 'Sonnet: equilíbrio (recomendado)' },
  { id: 'haiku', label: 'Haiku: mais rápido' },
  { id: 'opus', label: 'Opus: mais capaz' },
  { id: 'fable', label: 'Fable: o mais capaz' }
]

/** Versões exatas por família, da mais nova para a mais antiga. */
export const CLAUDE_FAMILIES: { family: string; models: { id: string; label: string }[] }[] = [
  {
    family: 'Fable',
    models: [
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-fable-5', label: 'Fable 5' }
    ]
  },
  {
    family: 'Opus',
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
      { id: 'claude-opus-4-1-20250805', label: 'Opus 4.1' },
      { id: 'claude-opus-4-20250514', label: 'Opus 4' }
    ]
  },
  {
    family: 'Sonnet',
    models: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
      { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4' }
    ]
  },
  {
    family: 'Haiku',
    models: [{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }]
  }
]

export const CLAUDE_EXACT = CLAUDE_FAMILIES.flatMap((f) => f.models)

/** Provedores de agente, na ordem em que aparecem, com nome de exibição */
export const PROVIDERS: { id: CliProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'ChatGPT' },
  { id: 'agy', label: 'Antigravity' }
]
export const PROVIDER_LABEL: Record<CliProvider, string> = { claude: 'Claude', codex: 'ChatGPT', agy: 'Antigravity' }

/** Catálogo de modelos de um provedor entre os conhecidos (para rótulos) */
export function catalogOf(known: KnownModels | null | undefined, p: CliProvider): ModelInfo[] | undefined {
  if (!known) return undefined
  return p === 'codex' ? known.codexCatalog : p === 'agy' ? known.agyCatalog : undefined
}

/** Níveis de esforço (raciocínio) aceitos por cada CLI, do menor para o maior. */
export const EFFORTS: Record<CliProvider, { id: AgentEffort; label: string }[]> = {
  agy: [
    { id: 'low', label: 'Baixo' },
    { id: 'medium', label: 'Médio' },
    { id: 'high', label: 'Alto' },
    { id: 'max', label: 'Máximo' }
  ],
  claude: [
    { id: 'low', label: 'Baixo' },
    { id: 'medium', label: 'Médio' },
    { id: 'high', label: 'Alto' },
    { id: 'xhigh', label: 'Extra alto' },
    { id: 'max', label: 'Máximo' }
  ],
  codex: [
    { id: 'low', label: 'Baixo' },
    { id: 'medium', label: 'Médio' },
    { id: 'high', label: 'Alto' },
    { id: 'xhigh', label: 'Extra alto' },
    { id: 'max', label: 'Máximo' }
  ]
}

export const EFFORT_LABEL: Record<AgentEffort, string> = {
  minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra'
}

/** Níveis de esforço para um modelo: os que o catálogo informa, senão os padrões do provedor. */
export function effortsFor(provider: CliProvider, model: ModelInfo | undefined): { id: AgentEffort; label: string }[] {
  if (model?.efforts?.length) return model.efforts.map((id) => ({ id, label: EFFORT_LABEL[id] }))
  return EFFORTS[provider]
}

export const DEFAULT_EFFORT: Record<CliProvider, AgentEffort> = { claude: 'high', codex: 'high', agy: 'high' }
/** Modelo inicial de cada provedor (vazio = padrão da conta) */
export const DEFAULT_MODEL: Record<CliProvider, string> = { claude: 'sonnet', codex: '', agy: '' }

/** Modos de permissão do agente, do mais cauteloso para o mais livre. */
export const MODES: { id: AgentMode; label: string; icon: 'clipboard' | 'listChecks' | 'shield' | 'zap'; hint: string }[] = [
  { id: 'plan', label: 'Plano', icon: 'clipboard', hint: 'Só lê o projeto e propõe um plano, sem alterar nada (com acesso total ao sistema, sem sandbox).' },
  { id: 'checklist', label: 'Plano com Checklist', icon: 'listChecks', hint: 'Como o Plano, mas termina com um checklist; ao implementar, cada item é marcado conforme o agente conclui.' },
  { id: 'safe', label: 'Só edições', icon: 'shield', hint: 'Edita arquivos do projeto à vontade; comandos fora do sandbox são negados.' },
  { id: 'full', label: 'Controle Total', icon: 'zap', hint: 'Roda qualquer comando sem perguntar. Use quando confiar na tarefa.' }
]

/** Nome curto e legível de um modelo (ex.: "claude-opus-4-6" → "Opus 4.6", "gpt-5.6-sol" → "GPT-5.6 Sol"). */
export function modelLabel(provider: CliProvider, id: string, catalog?: ModelInfo[]): string {
  if (!id) return 'Padrão da conta'
  const known = catalog?.find((m) => m.id === id)
  if (known) return known.label
  if (provider === 'claude') {
    const alias = CLAUDE_ALIASES.find((m) => m.id === id)
    if (alias) return alias.label.split(':')[0]
    const exact = CLAUDE_EXACT.find((m) => m.id === id)
    if (exact) return exact.label
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
    return id
  }
  if (provider === 'agy') {
    // "gemini-3.8-flash-high" → "Gemini 3.8 Flash (High)"
    const g = /^gemini-([\d.]+)-([a-z]+)(?:-(low|medium|high|max))?$/.exec(id)
    if (g) return `Gemini ${g[1]} ${g[2][0].toUpperCase()}${g[2].slice(1)}${g[3] ? ` (${g[3][0].toUpperCase()}${g[3].slice(1)})` : ''}`
    return id
  }
  return id
    .split('-')
    .map((p) => (/^gpt/i.test(p) ? p.toUpperCase() : /^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ')
    .replace(/^GPT (\S+)/, 'GPT-$1')
}
