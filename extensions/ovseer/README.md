# Extensão Ovseer para Chrome

1. No Ovseer, abra Configurações → Agentes → Extensão do Chrome e clique em **Preparar extensão**.
2. No Chrome, abra `chrome://extensions`, ative **Modo do desenvolvedor**, clique em **Carregar sem compactação** e selecione a pasta aberta pelo Ovseer.
3. Fixe a extensão Ovseer na barra de ferramentas. Nas configurações do aplicativo, clique em **Copiar conexão**, abra a extensão e cole o código.
4. Quando um agente pedir acesso, abra a extensão, escolha a conversa e a aba e clique em **Autorizar aba**. Peça ao agente para continuar.

Cada conversa recebe seu próprio acesso. Uma aba não pode ser controlada por duas conversas ao mesmo tempo. Abas existentes adicionais exigem autorização na extensão; abas novas criadas pela conversa ficam sob seu controle. Abas internas do Chrome, arquivos locais e páginas de extensões não são aceitas.

**Interromper**, na página ou no popup, revoga o acesso da conversa e desconecta o depurador das suas abas. O botão de cancelar da faixa de depuração do Chrome também revoga o acesso. Para retomar, autorize novamente no popup.

O acesso usa o perfil já aberto no Chrome, incluindo seus logins. A extensão comunica-se somente com o aplicativo local por uma conexão autenticada. O código de conexão é privado e não deve ser compartilhado. Ao reiniciar o Chrome, o worker ou o aplicativo, as abas precisam ser autorizadas novamente. Se a porta local mudar, copie a conexão novamente.

Claude e Codex recebem ferramentas MCP. Antigravity recebe uma API local com a mesma lista de ferramentas. Modelos do Ollama que suportam ferramentas recebem as chamadas diretamente. A extensão não precisa do Claude in Chrome nem do Playwright MCP.

Esta pasta é o código-fonte da extensão. A instalação local usa uma cópia em dados do aplicativo; atualize/recarregue em `chrome://extensions` após preparar uma versão nova. A distribuição pela Chrome Web Store exige uma publicação separada.
