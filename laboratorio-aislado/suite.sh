#!/usr/bin/env bash
# Suite archivo por archivo dentro de una sola burbuja. Cada Bun es un proceso
# nuevo; el GBRAIN_HOME y el workspace privados persisten durante la corrida.
set -u

readonly TIMEOUT_FILE=180
declare -a files

if [[ $# -gt 0 ]]; then
  files=("$@")
else
  mapfile -t files < <(/usr/bin/find test -name '*.test.ts' | /usr/bin/sort)
fi

total=${#files[@]}
red=0
pass_files=0
test_pass=0
test_fail=0
unknown=0
i=0

printf 'SUITE_START head=%s files=%s home=%s\n' \
  "$(/usr/bin/git rev-parse HEAD)" "$total" "$HOME"

for file in "${files[@]}"; do
  i=$((i + 1))
  output=$(
    /usr/bin/env -i \
      PATH=/usr/bin \
      HOME="$HOME" \
      TMPDIR=/tmp \
      LANG=C.UTF-8 \
      LC_ALL=C.UTF-8 \
      /usr/bin/timeout "$TIMEOUT_FILE" \
      /usr/bin/bun --no-env-file test --timeout=60000 "$file" 2>&1
  )
  rc=$?
  passes=$(/usr/bin/grep -oE '^ *[0-9]+ pass' <<<"$output" |
    /usr/bin/grep -oE '[0-9]+' | /usr/bin/tail -1)
  failures=$(/usr/bin/grep -oE '^ *[0-9]+ fail' <<<"$output" |
    /usr/bin/grep -oE '[0-9]+' | /usr/bin/tail -1)
  [[ -n "$passes" ]] || passes='?'
  [[ -n "$failures" ]] || failures='?'

  printf 'SUITE_ROW\t%s\t%s\t%s\t%s\n' "$file" "$passes" "$failures" "$rc"

  if [[ "$failures" == "0" && "$rc" == "0" ]]; then
    pass_files=$((pass_files + 1))
    test_pass=$((test_pass + passes))
  else
    red=$((red + 1))
    [[ "$passes" == "?" ]] || test_pass=$((test_pass + passes))
    [[ "$failures" == "?" ]] && unknown=$((unknown + 1)) ||
      test_fail=$((test_fail + failures))
    printf 'SUITE_RED_BEGIN %s\n%s\nSUITE_RED_END %s\n' "$file" "$output" "$file"
  fi

  if (( i % 100 == 0 )); then
    printf 'SUITE_PROGRESS done=%s total=%s red=%s\n' "$i" "$total" "$red"
  fi
done

printf 'SUITE_SUMMARY files=%s green_files=%s red_files=%s tests_pass=%s tests_fail=%s unknown=%s\n' \
  "$total" "$pass_files" "$red" "$test_pass" "$test_fail" "$unknown"
[[ "$red" -eq 0 ]]
