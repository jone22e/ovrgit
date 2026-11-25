# Extensão Ovseer para Chrome

Os arquivos da extensão acompanham o instalador e as atualizações do Ovseer, no macOS e no Windows. Ao iniciar, o aplicativo mantém uma cópia atualizada numa pasta fixa dos seus dados. Não é necessário baixar a extensão separadamente.

O guia só abre quando você pedir, em **Configurações → Agentes → Extensão do Chrome → Instalar / ver instruções**.

1. No guia do Ovseer, clique em **Abrir pasta** ou **Copiar caminho** para localizar a extensão.
2. No Chrome, abra `chrome://extensions`, ative **Modo do desenvolvedor** e clique em **Carregar sem compactação**. No seletor do macOS, pressione **Command + Shift + G** para abrir **Ir para a pasta**, cole o caminho copiado, pressione **Enter** e clique em **Selecionar**. No Windows, cole o caminho na barra de endereço do seletor, pressione **Enter** e confirme a pasta. Escolha a pasta `chrome-extension` que contém `manifest.json`.
3. Mantenha o Ovseer aberto neste computador. A extensão se conecta automaticamente, sem copiar códigos ou configurar endereços. Se abrir o Chrome antes do aplicativo, ela continua tentando em segundo plano, sem clicar em um botão. Fixe e abra a extensão na barra de ferramentas para conferir “Conectado ao aplicativo”.
4. Ao executar uma tarefa no navegador, o agente abre e controla a própria aba diretamente, sem escolher conversa ou aba no popup. A faixa na página identifica quem está trabalhando; o popup permite acompanhar e interromper.

Cada conversa mantém suas próprias abas. Uma aba não pode ser controlada por duas conversas ao mesmo tempo. Quando o usuário pedir uma aba existente, o agente pode selecioná-la pelo identificador real retornado pelas ferramentas. Abas internas do Chrome, arquivos locais e páginas de extensões não são aceitas; uma aba vazia pode ser aberta antes de navegar.

**Interromper**, na página ou no popup, bloqueia a conversa e desconecta o depurador das suas abas. O botão de cancelar da faixa de depuração do Chrome também bloqueia o controle. Para continuar, clique em **Retomar** no popup. Fechar uma aba normalmente não interrompe as outras abas da conversa.

O acesso usa o perfil já aberto no Chrome, incluindo seus logins. A extensão comunica-se somente com o aplicativo local por uma conexão autenticada, preparada automaticamente pelo Ovseer na pasta da extensão. Os agentes continuam respeitando as instruções do usuário sobre quando usar o navegador. Se desconectar pelo popup, a conexão fica pausada até clicar em **Conectar ao Ovseer**; conversas interrompidas ficam bloqueadas até clicar em **Retomar**.

Claude e Codex recebem ferramentas MCP. Antigravity recebe uma API local com a mesma lista de ferramentas. Modelos do Ollama que suportam ferramentas recebem as chamadas diretamente. A extensão não precisa do Claude in Chrome nem do Playwright MCP.

Após uma atualização que altere a extensão, os arquivos da mesma pasta já estarão atualizados. Em `chrome://extensions`, clique em **Recarregar** (seta circular) no cartão do Ovseer. Não é necessário remover nem escolher outra pasta.

Esta pasta é o código-fonte da extensão. A instalação usa uma cópia nos dados do aplicativo. O carregamento local segue o [guia oficial do Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world). A distribuição pela Chrome Web Store exige uma publicação separada.
