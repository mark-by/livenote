#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="$(pwd -P)/src-tauri/target"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    target=aarch64-apple-darwin
    format=dmg
    ;;
  Linux:x86_64)
    target=x86_64-unknown-linux-gnu
    format=deb
    ;;
  *)
    printf '%s\n' 'Сборка поддерживает macOS на Apple Silicon и Ubuntu 24.04 на x86-64.' >&2
    exit 1
    ;;
esac

npm ci
npm run tauri build -- --target "$target" --bundles "$format"
bundle_dir="$CARGO_TARGET_DIR/$target/release/bundle"
version="$(node -p 'require("./package.json").version')"

case "$format" in
  dmg)
    package="$bundle_dir/dmg/LiveNote_${version}_aarch64.dmg"
    printf 'Образ LiveNote готов: %s\n' "$package"
    printf '%s\n' 'Откройте образ и перетащите LiveNote.app в Applications.'
    ;;
  deb)
    package="$bundle_dir/deb/LiveNote_${version}_amd64.deb"
    if [ "$(id -u)" -eq 0 ]; then
      apt-get install --reinstall "$package"
    else
      sudo apt-get install --reinstall "$package"
    fi
    ;;
esac
