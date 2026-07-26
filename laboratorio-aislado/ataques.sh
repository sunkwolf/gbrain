#!/usr/bin/env bash
# Batería adversarial. Todas las inyecciones se hacen DENTRO del límite para
# demostrar que el cerco no depende de sanearlas.
set -Eeuo pipefail

[[ $# -eq 2 ]] || {
  printf 'uso: ataques.sh PUERTO_CANARIO SOCKET_UNIX_CANARIO\n' >&2
  exit 1
}
readonly PORT="$1"
readonly HOST_UNIX_SOCKET="$2"
readonly TARGET="postgresql://u:p@127.0.0.1:${PORT}/prodbrain"
readonly PROBE=/harness/sonda-conexion.test.ts
readonly UNIX_PROBE=/harness/sonda-unix.test.ts
export LAB_EXPECT_OUTER_SECCOMP="${LAB_EXPECT_OUTER_SECCOMP:-0}"

run_case() {
  local name="$1"
  shift
  printf 'ATTACK_START %s\n' "$name"
  local output rc
  set +e
  output=$("$@" 2>&1)
  rc=$?
  set -e
  printf '%s\n' "$output" | /usr/bin/grep 'ATTACK_RESULT ' || true
  if [[ $rc -ne 0 ]] || ! /usr/bin/grep -q 'ATTACK_RESULT ' <<<"$output"; then
    printf 'ATTACK_FAIL %s rc=%s\n%s\n' "$name" "$rc" "$output" >&2
    exit 1
  fi
  if [[ "$LAB_EXPECT_OUTER_SECCOMP" == "1" ]]; then
    printf 'ATTACK_OBSERVED_CONFOUNDED %s outer_seccomp=true\n' "$name"
  else
    printf 'ATTACK_PASS %s\n' "$name"
  fi
}

# 1. La llave solo aparece después de JSON.parse.
/usr/bin/cp /tmp/gb-diff-home/.gbrain/config.json /tmp/config.clean.json
/usr/bin/printf '{"engine":"pglite","database\\u005furl":"%s"}\n' "$TARGET" \
  > /tmp/gb-diff-home/.gbrain/config.json
run_case config_unicode \
  /usr/bin/env ATTACK_CASE=config_unicode ATTACK_TARGET="$TARGET" REPO_ROOT=/workspace \
  /usr/bin/bun --no-env-file test "$PROBE"
/usr/bin/cp /tmp/config.clean.json /tmp/gb-diff-home/.gbrain/config.json

# 2. DATABASE_URL ya está presente en el proceso de test.
run_case database_url \
  /usr/bin/env DATABASE_URL="$TARGET" ATTACK_CASE=database_url \
  ATTACK_TARGET="$TARGET" REPO_ROOT=/workspace \
  /usr/bin/bun --no-env-file test "$PROBE"

# 3. La variable de gbrain gana sobre el archivo.
run_case gbrain_database_url \
  /usr/bin/env GBRAIN_DATABASE_URL="$TARGET" ATTACK_CASE=gbrain_database_url \
  ATTACK_TARGET="$TARGET" REPO_ROOT=/workspace \
  /usr/bin/bun --no-env-file test "$PROBE"

# 4. La guarda destructiva acepta el nombre exacto y aun así no hay destino.
run_case e2e_allow_db \
  /usr/bin/env DATABASE_URL="$TARGET" GBRAIN_E2E_ALLOW_DB=prodbrain \
  ATTACK_CASE=e2e_allow_db ATTACK_TARGET="$TARGET" REPO_ROOT=/workspace \
  /usr/bin/bun --no-env-file test "$PROBE"

# 5. Bun carga `export VAR=...` desde .env y el helper carga .env.testing.
/usr/bin/printf 'export DATABASE_URL=%s\nexport DOTENV_EXPORT_MARKER=loaded\n' "$TARGET" \
  > /workspace/.env
/usr/bin/printf 'DATABASE_URL=%s\n' "$TARGET" > /workspace/.env.testing
run_case dotenv \
  /usr/bin/env ATTACK_CASE=dotenv ATTACK_TARGET="$TARGET" REPO_ROOT=/workspace \
  /usr/bin/bun test "$PROBE"
/usr/bin/rm -f /workspace/.env /workspace/.env.testing

# 6. Un `bun` interpuesto inyecta después del env -i.
/usr/bin/mkdir -p /tmp/attack-bin
/usr/bin/printf '%s\n' \
  '#!/usr/bin/env bash' \
  "export GBRAIN_DATABASE_URL='$TARGET'" \
  'export PATH_SHIM_MARKER=loaded' \
  'exec /usr/bin/bun "$@"' > /tmp/attack-bin/bun
/usr/bin/chmod 0755 /tmp/attack-bin/bun
run_case path_shim \
  /usr/bin/env -i PATH=/tmp/attack-bin:/usr/bin \
  HOME=/tmp/gb-diff-home GBRAIN_HOME=/tmp/gb-diff-home TMPDIR=/tmp \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 ATTACK_CASE=path_shim ATTACK_TARGET="$TARGET" \
  REPO_ROOT=/workspace LAB_EXPECT_OUTER_SECCOMP="$LAB_EXPECT_OUTER_SECCOMP" \
  bun --no-env-file test "$PROBE"

# 7. Un preload de bunfig inyecta antes del cuerpo del test.
/usr/bin/mkdir -p /tmp/preload-case
/usr/bin/printf '%s\n' \
  "process.env.GBRAIN_DATABASE_URL = '$TARGET';" \
  "process.env.BUNFIG_PRELOAD_MARKER = 'loaded';" \
  > /tmp/preload-case/inject.ts
/usr/bin/printf '%s\n' \
  '[test]' \
  'preload = ["./inject.ts"]' \
  > /tmp/preload-case/bunfig.toml
run_case bunfig_preload \
  /usr/bin/env ATTACK_CASE=bunfig_preload ATTACK_TARGET="$TARGET" \
  REPO_ROOT=/workspace /usr/bin/bash -c \
  'cd /tmp/preload-case && exec /usr/bin/bun --no-env-file test /harness/sonda-conexion.test.ts'

# 8. Ruta nueva: literal/construcción directa, sin tocar ningún cargador.
run_case direct_literal \
  /usr/bin/env ATTACK_CASE=direct_literal ATTACK_TARGET="$TARGET" REPO_ROOT=/workspace \
  /usr/bin/bun --no-env-file test "$PROBE"

# 9. Ruta nueva: AF_UNIX evita IP, pero el mount namespace quitó el socket.
run_case direct_unix_socket \
  /usr/bin/env ATTACK_UNIX_SOCKET="$HOST_UNIX_SOCKET" \
  /usr/bin/bun --no-env-file test "$UNIX_PROBE"

if [[ "$LAB_EXPECT_OUTER_SECCOMP" == "1" ]]; then
  printf 'ATTACK_SUMMARY total=9 observed=9 security_pass=0 confounded=outer-seccomp\n'
  exit 2
fi
printf 'ATTACK_SUMMARY total=9 pass=9 fail=0\n'
