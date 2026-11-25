#!/bin/bash
# Проверка публичного интерфейса без сборки, сети или GitHub.
set -euo pipefail
cd "$(dirname "$0")/../.."
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export fixture
export log="$fixture/events"
repo="$fixture/repo"
mkdir -p "$repo/scripts/release" "$repo/src-tauri" "$repo/src" "$fixture/bin"
cp Makefile "$repo/"
cp scripts/release/{release.sh,build.sh,github-build.sh,publish.sh} "$repo/scripts/release/"
cp scripts/prepare-drawio.mjs "$repo/scripts/"
printf '%s\n' '{"version":"1.2.3"}' > "$repo/package.json"
printf '%s\n' '{"plugins":{"updater":{"endpoints":["https://updates.mark-by.ru/api/desktop/updates/livenote/stable/{{target}}/{{arch}}/{{current_version}}"]}}}' \
  > "$repo/src-tauri/tauri.conf.json"
printf '%s\n' 'UPLOAD_TOKEN=mock-file-token' > "$repo/.env"
printf '%s\n' 'NESTED=mock-secret' > "$repo/src/.env.local"
printf 'mock-key' > "$fixture/key"
node -e '
  const pk = Buffer.alloc(42);
  pk.write("Ed");
  process.stdout.write(Buffer.from("untrusted comment: mock\n" + pk.toString("base64") + "\n").toString("base64"));
' > "$fixture/key.pub"

cat > "$fixture/bin/stub" <<'STUB'
#!/bin/bash
set -euo pipefail
unset CDPATH
cmd=${0##*/}
case "$cmd" in
  git)
    case "$1" in
      rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
      status) [[ "${scenario}" != dirty ]] || echo ' M package.json' ;;
      symbolic-ref) echo main ;;
      remote) echo git@github.com:owner/livenote.git ;;
      ls-remote)
        if [[ "${*: -1}" = refs/heads/main ]]; then
          printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main\n'
        fi ;;
      archive) tar -cf - package.json src-tauri/tauri.conf.json src/.env.local ;;
      *) exit 99 ;;
    esac ;;
  npm)
    [[ ! ${UPLOAD_TOKEN+x} && ! ${TAURI_SIGNING_PRIVATE_KEY+x} && ! ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x} && ! ${GH_TOKEN+x} ]]
    [[ ! -e .env && ! -e src/.env.local ]]
    mkdir -p node_modules/.bin
    ln -s "$fixture/bin/stub" node_modules/.bin/tauri ;;
  tauri)
    [[ ! ${UPLOAD_TOKEN+x} && ! ${GH_TOKEN+x} ]]
    [[ ! -e .env && ! -e src/.env.local ]]
    node -e '
      const c = require("./release-overlay.json");
      if (c.bundle.createUpdaterArtifacts !== true || !c.plugins.updater.pubkey || c.plugins.updater.endpoints)
        process.exit(1);
    '
    if [[ "$1" = signer ]]; then
      [[ "$2 $3 $4" = 'sign --app-version 1.2.3' ]]
      [[ ! ${TAURI_SIGNING_PRIVATE_KEY+x} && "$TAURI_SIGNING_PRIVATE_KEY_PATH" = "$fixture/key" &&
        "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" = mock-password && -x "$5" ]]
      version=1.2.3
      [[ "$scenario" != wrong-version ]] || version=1.2.2
      printf 'comment\nsig\ntrusted comment: timestamp:0\tfile:linux\tversion:%s\nsig\n' "$version" |
        base64 > "$5.sig"
      printf 'signed-linux\n' >> "$log"
    elif [[ "$1" = build ]]; then
      [[ ! ${TAURI_SIGNING_PRIVATE_KEY+x} && ! ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x} ]]
      printf 'mac-build\n' >> "$log"
    else
      [[ "$TAURI_SIGNING_PRIVATE_KEY" = "$fixture/key" && "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" = mock-password ]]
      bundle="$CARGO_TARGET_DIR/aarch64-apple-darwin/release/bundle"
      app=LiveNote.app/Contents/MacOS/livenote
      mkdir -p "$bundle/dmg" "$bundle/macos/${app%/*}"
      printf dmg > "$bundle/dmg/LiveNote_1.2.3_aarch64.dmg"
      printf app > "$bundle/macos/$app"
      tar -czf "$bundle/macos/LiveNote.app.tar.gz" -C "$bundle/macos" LiveNote.app
      printf 'comment\nsig\ntrusted comment: timestamp:0\tfile:mac\tversion:1.2.3\nsig\n' |
        base64 > "$bundle/macos/LiveNote.app.tar.gz.sig"
    fi ;;
  hdiutil) [[ "$1" = verify && -s "$2" ]] ;;
  lipo) echo arm64 ;;
  file) echo 'ELF 64-bit LSB executable, x86-64' ;;
  minisign)
    printf 'verified\n' >> "$log"
    [[ "$scenario" != bad-signature ]] ;;
  gh)
    [[ ! ${UPLOAD_TOKEN+x} && ! ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x} &&
      ! ${TAURI_SIGNING_PRIVATE_KEY+x} && ! ${TAURI_SIGNING_PRIVATE_KEY_PATH+x} &&
      "$*" != *mock-password* && "$*" != *mock-process-token* && "$*" != *mock-file-token* ]]
    if [[ "$1" = api ]]; then
      case "$*" in
        *linux-appimage.yml/dispatches*)
          [[ "$*" = *'ref=main'* && "$*" = *'inputs[source_commit]=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'* &&
            "$*" = *"inputs[updater_pubkey]=$(< "$fixture/key.pub")"* ]]
          printf 'dispatch\n' >> "$log"
          echo 456 ;;
        *actions/runs/456*)
          if [[ "$scenario" = wrong-commit ]]; then
            echo 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb completed success workflow_dispatch'
          else
            echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa completed success workflow_dispatch'
          fi ;;
        *'/releases?'*) ;;
        *) exit 99 ;;
      esac
    elif [[ "$1 $2" = 'run watch' ]]; then
      [[ "$3" = 456 ]]
      printf 'watch\n' >> "$log"
      [[ "$scenario" != failed-run ]]
    elif [[ "$1 $2" = 'run download' ]]; then
      [[ "$3" = 456 && "$*" = *'--name livenote-linux-x86_64'* ]]
      out=${*: -1}
      mkdir "$out"
      printf '\177ELF\002\001\001\000AI\002' > "$out/LiveNote_1.2.3_amd64.AppImage"
      printf 'download\n' >> "$log"
    elif [[ "$2" = create ]]; then
      [[ "$*" = *--draft* && "$*" = *"--target aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]]
      [[ -s "$4" && -x "$5" && -s "${4%/*}/SHA256SUMS" ]]
      printf 'draft\n' >> "$log"
    elif [[ "$2" = edit ]]; then
      [[ "$*" = *--draft=false* ]]
      printf 'published\n' >> "$log"
    else
      exit 99
    fi ;;
  curl)
    [[ ! ${UPLOAD_TOKEN+x} && "$*" != *mock-file-token* && "$*" != *mock-process-token* ]]
    [[ "$*" = *'--form-string notes=@тест'* ]]
    expected=mock-process-token
    [[ "$scenario" != conflict ]] || expected=mock-file-token
    IFS= read -r header
    [[ "$header" = "Authorization: Bearer $expected" ]]
    platform=${*: -1}
    [[ "$platform" = https://updates.mark-by.ru/api/admin/desktop/releases/livenote/stable/1.2.3/* ]]
    case "${platform##*/}" in
      darwin-aarch64)
        [[ "$*" = *'signature=@LiveNote.app.tar.gz.sig'* &&
          "$*" = *'extra_artifacts=@LiveNote_1.2.3_aarch64.dmg'* ]]
        printf 'darwin\n' >> "$log" ;;
      linux-x86_64)
        [[ "$*" = *'signature=@LiveNote_1.2.3_amd64.AppImage.sig'* &&
          "$*" != *extra_artifacts* ]]
        printf 'linux\n' >> "$log"
        if [[ "$scenario" = conflict ]]; then printf 409; exit; fi ;;
      *) exit 99 ;;
    esac
    printf 201 ;;
  *) exit 99 ;;
