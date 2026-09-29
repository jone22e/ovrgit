# Publicar uma versão do Ovseer

O app se atualiza sozinho. Ele consulta os releases de `jone22e/ovrgit` no GitHub 10 segundos depois de abrir e a
cada 4 horas, baixa a versão nova em segundo plano e instala quando o usuário reinicia ou fecha o app.

Publicar uma versão é rodar um comando:

```bash
make update
```

## Comandos

| Comando | O que faz |
|---|---|
| `make update` | Sobe a versão de correção (0.1.0 → 0.1.1) e publica |
| `make update-minor` | Sobe a versão de funcionalidade (0.1.3 → 0.2.0) e publica |
| `make update-major` | Sobe a versão principal (0.2.1 → 1.0.0) e publica |
| `make update VERSION=1.4.0` | Publica com o número informado |
| `make release` | Publica a versão que já está no `package.json`, sem subir o número |
| `make build-mac` | Gera o instalador local em `dist/`, sem assinar e sem publicar |

## O que o `make update` faz

1. Confere o ambiente: certificado, credencial de notarização, login no GitHub, branch `main` sem alterações
   pendentes e em dia com o servidor.
2. Sobe o número da versão no `package.json`.
3. Roda a checagem de tipos e os testes.
4. Compila para arm64 e x64, assina com o Developer ID e envia para a Apple notarizar.
5. Sobe o DMG, o zip e o `latest-mac.yml` para um release em rascunho no GitHub.
6. Faz o commit `chore: versão X`, cria a tag `vX` e envia para o servidor.
7. Tira o release do rascunho. A partir daí os apps instalados enxergam a versão.

Se algo falhar antes do passo 6, o número da versão volta ao que era e nada fica visível para os usuários.

Leva de 10 a 20 minutos, quase tudo na notarização.

## Antes de publicar

Faça o commit e o push do que vai entrar na versão. O comando se recusa a rodar com alterações pendentes.

## Preparar uma máquina nova (uma vez)

1. **Certificado.** No Xcode, em Settings → Accounts → time C2S Business Ltda → Manage Certificates, clique em `+` e
   escolha **Developer ID Application**. Só o titular da conta consegue criar. O `Apple Distribution` não serve: ele é
   para a App Store.

   ```bash
   security find-identity -v -p codesigning
   ```

   Deve listar `Developer ID Application: C2S Business Ltda (3UG973ND38)`.

2. **Credencial de notarização.** Gere uma senha específica de app em account.apple.com (Sign-In and Security →
   App-Specific Passwords) e guarde no keychain:

   ```bash
   xcrun notarytool store-credentials "ovseer-notary" --apple-id "SEU_APPLE_ID" --team-id 3UG973ND38
   ```

3. **GitHub.** Entre com uma conta que tenha permissão de escrita no repositório:

   ```bash
   gh auth login
   ```

## Conferir se a atualização chegou

Abra o app instalado em uma versão anterior. Em cerca de 10 segundos aparece a barra "Ovseer X está pronto para
instalar". Em Configurações → Geral → Atualização dá para ver a versão instalada e forçar a checagem.

## Windows

O `make update` publica só o macOS. O instalador do Windows precisa ser gerado em uma máquina Windows, na mesma
versão, depois do `make update`:

```bash
git pull
npm ci
GH_TOKEN=<token> npm run release:win
```

Os arquivos entram no mesmo release. No Windows a atualização automática funciona sem certificado, mas o
SmartScreen avisa na primeira instalação.

## Problemas comuns

| Sintoma | Causa |
|---|---|
| `ambiguous (matches "Apple Distribution…")` | Falta o certificado Developer ID Application |
| `Credencial de notarização "ovseer-notary" não encontrada` | O passo 2 da preparação não foi feito nesta máquina |
| O app não acha a versão nova | O release ainda está em rascunho, ou o número não é maior que o instalado |
| "Disponível só no app instalado" nas Configurações | O app está rodando em modo de desenvolvimento (`npm run dev`) |
| A notarização falha | Veja o motivo com `xcrun notarytool log <id> --keychain-profile ovseer-notary` |

## Onde está o código

| Arquivo | Papel |
|---|---|
| `src/main/updater.ts` | Checagem, download e instalação |
| `scripts/release.sh` | Passos do `make update` |
| `package.json` → `build` | Assinatura, notarização e destino da publicação |
| `build/entitlements.mac.plist` | Permissões do app assinado |
