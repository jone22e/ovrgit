/**
 * "O que o agente está fazendo agora", em português claro, a partir da ferramenta em execução. Os títulos das
 * ferramentas ficam no passado na transcrição ("Rodou comando", "Leu"); aqui viram presente ("Rodando os testes",
 * "Lendo arquivo.ts") e comandos de shell são traduzidos para o que significam, em vez de mostrar a linha crua.
 */

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** Primeiro argumento que parece um caminho de arquivo (tem extensão ou barra) */
function firstPath(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-') && /[\\/]|\.[a-z0-9]{1,6}$/i.test(a) && !/^\d+,\d+p$/.test(a))
}
/** Primeiro argumento entre aspas (o termo de busca de rg/grep) */
function quoted(cmd: string): string | undefined {
  const m = cmd.match(/"([^"]{1,60})"|'([^']{1,60})'/)
  return m ? (m[1] ?? m[2]) : undefined
}
const short = (s: string, max = 48) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** Um comando de shell → o que ele faz, em português. Comandos encadeados (&&, |, ;) são descritos pelo primeiro. */
export function describeCommand(raw: string): string {
  const cmd = raw.trim().replace(/^\s*(cd\s+\S+\s*(&&|;)\s*)+/, '')
  const first = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? cmd
  const args = first.split(/\s+/).filter(Boolean)
  const bin = base(args[0] ?? '')
  const rest = args.slice(1)
  const tail = () => {
    const p = firstPath(rest)
    return p ? ` ${base(p)}` : ''
  }
  switch (bin) {
    case 'rg':
    case 'grep':
    case 'ag':
    case 'ack': {
      const q = quoted(first) ?? rest.find((a) => !a.startsWith('-'))
      return q ? `Buscando no código: ${short(q, 40)}` : 'Buscando no código'
    }
    case 'sed':
    case 'cat':
    case 'head':
    case 'tail':
    case 'nl':
    case 'less':
    case 'bat':
      return `Lendo${tail() || ' arquivo'}`
    case 'ls':
    case 'find':
    case 'tree':
    case 'fd':
      return 'Listando arquivos'
    case 'git': {
      const sub = rest.find((a) => !a.startsWith('-')) ?? ''
      const GIT: Record<string, string> = {
        status: 'Conferindo o estado do git', diff: 'Conferindo as alterações', log: 'Lendo o histórico do git', add: 'Preparando arquivos para o commit',
        commit: 'Fazendo commit', push: 'Enviando ao servidor', pull: 'Baixando do servidor', fetch: 'Baixando do servidor', checkout: 'Trocando de branch',
        switch: 'Trocando de branch', branch: 'Conferindo as branches', stash: 'Guardando alterações', merge: 'Fazendo merge', rebase: 'Fazendo rebase', show: 'Lendo um commit', blame: 'Conferindo a autoria'
      }
      return GIT[sub] ?? 'Usando o git'
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const sub = rest[0] === 'run' ? rest[1] : rest[0]
      if (/^(i|install|add|ci)$/.test(sub ?? '')) return 'Instalando dependências'
      if (/test|vitest|jest/.test(sub ?? '')) return 'Rodando os testes'
      if (/typecheck|tsc|lint/.test(sub ?? '')) return `Rodando o ${/lint/.test(sub!) ? 'lint' : 'typecheck'}`
      if (/build|dist/.test(sub ?? '')) return 'Gerando o build'
      if (/dev|start/.test(sub ?? '')) return 'Subindo o app'
      return sub ? `Rodando ${bin} ${sub}` : `Rodando ${bin}`
    }
    case 'npx':
    case 'pnpx':
    case 'bunx': {
      const tool = rest[0] ?? ''
      if (/vitest|jest|mocha/.test(tool)) return 'Rodando os testes'
      if (/tsc|vue-tsc/.test(tool)) return 'Rodando o typecheck'
      if (/eslint|prettier|biome/.test(tool)) return 'Rodando o lint'
      if (/vite|electron/.test(tool)) return 'Subindo o app'
      return `Rodando ${tool || bin}`
    }
    case 'vitest':
    case 'jest':
    case 'pytest':
    case 'mocha':
      return 'Rodando os testes'
    case 'tsc':
    case 'vue-tsc':
      return 'Rodando o typecheck'
    case 'eslint':
    case 'prettier':
    case 'biome':
      return 'Rodando o lint'
    case 'node':
    case 'python':
    case 'python3':
    case 'ruby':
    case 'php':
    case 'tsx':
    case 'ts-node':
    case 'deno':
      return rest.some((a) => /^(-e|--eval|--input-type|-c)$/.test(a)) ? 'Rodando um trecho de código' : `Rodando${tail() || ' script'}`
    case 'mkdir':
      return 'Criando pasta'
    case 'touch':
      return `Criando${tail() || ' arquivo'}`
    case 'rm':
    case 'rmdir':
      return 'Removendo arquivos'
    case 'mv':
      return 'Movendo arquivos'
    case 'cp':
      return 'Copiando arquivos'
    case 'curl':
    case 'wget':
    case 'http':
    case 'httpie':
      return 'Chamando uma URL'
    case 'docker':
    case 'docker-compose':
      return 'Usando o Docker'
    case 'make':
      return rest[0] ? `Rodando make ${rest[0]}` : 'Rodando make'
    case 'echo':
    case 'printf':
    case 'wc':
    case 'sort':
    case 'uniq':
    case 'cut':
    case 'awk':
    case 'jq':
      return 'Processando texto'
    case 'which':
    case 'env':
    case 'pwd':
    case 'whoami':
    case 'uname':
      return 'Conferindo o ambiente'
    case 'chmod':
    case 'chown':
      return 'Ajustando permissões'
    case 'ssh':
    case 'scp':
    case 'rsync':
      return 'Acessando um servidor'
    case 'gh':
      return 'Usando o GitHub'
    case 'open':
    case 'xdg-open':
      return 'Abrindo algo'
    default:
      return bin ? `Rodando ${short(bin, 24)}` : 'Rodando comando'
  }
}

/** Ferramenta em execução → "o que está fazendo agora", curto e em português. */
export function nowLabel(tool: { name?: string; title: string; detail?: string }): string {
  const d = tool.detail?.trim() ?? ''
  switch (tool.title) {
    case 'Rodou comando':
      return d ? describeCommand(d) : 'Rodando comando'
    case 'Leu':
      return d ? `Lendo ${base(d)}` : 'Lendo arquivos'
    case 'Editou':
      return d ? `Editando ${base(d)}` : 'Editando arquivos'
    case 'Escreveu':
      return d ? `Escrevendo ${base(d)}` : 'Escrevendo arquivo'
    case 'Buscou':
      return d ? `Buscando no código: ${short(d, 40)}` : 'Buscando no código'
    case 'Consultou a web':
    case 'Pesquisou na web':
      return 'Pesquisando na web'
    case 'Subagente':
      return d ? `Subagente: ${short(d, 48)}` : 'Delegando a um subagente'
    case 'Atualizou a lista de tarefas':
      return 'Organizando as tarefas'
    case 'Plano pronto':
      return 'Finalizando o plano'
    case 'Entrou no modo plano':
      return 'Planejando'
    default:
      return tool.title
  }
}
