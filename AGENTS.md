# Ovseer: como trabalhar neste projeto

Instruções para agentes de IA (Claude Code, Codex e outros). O `CLAUDE.md` só aponta para este arquivo.

## Fluxo de trabalho

- Trabalhe direto na `main`.
- Terminou uma mudança: rode `npm run typecheck` e `npm test`, faça o commit e o push para a `main`. Não precisa
  pedir permissão para commit nem push.
- Uma mudança por commit, com mensagem em português no estilo dos commits existentes (`feat: …`, `fix: …`,
  `chore: …`) e um corpo curto quando o título não explica tudo.
- **Nunca publique uma versão por conta própria** (`make update`, `make update-minor`, `make update-major`,
  `make release`). Cada versão publicada chega sozinha a todos os usuários pela atualização automática. Só publique
  quando o usuário pedir explicitamente. O processo está em `RELEASE.md`.

## Pendente para a próxima versão

O que já está na `main` mas ainda não foi publicado é o "pendente para a próxima versão". Não há arquivo com essa
lista: ela sai do git, a partir da última tag de versão.

```bash
git log --oneline $(git describe --tags --abbrev=0)..HEAD
```

Ao terminar cada mudança, feche a resposta ao usuário com a lista atualizada, numerada, um item por mudança,
em linguagem de usuário (o que mudou no app, não o nome do commit). Correções começam com "Correção:".
Exemplo:

```
**Pendente para a próxima versão:**
1. Projetos com alterações no topo do seletor
2. Botão no diff para abrir o arquivo no editor
3. Correção: diferença de arquivo falhava com "An object could not be cloned"
```

Regras da lista:

- Monte a partir do `git log` acima, não da memória da conversa: outras sessões podem ter feito commits.
- Commits que ajustam uma mudança ainda não publicada (ex.: "cor mais discreta" logo depois de "cabeçalho
  tingido") entram no mesmo item, não viram um item novo.
- Commits `chore: versão X` marcam uma publicação: o que veio antes deles já saiu e não entra na lista.
- Quando o usuário pedir para publicar, a lista é o resumo do que a versão leva.
