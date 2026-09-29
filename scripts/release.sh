#!/usr/bin/env bash
# Gera e publica uma versão do Ovseer para macOS (ver RELEASE.md).
#   scripts/release.sh patch|minor|major|x.y.z   sobe a versão e publica
#   scripts/release.sh current                   publica a versão que já está no package.json
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
REPO="jone22e/ovrgit"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-ovseer-notary}"

fail() { echo "✗ $1" >&2; exit 1; }
step() { echo; echo "▸ $1"; }

step "Conferindo o ambiente"
[ "$(uname)" = "Darwin" ] || fail "A versão do macOS só pode ser gerada em um Mac."
command -v gh >/dev/null || fail "GitHub CLI não encontrado (brew install gh)."
gh auth status >/dev/null 2>&1 || fail "GitHub CLI sem login (gh auth login)."
security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || fail "Certificado Developer ID Application não encontrado no keychain."
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || fail "Credencial de notarização \"$PROFILE\" não encontrada (ver RELEASE.md)."
[ "$(git branch --show-current)" = "main" ] || fail "Publique a partir da branch main."
[ -z "$(git status --porcelain)" ] || fail "Há alterações não commitadas. Faça o commit antes de publicar."
git fetch --quiet origin main
[ -z "$(git rev-list HEAD..origin/main)" ] || fail "A main local está atrás do servidor. Faça o pull antes."

if [ "$BUMP" != "current" ]; then
  npm version "$BUMP" --no-git-tag-version >/dev/null
  # se algo falhar antes do commit da versão, o número volta ao que era
  trap 'git checkout --quiet package.json package-lock.json; echo "Versão revertida." >&2' ERR
fi
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
if gh release view "$TAG" -R "$REPO" --json isDraft -q .isDraft 2>/dev/null | grep -q false; then
  fail "A versão $VERSION já foi publicada."
fi
echo "Versão: $VERSION"

step "Testes"
npm run typecheck
npm test

# o rascunho já existe antes do envio: arm64 e x64 publicam ao mesmo tempo e cada um criaria o seu
gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 \
  || gh release create "$TAG" -R "$REPO" --draft --title "$VERSION" --notes "" >/dev/null

step "Compilando, assinando e notarizando (a notarização leva alguns minutos)"
APPLE_KEYCHAIN_PROFILE="$PROFILE" GH_TOKEN="$(gh auth token)" npm run release:mac

step "Gravando a versão no Git"
if [ "$BUMP" != "current" ]; then
  git commit --quiet -m "chore: versão $VERSION" package.json package-lock.json
  trap - ERR
fi
git tag "$TAG"
git push --quiet origin main "$TAG"

step "Liberando para os usuários"
gh release edit "$TAG" -R "$REPO" --draft=false --latest >/dev/null

echo
echo "✓ Ovseer $VERSION publicado: https://github.com/$REPO/releases/tag/$TAG"
