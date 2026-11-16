# LiveNote: сборка и запуск локального блокнота.
# Основные цели: make run (запуск с браузером), make serve (без браузера), make smoke.

.DEFAULT_GOAL := run

.PHONY: install build run serve dev-server dev-web typecheck smoke clean

install:
	npm install

# Сборка ставит зависимости автоматически, если их ещё нет.
build:
	@if [ ! -d node_modules ]; then echo "==> npm install"; npm install; fi
	npm run build

# Запуск без пересборки: сначала make build, затем make run.
run:
	node bin/livenote.js --open

# Глобальная команда livenote (запуск из любого места):
# собирает, пакует в tgz и ставит через npm -g. Обновление — просто запустить снова.
install-global: build
	@npm pack --pack-destination "$(TMPDIR)"
	npm install -g "$(TMPDIR)/livenote-$(shell node -p "require('./package.json').version").tgz"
	@echo "Готово: команда 'livenote' доступна глобально (перезапусти терминал, если PATH не подхватился)."

# Запуск без открытия браузера (для проверки и фонового режима).
serve:
	node bin/livenote.js

dev-server:
	npm run dev:server

dev-web:
	npm run dev:web

typecheck:
	npm run typecheck

# Полная интеграционная проверка: REST, SSE, MCP-инструменты, экспорт/импорт.
smoke: build
	bash scripts/smoke.sh

clean:
	rm -rf dist
