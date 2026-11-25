# Функции сборки выполняются из release.sh. Исходники и результаты находятся в разных каталогах.
snapshot_source() {
  local -a paths=(scripts/prepare-drawio.mjs
    LICENSE package.json package-lock.json tsconfig.json tsconfig.web.json vite.config.ts src src-tauri)
  git archive "$commit" -- "${paths[@]}" > "$work/source.tar"
  mkdir "$source_dir"
  tar --exclude '.env*' --exclude '.npmrc' --exclude '*.key' --exclude '*.pem' \
    --exclude '*.p12' --exclude '*.pfx' --exclude '*.minisign' \
    -xf "$work/source.tar" -C "$source_dir"
  rm "$work/source.tar"
}

build_artifacts() {
  mkdir -p "$repo/dist/release/$tag"
  artifacts=$(mktemp -d "$repo/dist/release/$tag/run.XXXXXXXX")
  printf 'Каталог артефактов: %s\n' "$artifacts"
  start_linux_build

  (
    # Ключ нужен только упаковщику. npm, Vite и Cargo его не получают.
    unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
    cd "$source_dir"
    export CARGO_TARGET_DIR="$work/mac-target"
    npm ci --no-audit --no-fund
    ./node_modules/.bin/tauri build --ci --no-bundle --target aarch64-apple-darwin \
      --config release-overlay.json -- --locked
    TAURI_SIGNING_PRIVATE_KEY="$key_path" \
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$signing_password" \
      ./node_modules/.bin/tauri bundle --ci --target aarch64-apple-darwin \
      --bundles app,dmg --config release-overlay.json
  )
  local mac_bundle="$work/mac-target/aarch64-apple-darwin/release/bundle"
  cp -p "$mac_bundle/dmg/$dmg" "$mac_bundle/macos/$archive" \
    "$mac_bundle/macos/$archive.sig" "$artifacts/"
  hdiutil verify "$artifacts/$dmg"
  [[ "$(lipo -archs "$mac_bundle/macos/LiveNote.app/Contents/MacOS/livenote")" = arm64 ]] \
    || fail 'Ожидалось приложение macOS arm64.'
  tar -tzf "$artifacts/$archive" | awk '
    /^(\.\/)?LiveNote\.app\/Contents\/MacOS\/livenote$/ { found=1 }
    END { exit !found }
  ' || fail 'Архив обновления macOS не содержит исполняемый файл LiveNote.'

  download_linux_build
  [[ -f "$artifacts/$appimage" && ! -L "$artifacts/$appimage" &&
    "$(file -b "$artifacts/$appimage")" = *"ELF 64-bit LSB"*"x86-64"* ]] \
    || fail 'Ожидался AppImage Linux x86-64.'
  [[ "$(od -An -tx1 -j8 -N3 "$artifacts/$appimage" | tr -d ' \n')" = 414902 ]] \
    || fail 'Файл не является AppImage Type 2.'
  chmod u+x "$artifacts/$appimage"
  (
    cd "$source_dir"
    unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
    TAURI_SIGNING_PRIVATE_KEY_PATH="$key_path" \
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$signing_password" \
      ./node_modules/.bin/tauri signer sign --app-version "$version" "$artifacts/$appimage"
  )

  local name
  for name in "$archive" "$appimage"; do
    [[ -s "$artifacts/$name" && -s "$artifacts/$name.sig" ]] \
      || fail "Нет артефакта или подписи: $name."
    base64 -D -i "$artifacts/$name.sig" > "$work/minisign.sig" \
      || fail "Неверный формат подписи: $name."
    minisign -Vq -p "$work/minisign.pub" -m "$artifacts/$name" -x "$work/minisign.sig" \
      || fail "Подпись не соответствует публичному ключу: $name."
    # Tauri 2.12.5 записывает версию последним полем доверенного комментария.
    awk -F '\t' -v expected="version:$version" '
      NR == 3 && /^trusted comment: / && $NF == expected { found=1 }
      END { exit !found }
    ' "$work/minisign.sig" || fail "Подпись не подтверждает версию $version: $name."
  done
  (
    cd "$artifacts"
    shasum -a 256 "$dmg" "$archive" "$archive.sig" "$appimage" "$appimage.sig" > SHA256SUMS
  )
  printf '%s\n' "$commit" > "$artifacts/SOURCE_COMMIT"
  printf 'Артефакты обеих платформ проверены: %s\n' "$artifacts"
}
