# Ovseer

Git client para macOS e Windows que entende o que você fez. Em vez de uma lista de arquivos alterados, a IA agrupa
as mudanças por assunto, escreve as mensagens e divide o trabalho em commits. O dia a dia cabe em quatro botões:
**Commit**, **Criar Feature**, **Pull** e **Push**.

O app usa o Git instalado na máquina e as assinaturas de IA que você já tem (Claude, ChatGPT, Antigravity) ou um
modelo local pelo Ollama.

## Funcionalidades

### Alterações e commits

- Lista de alterações em árvore ou lista, com diff lado a lado.
- **Analisar com IA**: agrupa os arquivos por mudança funcional e propõe um plano com vários commits, cada um com
  sua mensagem.
- Mensagem de commit gerada pela IA a partir dos arquivos selecionados.
- Commit parcial: escolha só alguns trechos de um arquivo; o resto continua na lista.
- Salvar e enviar em um passo.
- Checagem rápida antes de salvar, sem IA: chaves e senhas esquecidas no código, `console.log` e afins.
- Revisão das alterações com IA.

### Branches e fluxo de trabalho

- **Criar Feature**: move os commits locais da `main` para uma branch nova, envia ao servidor e restaura a `main`,
  com cópia de segurança automática antes.
- Troca de branch levando as alterações junto ou guardando para quando você voltar.
- Pull com opção de guardar as alterações locais antes.
- Push que configura o upstream sozinho.
- Limpeza de branches já incorporadas e de cópias de segurança antigas.
- Histórico de commits com explicação de cada versão em linguagem simples.

### Rede de segurança

- Descartar manda as alterações para uma lixeira, de onde dá para recuperar.
- Desfazer o último commit e editar a última mensagem, enquanto não foram enviados.
- Operações que escrevem no repositório rodam uma de cada vez.

### Conflitos e merge

- Aviso de merge em andamento, com continuar ou abortar.
- Resolução por arquivo: ficar com a sua versão, com a do servidor, ou pedir uma proposta à IA.
- Abrir o projeto no VS Code ou no Cursor.

### GitHub

- Clonar repositórios da sua conta.
- Publicar um projeto local no GitHub, público ou privado, ou em qualquer URL.
- Criar Pull Request com título e descrição escritos pela IA.
- Acompanhar o PR da branch atual e fazer o merge pelo app.

### Agentes de IA

- Janela própria para conversar com Claude Code, Codex (ChatGPT) e Antigravity, dentro da pasta do projeto.
- Escolha de modelo e esforço por conversa.
- Modos de permissão, incluindo o modo Plano: o agente apresenta um plano para leitura e aprovação antes de
  executar.
- Perguntas do agente viram cartões com opções.
- Anexos: arquivos, imagens e conteúdo colado.
- Enviar uma mensagem com o agente trabalhando, para redirecionar no meio da tarefa.
- Histórico de conversas por repositório ou de todos, com fixação, busca e retomada.
- Grid para posicionar várias janelas de agente na tela.
- Instruções personalizadas que valem para todos os agentes.
- Indicador dos agentes abertos pelo Ovseer que estão trabalhando, com aviso quando terminam.
- Indicador de consumo das assinaturas.

### Tarefas (Ovseer)

- Login na plataforma Ovseer pelo navegador.
- Painel de tarefas do workspace, atualizado em tempo real.
- Criar tarefa com plano, responsável, prioridade, prazo e explicação gravada em áudio.
- Começar uma tarefa já cria a branch dela.
- Commits vinculados às tarefas.
- Entrega da tarefa com relatório gerado pela IA: o que foi planejado e o que foi feito.

### Terminal

- Terminal integrado com abas, na pasta do projeto.
- Conexões SSH salvas, com importação do `~/.ssh/config` e de planilhas CSV.
- Comandos salvos (snippets).
- Fonte, peso e tamanho configuráveis.

### Aparência

- Tema padrão que segue o modo claro/escuro do sistema.
- Temas Dracula, One Dark Pro, Tokyo Night, Monokai, Nord, GitHub Dark e GitHub Light.
- Temas com nome de mapa do Counter-Strike: Dust2 (tons de arenito) e Mirage (paleta do Ayu Mirage), os dois escuros.

### Atualização automática

- O app procura versões novas ao abrir e a cada 4 horas, baixa em segundo plano e instala ao reiniciar.
- Dá para desligar ou verificar na hora em Configurações → Geral.

## Provedores de IA

| Provedor | Como conecta |
|---|---|
| Claude | Sua assinatura, pelo Claude Code |
| ChatGPT | Sua assinatura, pelo Codex CLI |
| Antigravity | Sua conta Google, pelo Antigravity CLI |
| Ollama | Modelo local; nada sai da máquina |
| Sem IA | Agrupa as alterações por pasta |

## Atalhos

| Ação | Atalho |
|---|---|
| Trocar projeto | `Cmd/Ctrl + P` |
| Abrir pasta | `Cmd/Ctrl + O` |
| Atualizar | `Cmd/Ctrl + R` |
| Configurações | `Cmd/Ctrl + ,` |
| Novo agente igual ao último | `Cmd/Ctrl + Shift + N` |
| Analisar com IA | `Cmd/Ctrl + I` |
| Commit | `Cmd/Ctrl + Enter` |
| Criar Feature | `Cmd/Ctrl + Shift + F` |
| Pull | `Cmd/Ctrl + Shift + L` |
| Push | `Cmd/Ctrl + Shift + P` |
| Mostrar diff | `Cmd/Ctrl + D` |
| Mostrar terminal | ``Ctrl + ` `` |

## Instalação

Baixe o instalador da versão mais recente em
[Releases](https://github.com/jone22e/ovrgit/releases/latest): `.dmg` no macOS (arm64 para Apple Silicon, o outro
para Intel) ou `.exe` no Windows.

Requisitos: Git instalado. Para as funções do GitHub, o [GitHub CLI](https://cli.github.com) com login feito.

## Desenvolvimento

```bash
npm install
npm run dev
```

| Comando | O que faz |
|---|---|
| `npm run dev` | Abre o app em modo de desenvolvimento |
| `npm run typecheck` | Checagem de tipos |
| `npm test` | Testes |
| `make build-mac` | Gera o instalador local, sem assinar |
| `make update` | Sobe a versão e publica (ver [RELEASE.md](RELEASE.md)) |

### Estrutura

| Pasta | Conteúdo |
|---|---|
| `src/main` | Processo principal: Git, IA, agentes, terminal, integrações |
| `src/preload` | Ponte entre o processo principal e a interface |
| `src/renderer` | Interface em Vue 3 |
| `src/shared` | Tipos e funções usados pelos dois lados |
| `test` | Testes |

Feito com Electron, Vue 3 e TypeScript.

## Licença

MIT
