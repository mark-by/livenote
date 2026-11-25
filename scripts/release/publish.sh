# До сборки и после неё убеждаемся, что исходники соответствуют ветке на origin.
preflight_origin() {
  local status origin remote_head
  status=$(git status --porcelain --untracked-files=all -- .) \
    || fail 'Не удалось проверить рабочее дерево.'
  # Незакоммиченный .env допустим только как локальный файл с секретами.
  [[ -z "$status" || "$status" = '?? .env' ]] \
    || fail 'Для сборки GitHub закоммитьте изменения и оставьте рабочее дерево чистым.'
  [[ "$(git rev-parse HEAD)" = "$commit" ]] || fail 'HEAD изменился во время сборки.'
  branch=$(git symbolic-ref --quiet --short HEAD) || fail 'Переключитесь на ветку, отправленную в origin.'
  origin=$(git remote get-url origin) || fail 'Не настроен origin.'
  origin=${origin%.git}
  if [[ "$origin" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then
    github_repo=${BASH_REMATCH[2]}
  else
    fail 'origin должен указывать на репозиторий github.com.'
  fi
  remote_head=$(git ls-remote --exit-code origin "refs/heads/$branch") \
    || fail 'Не удалось прочитать ветку на origin.'
  [[ "${remote_head%%$'\t'*}" = "$commit" ]] \
    || fail 'HEAD должен совпадать с веткой на origin.'
}

check_release_available() {
  local remote_tags releases
  remote_tags=$(git ls-remote origin "refs/tags/$tag") || fail 'Не удалось проверить тег на origin.'
  [[ -z "$remote_tags" ]] || fail "Тег $tag уже существует на origin."
  releases=$(GH_PROMPT_DISABLED=1 gh api --hostname github.com --paginate \
    "repos/$github_repo/releases?per_page=100" --jq ".[] | select(.tag_name == \"$tag\") | .id") \
    || fail 'Не удалось проверить релизы GitHub. Проверьте авторизацию gh.'
  [[ -z "$releases" ]] || fail "Релиз или черновик $tag уже существует. Проверьте предыдущий запуск вручную."
}

upload_update() {
  local platform=$1 payload=$2
  shift 2
  local status
  status=$(
    cd "$artifacts"
    printf 'Authorization: Bearer %s\n' "$upload_token" |
      curl --disable --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --proto '=https' --connect-timeout 20 --max-time 1800 --header @- \
        --form "updater_artifact=@$payload" --form "signature=@$payload.sig" \
        --form-string "notes=$notes" "$@" \
        "https://updates.mark-by.ru/api/admin/desktop/releases/livenote/stable/$version/$platform"
  ) || fail "Не удалось загрузить $platform; проверьте состояние сервера перед повтором."
  case "$status" in
    201) printf 'Обновление загружено: %s\n' "$platform" ;;
    409) fail "Обновление $tag ($platform) уже существует (HTTP 409). Черновик не опубликован." ;;
    *) fail "Сервер отклонил $platform: HTTP $status. Черновик не опубликован." ;;
  esac
}

publish_release() {
  local pinned_repo=$github_repo
  preflight_origin
  [[ "$github_repo" = "$pinned_repo" ]] || fail 'origin изменился во время сборки.'
  check_release_available
  local bytes
  # Оставляем запас для заголовков multipart и заметок.
  bytes=$(wc -c < "$artifacts/$dmg")
  (( bytes + $(wc -c < "$artifacts/$archive") + $(wc -c < "$artifacts/$archive.sig") < 536805376 )) \
    || fail 'Пакеты macOS превышают лимит запроса 512 МиБ.'
  (( $(wc -c < "$artifacts/$appimage") + $(wc -c < "$artifacts/$appimage.sig") < 536805376 )) \
    || fail 'Пакет Linux превышает лимит запроса 512 МиБ.'
  (( ${#notes} <= 16000 )) || fail 'NOTES слишком длинное.'

  export GH_PROMPT_DISABLED=1
  gh release create "$tag" "$artifacts/$dmg" "$artifacts/$appimage" \
    --repo "github.com/$github_repo" --draft --target "$commit" --title "$tag" --notes "$notes" \
    || fail 'Не удалось создать черновик с установщиками. Проверьте GitHub; артефакты сохранены.'
  printf 'Если публикация прервётся, проверьте черновик %s и состояние обеих платформ на сервере.\n' "$tag"
  upload_update darwin-aarch64 "$archive" --form "extra_artifacts=@$dmg"
  upload_update linux-x86_64 "$appimage"
  gh release edit "$tag" --repo "github.com/$github_repo" --draft=false \
    || fail 'Обновления загружены, но GitHub не подтвердил публикацию. Проверьте черновик вручную.'
  printf 'Релиз %s опубликован.\n' "$tag"
}
