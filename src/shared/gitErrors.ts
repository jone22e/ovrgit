/**
 * Traduz mensagens do Git para frases que qualquer pessoa entende.
 * Devolve null quando não reconhece o erro (aí mostramos a primeira linha, sem "fatal:"/"error:").
 */
const RULES: [RegExp, string][] = [
  [
    /non-fast-forward|\(fetch first\)|Updates were rejected because the (tip|remote)/i,
    'O servidor tem versões mais novas que as suas. Clique em "Baixar" para trazê-las e depois em "Enviar".'
  ],
  [
    /protected branch|GH006|pre-receive hook declined/i,
    'Esta linha é protegida no servidor e não aceita envio direto. Use "Criar Feature" e abra um Pull Request.'
  ],
  [
    /GH001|exceeds GitHub's file size limit|Large files detected|file .* is \d+(\.\d+)? MB/i,
    'Algum arquivo é grande demais para o servidor (o GitHub aceita até 100 MB por arquivo).'
  ],
  [
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey\)|Invalid username or (password|token)|The requested URL returned error: 40[13]|permission to .* denied/i,
    'O servidor não reconheceu o seu acesso. Entre na sua conta (no terminal: "gh auth login") ou confira a sua chave SSH.'
  ],
  [
    /Repository not found|does not appear to be a git repository|not found.*repository/i,
    'Não achamos o repositório no servidor, ou a sua conta não tem acesso a ele.'
  ],
  [
    /Could not resolve host|Couldn't connect to server|Connection timed out|Network is unreachable|Failed to connect|Operation timed out|Connection refused/i,
    'Sem conexão com o servidor. Confira a sua internet e tente de novo.'
  ],
  [
    /would be overwritten by (merge|checkout)|Your local changes to the following files would be overwritten/i,
    'Algumas alterações ainda não salvas atrapalham. Salve uma versão ou guarde as alterações antes.'
  ],
  [/index\.lock.*File exists|Unable to create .*\.lock/i, 'Outro programa está usando o Git neste projeto agora. Espere um pouco e tente de novo.'],
  [/nothing to commit|no changes added to commit/i, 'Não há nada para salvar.'],
  [/refusing to merge unrelated histories/i, 'As duas versões não têm nada em comum (históricos diferentes). Peça ajuda a alguém da equipe.']
]

export function friendlyGitError(raw: string): string | null {
  for (const [re, text] of RULES) if (re.test(raw)) return text
  return null
}

/** Primeira linha útil de um erro do Git, sem prefixos técnicos. */
export function firstLine(raw: string): string {
  const line =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^(hint|remote|To |!\s*\[)/.test(l)) ?? raw.trim()
  return line.replace(/^(fatal|error|erro):\s*/i, '')
}
