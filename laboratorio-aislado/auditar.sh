#!/usr/bin/env bash
# Auditoría bidireccional: demuestra primero que el destino host existe y es
# alcanzable desde el host; luego exige que ninguna vía lo alcance desde dentro.
set -Eeuo pipefail

readonly SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly STATE_DIR="$(/usr/bin/mktemp -d /tmp/gbrain-lab-canary.XXXXXX)"
canary_pid=''

cleanup() {
  if [[ -n "$canary_pid" ]]; then
    /usr/bin/kill "$canary_pid" 2>/dev/null || true
    wait "$canary_pid" 2>/dev/null || true
  fi
  case "$STATE_DIR" in
    /tmp/gbrain-lab-canary.*) /usr/bin/rm -rf -- "$STATE_DIR" ;;
    *) printf 'AUDIT_FAIL ruta de cleanup inesperada: %s\n' "$STATE_DIR" >&2 ;;
  esac
}
trap cleanup EXIT

/usr/bin/python3 "$SELF_DIR/canario-host.py" "$STATE_DIR" &
canary_pid=$!

for _ in {1..100}; do
  [[ -s "$STATE_DIR/ready.json" ]] && break
  /usr/bin/sleep 0.05
done
[[ -s "$STATE_DIR/ready.json" ]] || {
  printf 'AUDIT_FAIL el canario no arrancó\n' >&2
  exit 1
}

port=$(/usr/bin/python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["port"])' \
  "$STATE_DIR/ready.json")
unix_socket=$(/usr/bin/python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["unix_socket"])' \
  "$STATE_DIR/ready.json")

# Dirección negativa: el instrumento tiene dientes fuera de la burbuja.
/usr/bin/python3 "$SELF_DIR/cliente-canario.py" tcp "$port"
/usr/bin/python3 "$SELF_DIR/cliente-canario.py" unix "$unix_socket"
[[ "$(/usr/bin/cat "$STATE_DIR/connections")" == "2" ]] || {
  printf 'AUDIT_FAIL el control host no produjo exactamente 2 conexiones\n' >&2
  exit 1
}

# Estructura y cierre de un FD heredado adicional.
exec 9<>"/dev/tcp/127.0.0.1/$port"
EXPECT_FD_CLOSED=9 "$SELF_DIR/lab.sh" /usr/bin/env EXPECT_FD_CLOSED=9 \
  /harness/estructura.sh
exec 9>&-
exec 9<&-

# Las siete vías conocidas + dos ataques que no pasan por sus cargadores.
"$SELF_DIR/lab.sh" /harness/ataques.sh "$port" "$unix_socket"

# Si algo dentro hubiera llegado, el canario lo habría contado.
/usr/bin/sleep 0.1
connections=$(/usr/bin/cat "$STATE_DIR/connections")
[[ "$connections" == "3" ]] || {
  printf 'AUDIT_FAIL conexiones_canario=%s esperado=3 (2 controles + FD host)\n' \
    "$connections" >&2
  exit 1
}
printf 'AUDIT_CANARY host_connections=3 lab_connections=0\n'
printf 'AUDIT_SUMMARY structural=pass attacks=9/9 directions=both pass=true\n'
