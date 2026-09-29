# Publicação de versões do Ovseer (ver RELEASE.md)
.PHONY: help update update-minor update-major release build-mac

help:
	@echo "make update         sobe a versão (0.1.0 -> 0.1.1) e publica"
	@echo "make update-minor   sobe a versão (0.1.3 -> 0.2.0) e publica"
	@echo "make update-major   sobe a versão (0.2.1 -> 1.0.0) e publica"
	@echo "make update VERSION=1.4.0   publica com um número escolhido"
	@echo "make release        publica a versão que já está no package.json"
	@echo "make build-mac      gera o instalador local, sem assinar nem publicar"

update:
	@scripts/release.sh $(or $(VERSION),patch)

update-minor:
	@scripts/release.sh minor

update-major:
	@scripts/release.sh major

release:
	@scripts/release.sh current

build-mac:
	npm run dist:mac