esac
STUB
chmod +x "$fixture/bin/stub"
for cmd in git npm hdiutil lipo file minisign gh curl; do
  ln -s stub "$fixture/bin/$cmd"
done
export PATH="$fixture/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY_PATH="$fixture/key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=mock-password
export TAURI_SIGNING_PRIVATE_KEY=ignored-key
export UPLOAD_TOKEN=mock-process-token
export GH_TOKEN=mock-github-token
export NOTES='@тест'
cd "$repo"

check() {
  local target=$1 expected_code=$2 expected_events=$3 code=0 actual
  : > "$log"
  make "$target" > "$fixture/output" 2>&1 || code=$?
  actual=$(paste -sd, "$log")
  if [[ "$code" != "$expected_code" || "$actual" != "$expected_events" ]]; then
    printf 'Сценарий %s: код %s, события %s\n' "$scenario" "$code" "$actual" >&2
    return 1
  fi
  if [[ "$( < "$fixture/output" )" = *mock-process-token* ||
        "$( < "$fixture/output" )" = *mock-file-token* ||
        "$( < "$fixture/output" )" = *mock-password* ]]; then
    printf 'Сценарий %s: секрет в выводе\n' "$scenario" >&2
    return 1
  fi
  printf 'Проверено: %s\n' "$scenario"
}

export scenario=build
checked=dispatch,mac-build,watch,download,signed-linux,verified,verified
check release-build 0 "$checked"
scenario=success
check release 0 "$checked,draft,darwin,linux,published"
scenario=dirty
check release 2 ''
scenario=failed-run
check release 2 dispatch,mac-build,watch
scenario=wrong-commit
check release 2 dispatch,mac-build,watch
scenario=bad-signature
check release 2 "${checked%,verified}"
scenario=wrong-version
check release 2 "$checked"
scenario=conflict
unset UPLOAD_TOKEN
check release 2 "$checked,draft,darwin,linux"
[[ $(find dist -name SHA256SUMS | wc -l) -eq 3 ]]
