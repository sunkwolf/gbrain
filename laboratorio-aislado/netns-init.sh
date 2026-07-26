#!/usr/bin/env bash
# Corre inmediatamente después de `unshare --net`, todavía con CAP_NET_ADMIN
# dentro del user namespace. Subir `lo` NO crea una salida: solo permite que dos
# procesos nacidos dentro de la misma burbuja se hablen.
set -Eeuo pipefail

[[ $# -gt 0 ]] || {
  printf 'LAB_ABORTA: netns-init sin comando\n' >&2
  exit 1
}

readonly INIT_UID=$(/usr/bin/id -u)
readonly INIT_GID=$(/usr/bin/id -g)
readonly INIT_USER_NS=$(/usr/bin/readlink /proc/self/ns/user)
readonly INIT_NET_NS=$(/usr/bin/readlink /proc/self/ns/net)
readonly INIT_CAPS=$(/usr/bin/capsh --print |
  /usr/bin/sed -n 's/^Current: //p' | /usr/bin/head -1)

[[ "$INIT_UID" == "0" && "$INIT_GID" == "0" ]] || {
  printf 'LAB_ABORTA: init no recibió uid/gid 0 dentro del user namespace\n' >&2
  exit 1
}
[[ "$INIT_USER_NS" != "${LAB_PRE_UNSHARE_USER:-}" ]] || {
  printf 'LAB_ABORTA: unshare no cambió el user namespace\n' >&2
  exit 1
}
[[ "$INIT_NET_NS" != "${LAB_PRE_UNSHARE_NET:-}" ]] || {
  printf 'LAB_ABORTA: unshare no cambió el network namespace\n' >&2
  exit 1
}
/usr/bin/capsh --has-p=cap_net_admin >/dev/null 2>&1 || {
  printf 'LAB_ABORTA: init no recibió CAP_NET_ADMIN dentro del user namespace\n' >&2
  exit 1
}
printf 'NETNS_INIT_PRIVILEGE uid=%s gid=%s user=%s net=%s Current:%s cap_net_admin=present host_user_distinct=true host_net_distinct=true\n' \
  "$INIT_UID" "$INIT_GID" "$INIT_USER_NS" "$INIT_NET_NS" "$INIT_CAPS"

if /usr/bin/ip link set lo up; then
  printf 'NETNS_INIT loopback=up external_interfaces=0\n'
elif [[ "${LAB_ALLOW_LOOPBACK_DOWN:-0}" == "1" ]]; then
  printf 'NETNS_INIT loopback=down mode=DEGRADADO reason=ip-netlink-denied\n' >&2
else
  printf '%s\n' \
    'LAB_ABORTA: el namespace existe, pero no se pudo subir loopback.' \
    'Se necesita CAP_NET_ADMIN DENTRO del user namespace (no sudo en el host).' \
    'En un Linux sin seccomp exterior, unshare --user --net la concede al usuario mapeado.' \
    'No se continúa: los tests que levantan servidores locales darían falsos rojos.' >&2
  exit 1
fi

# Los placeholders están después de --clearenv en lab.sh. Sustituirlos aquí
# deja que la auditoría interior pruebe las dos transiciones:
# host -> user/net namespace temporal -> user namespace de Bubblewrap.
declare -a command=("$@")
for i in "${!command[@]}"; do
  case "${command[$i]}" in
    __LAB_PARENT_USER__) command[$i]="$INIT_USER_NS" ;;
    __LAB_PARENT_NET__) command[$i]="$INIT_NET_NS" ;;
  esac
done

exec "${command[@]}"
