# LiveNote: сборка и запуск локального блокнота.
# Основные цели: make run (режим разработки), make install (подготовка установочного пакета).

.DEFAULT_GOAL := run

.PHONY: install build run dev-web typecheck clean
.PHONY: release release-build

install:
	sh scripts/install-desktop.sh

release:
	@bash scripts/release/release.sh publish

release-build:
	@bash scripts/release/release.sh build

# Сборка ставит зависимости автоматически, если их ещё нет.
build:
	@if [ ! -d node_modules ]; then npm ci; fi
	npm run desktop:web

run:
	@if [ ! -x node_modules/.bin/tauri ]; then npm ci; fi
	npm run tauri dev

dev-web:
	npm run dev:web

typecheck:
	./node_modules/.bin/tsc --noEmit -p tsconfig.web.json

clean:
	rm -rf dist
