/**
 * Perguntas ao usuário. Os CLIs em modo headless não têm uma ferramenta de "perguntar ao usuário", então o app
 * combina um formato com o modelo: cada pergunta vai num bloco ```question, com as opções em linhas "- ".
 * A janela tira esses blocos do texto e mostra cartões com botões, uma pergunta de cada vez.
 */

export const QUESTION_FORMAT = `<perguntas_ao_usuario>
Quando precisar de uma decisão ou autorização do usuário para continuar, termine a resposta com as perguntas
neste formato exato (um bloco por pergunta; cada opção numa linha começando com "- "):

\`\`\`question
Você autoriza o deploy desta alteração?
- Sim, autorizo o deploy (recomendado) — a alteração já passou nos testes e não muda o banco
- Não, deixe apenas no código — eu mesmo publico depois
\`\`\`

Regras: no máximo 4 opções por pergunta; a primeira linha é a pergunta; cada opção é um rótulo curto e, depois
de " — ", uma explicação de uma frase (opcional); marque no máximo uma opção com "(recomendado)". O usuário
também pode responder livremente ou pular. Não use o formato para perguntas retóricas nem para listar próximos
passos. As respostas chegam numa mensagem só, numeradas na ordem das perguntas.
</perguntas_ao_usuario>`

export interface AgentOption {
  label: string
  /** Explicação curta, mostrada abaixo do rótulo */
  detail?: string
  recommended?: boolean
}

export interface AgentQuestion {
  text: string
  options: AgentOption[]
}

const FENCE = /```question[ \t]*\r?\n([\s\S]*?)```/g
/** Bloco ainda aberto (a resposta está chegando em pedaços): some do texto até fechar */
const OPEN_FENCE = /```question[ \t]*\r?\n(?:(?!```)[\s\S])*$/

/** Separa o texto do agente das perguntas em blocos ```question (que saem do texto). */
export function splitQuestions(text: string): { text: string; questions: AgentQuestion[] } {
  const questions: AgentQuestion[] = []
  const rest = text
    .replace(FENCE, (_m, body: string) => {
      const q = parseQuestion(body)
      if (q) questions.push(q)
      return ''
    })
    .replace(OPEN_FENCE, '')
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), questions }
}

function parseQuestion(body: string): AgentQuestion | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const ask: string[] = []
  const options: AgentOption[] = []
  for (const l of lines) {
    const m = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)
    if (m) options.push(parseOption(m[1].trim()))
    else if (!options.length) ask.push(l)
  }
  const text = ask.join(' ').trim()
  return text ? { text, options: options.slice(0, 6) } : null
}

const RECOMMENDED = /\s*[(\[]\s*recomendad[ao]\s*[)\]]/i
/** "Rótulo (recomendado) — explicação" → rótulo, marca e explicação separados */
function parseOption(raw: string): AgentOption {
  const [head, ...rest] = raw.split(/\s+[—–]\s+|\s+-\s+/)
  const detail = rest.join(' — ').trim()
  const recommended = RECOMMENDED.test(head) || RECOMMENDED.test(detail)
  const label = head.replace(RECOMMENDED, '').trim() || raw
  const o: AgentOption = { label }
  if (detail) o.detail = detail.replace(RECOMMENDED, '').trim()
  if (recommended) o.recommended = true
  return o
}

/** Mensagem com as respostas: só a resposta quando é uma pergunta; numeradas quando são várias (pulada: "sem resposta"). */
export function formatAnswers(questions: AgentQuestion[], answers: (string | undefined)[]): string {
  if (questions.length === 1) return answers[0] ?? ''
  return `Respostas:\n${questions.map((q, i) => `${i + 1}. ${q.text}\n   → ${answers[i] ?? '(sem resposta)'}`).join('\n')}`
}
