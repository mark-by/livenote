#!/bin/bash
set +x
set -euo pipefail
umask 077

fail() { printf 'Выпуск остановлен: %s\n' "$*" >&2; exit 1; }
mode=${1:-}
[[ "$mode" = build || "$mode" = publish ]] || fail 'Используйте make release-build или make release.'
cd "$(dirname "$0")/../.."
repo=$(pwd -P)
source scripts/release/build.sh
source scripts/release/github-build.sh
source scripts/release/publish.sh

[[ "$(uname -s):$(uname -m)" = Darwin:arm64 ]] || fail 'Нужен macOS на Apple Silicon.'
for cmd in node npm git cargo rustc gh minisign hdiutil lipo; do
  command -v "$cmd" >/dev/null || fail "Команда не найдена: $cmd."
done
node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)' \
  || fail 'Нужен Node.js 24.'
unset GH_DEBUG
export GH_PROMPT_DISABLED=1

# Читаем только нужные переменные; .env не выполняется как скрипт.
dotenv() {
  node -e '
    const fs = require("node:fs");
    if (fs.existsSync(".env")) {
      process.stdout.write(require("node:util").parseEnv(fs.readFileSync(".env", "utf8"))[process.argv[1]] ?? "");
    }
  ' "$1"
}
if [[ "$mode" = publish ]]; then
  upload_token=${UPLOAD_TOKEN-}
  [[ -n "$upload_token" ]] || upload_token=$(dotenv UPLOAD_TOKEN)
  [[ "$upload_token" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || fail 'Задайте корректный UPLOAD_TOKEN в окружении или .env.'
fi

key_setting=${TAURI_SIGNING_PRIVATE_KEY_PATH-}
[[ -n "$key_setting" ]] || key_setting=$(dotenv TAURI_SIGNING_PRIVATE_KEY_PATH)
signing_password=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}
if [[ ! ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x} ]]; then
  signing_password=$(dotenv TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
fi
unset UPLOAD_TOKEN TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD
notes=${NOTES-}
unset NOTES

[[ -n "$key_setting" ]] || fail 'Задайте TAURI_SIGNING_PRIVATE_KEY_PATH.'
[[ "$key_setting" != '~/'* ]] || key_setting="$HOME/${key_setting:2}"
key_path=$(node -e '
  const { resolve } = require("node:path");
  const relative = resolve(process.argv[1]);
  if (relative.startsWith(process.cwd() + "/")) process.exit(1);
  try { process.stdout.write(require("node:fs").realpathSync(relative)); }
  catch { process.exit(1); }
' -- "$key_setting") || fail 'Укажите существующий приватный ключ вне дерева репозитория.'
[[ -f "$key_path" && -r "$key_path" && "$key_path" != "$repo/"* ]] \
  || fail 'Храните приватный ключ вне дерева репозитория.'
[[ -f "$key_setting.pub" && -r "$key_setting.pub" ]] || fail 'Рядом с ключом нужен файл .pub.'

commit=$(git rev-parse --verify HEAD)
preflight_origin

work=$(mktemp -d "${TMPDIR:-/tmp}/livenote-release.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
source_dir="$work/source"
snapshot_source
version=$(cd "$source_dir" && node -p 'require("./package.json").version')
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail 'Для stable нужна версия X.Y.Z из package.json.'
tag="v$version"
dmg="LiveNote_${version}_aarch64.dmg"
archive=LiveNote.app.tar.gz
appimage="LiveNote_${version}_amd64.AppImage"

# В overlay нет endpoint и секретов: endpoint остаётся в базовой конфигурации.
node - "$source_dir" "$key_setting.pub" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [source, publicKey] = process.argv.slice(2);
const base = JSON.parse(readFileSync(join(source, 'src-tauri/tauri.conf.json'), 'utf8'));
const endpoint = 'https://updates.mark-by.ru/api/desktop/updates/livenote/stable/{{target}}/{{arch}}/{{current_version}}';
if (!base.plugins?.updater?.endpoints?.includes(endpoint)) {
  console.error('В базовой конфигурации Tauri нет endpoint LiveNote stable.');
  process.exit(1);
}
const pubkey = readFileSync(publicKey, 'utf8').trim();
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pubkey)) {
  console.error('Файл .pub должен содержать публичный ключ Tauri в Base64.');
  process.exit(1);
}
const [comment, encodedKey, end] = Buffer.from(pubkey, 'base64').toString('ascii').split('\n');
const key = Buffer.from(encodedKey ?? '', 'base64');
if (!comment.startsWith('untrusted comment: ') || (end ?? '') !== '' ||
    key.length !== 42 || key.subarray(0, 2).toString('ascii') !== 'Ed') {
  console.error('Файл .pub не содержит публичный ключ Minisign.');
  process.exit(1);
}
writeFileSync(join(source, 'release-overlay.json'), JSON.stringify({
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey } },
}));
NODE
base64 -D -i "$key_setting.pub" > "$work/minisign.pub" || fail 'Неверный формат публичного ключа Tauri.'

if [[ "$mode" = publish ]]; then
  check_release_available
fi
build_artifacts
if [[ "$mode" = publish ]]; then
  publish_release
fi
