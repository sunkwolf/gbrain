#!/usr/bin/env bash
#
# ÚNICA PUERTA del laboratorio.
#
# El límite de seguridad no es el entorno, el config, Bun ni una guarda del
# producto. Es el namespace de red creado por el kernel antes de ejecutar
# Bubblewrap. Bubblewrap construye además una raíz nueva que no contiene los
# sockets Unix ni los datos del host.
set -Eeuo pipefail

readonly SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO="$(cd -- "$SELF_DIR/.." && pwd -P)"
readonly EXPECTED_HEAD="0a1ecb6b9811ee6d676dc3ca46fab0294d5fa8ba"

readonly UNSHARE=/usr/bin/unshare
readonly BWRAP=/usr/bin/bwrap
readonly BUN=/usr/bin/bun
readonly BASH_BIN=/usr/bin/bash
readonly NODE_MODULES="$(/usr/bin/readlink -f "$REPO/node_modules")"

fail() {
  printf 'LAB_ABORTA: %s\n' "$*" >&2
  exit 1
}

for binary in "$UNSHARE" "$BWRAP" "$BUN" "$BASH_BIN"; do
  [[ -x "$binary" ]] || fail "falta binario fijado: $binary"
done
[[ -d "$NODE_MODULES" ]] || fail "falta el node_modules fijado: $NODE_MODULES"
[[ $# -gt 0 ]] || fail "uso: $0 COMANDO [ARG...]"

actual_head=$(/usr/bin/git -C "$REPO" rev-parse HEAD)
[[ "$actual_head" == "$EXPECTED_HEAD" ]] ||
  fail "HEAD cambió: esperado $EXPECTED_HEAD, observado $actual_head"
/usr/bin/git -C "$REPO" diff --quiet -- ||
  fail "hay cambios rastreados sin commit; el árbol del parche debe seguir congelado"
/usr/bin/git -C "$REPO" diff --cached --quiet -- ||
  fail "hay cambios rastreados en el índice; el árbol del parche debe seguir congelado"

# Todo árbol que entra desde el host es de solo lectura. Un socket de filesystem
# ya existente sería un destino del host montado dentro; se rehúsa la corrida.
#
# 🔴 SIN `-xdev`, y eso NO es cosmético — hallazgo de Claudy en su revisión de
# diseño, con la mitad decisiva medida por Claudio:
#
#   `-xdev` no cruza fronteras de sistema de archivos, así que un socket que viva
#   bajo un SUBMOUNT dentro de estos árboles pasaba el escaneo sin ser visto.
#   Medido: `find … -xdev -type s` no lo ve; sin `-xdev`, sí.
#
#   Y la otra mitad, que decidía si era vector real o inocuo: **`--ro-bind` de
#   Bubblewrap ES RECURSIVO** (medido con bwrap 0.11.2 — un socket bajo un
#   submount aparece dentro como `/outer/sub/host.sock`). ⇒ el submount SÍ entra
#   a la burbuja, y el guard no lo veía. Vector real, no hipotético.
#
# La familia del error es la de todo este frente: el escaneo cubría MENOS de lo
# que el mount trae. Un guard que verifica un subconjunto de lo que el consumidor
# recibe no es un guard.
for source in "$REPO" "$NODE_MODULES" "$SELF_DIR"; do
  socket=$(/usr/bin/find "$source" -type s -print -quit)
  [[ -z "$socket" ]] || fail "el input contiene un socket del host: $socket"
done

host_net=$(/usr/bin/readlink /proc/self/ns/net)
host_user=$(/usr/bin/readlink /proc/self/ns/user)
host_pid=$(/usr/bin/readlink /proc/self/ns/pid)
host_ipc=$(/usr/bin/readlink /proc/self/ns/ipc)
host_uts=$(/usr/bin/readlink /proc/self/ns/uts)
host_cgroup=$(/usr/bin/readlink /proc/self/ns/cgroup)
host_mnt=$(/usr/bin/readlink /proc/self/ns/mnt)

# stdin no cruza el límite. stdout/stderr son el único canal deliberado de
# salida para evidencia. Bubblewrap conserva descriptores heredados, por lo que
# la puerta los cierra antes de entrar (255 es el lector interno de este script
# y tiene close-on-exec).
exec </dev/null
for fd_path in /proc/$$/fd/*; do
  fd=${fd_path##*/}
  [[ "$fd" =~ ^[0-9]+$ ]] || fail "descriptor inesperado: $fd"
  case "$fd" in
    0|1|2|255) ;;
    *)
      eval "exec ${fd}>&-"
      eval "exec ${fd}<&-"
      ;;
  esac
done

# netns-init usa estas dos referencias únicamente para demostrar que `unshare`
# ya cambió ambos namespaces antes de recibir uid=0. Bubblewrap hace clearenv y
# solo vuelve a introducir los valores explícitos de la lista inferior.
export LAB_PRE_UNSHARE_USER="$host_user"
export LAB_PRE_UNSHARE_NET="$host_net"

exec "$UNSHARE" \
  --user --map-root-user \
  --net \
  --fork --kill-child \
  "$SELF_DIR/netns-init.sh" \
  "$BWRAP" \
    --unshare-user \
    --unshare-pid \
    --unshare-ipc \
    --unshare-uts \
    --unshare-cgroup \
    --disable-userns \
    --assert-userns-disabled \
    --uid 1000 \
    --gid 1000 \
    --cap-drop ALL \
    --die-with-parent \
    --new-session \
    --clearenv \
    --tmpfs / \
    --ro-bind /usr /usr \
    --symlink usr/bin /bin \
    --symlink usr/lib /lib \
    --symlink usr/lib /lib64 \
    --proc /proc \
    --dev /dev \
    --perms 1777 --tmpfs /tmp \
    --dir /run \
    --dir /var \
    --dir /home \
    --dir /etc \
    --ro-bind-try /etc/os-release /etc/os-release \
    --ro-bind-try /etc/passwd /etc/passwd \
    --ro-bind-try /etc/group /etc/group \
    --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \
    --ro-bind-try /etc/ssl/certs /etc/ssl/certs \
    --dir /input \
    --ro-bind "$REPO" /input/repo \
    --ro-bind "$NODE_MODULES" /input/node_modules \
    --ro-bind "$SELF_DIR" /harness \
    --perms 0777 --tmpfs /workspace \
    --setenv PATH /usr/bin \
    --setenv HOME /tmp/gb-diff-home \
    --setenv GBRAIN_HOME /tmp/gb-diff-home \
    --setenv TMPDIR /tmp \
    --setenv LANG C.UTF-8 \
    --setenv LC_ALL C.UTF-8 \
    --setenv LAB_HOST_NET "$host_net" \
    --setenv LAB_HOST_USER "$host_user" \
    --setenv LAB_HOST_PID "$host_pid" \
    --setenv LAB_HOST_IPC "$host_ipc" \
    --setenv LAB_HOST_UTS "$host_uts" \
    --setenv LAB_HOST_CGROUP "$host_cgroup" \
    --setenv LAB_HOST_MNT "$host_mnt" \
    --setenv LAB_PARENT_USER __LAB_PARENT_USER__ \
    --setenv LAB_PARENT_NET __LAB_PARENT_NET__ \
    --chdir /workspace \
    /harness/bootstrap.sh "$@"
