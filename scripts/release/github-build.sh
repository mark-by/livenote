start_linux_build() {
  local pubkey
  pubkey=$(node -p 'require(process.argv[1]).plugins.updater.pubkey' "$source_dir/release-overlay.json")
  linux_run_id=$(gh api --hostname github.com --method POST \
    "repos/$github_repo/actions/workflows/linux-appimage.yml/dispatches" \
    -f "ref=$branch" -f "inputs[source_commit]=$commit" \
    -f "inputs[updater_pubkey]=$pubkey" -F return_run_details=true --jq '.workflow_run_id') \
    || fail 'GitHub не запустил сборку. Проверьте Actions, права gh и наличие workflow в основной ветке.'
  [[ "$linux_run_id" =~ ^[1-9][0-9]*$ ]] || fail 'GitHub не вернул ID запущенной сборки.'
  printf 'Сборка Linux: https://github.com/%s/actions/runs/%s\n' "$github_repo" "$linux_run_id"
}

download_linux_build() {
  local result
  gh run watch "$linux_run_id" --repo "github.com/$github_repo" --compact --exit-status \
    || fail 'Сборка Linux в GitHub не завершилась успешно.'
  result=$(gh api --hostname github.com "repos/$github_repo/actions/runs/$linux_run_id" \
    --jq '[.head_sha, .status, .conclusion, .event] | join(" ")')
  [[ "$result" = "$commit completed success workflow_dispatch" ]] \
    || fail 'GitHub вернул сборку другого коммита или с неверным статусом.'
  gh run download "$linux_run_id" --repo "github.com/$github_repo" \
    --name livenote-linux-x86_64 --dir "$work/linux-artifact" \
    || fail 'Не удалось скачать AppImage из GitHub Actions.'
  [[ -f "$work/linux-artifact/$appimage" && ! -L "$work/linux-artifact/$appimage" ]] \
    || fail "GitHub не вернул AppImage версии $version."
  mv "$work/linux-artifact/$appimage" "$artifacts/$appimage"
}
