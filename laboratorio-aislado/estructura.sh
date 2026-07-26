#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'STRUCT_FAIL %s\n' "$*" >&2
  exit 1
}

distinct_from_host() {
  local label="$1" expected_host="$2" path="$3"
  local inside
  inside=$(/usr/bin/readlink "$path")
  [[ "$inside" != "$expected_host" ]] ||
    fail "$label no cambió: $inside"
  printf 'STRUCT_NAMESPACE %s host=%s lab=%s distinct=true\n' \
    "$label" "$expected_host" "$inside"
}

distinct_from_host net "$LAB_HOST_NET" /proc/self/ns/net
distinct_from_host user "$LAB_HOST_USER" /proc/self/ns/user
distinct_from_host pid "$LAB_HOST_PID" /proc/self/ns/pid
distinct_from_host ipc "$LAB_HOST_IPC" /proc/self/ns/ipc
distinct_from_host uts "$LAB_HOST_UTS" /proc/self/ns/uts
distinct_from_host cgroup "$LAB_HOST_CGROUP" /proc/self/ns/cgroup
distinct_from_host mnt "$LAB_HOST_MNT" /proc/self/ns/mnt

inner_user=$(/usr/bin/readlink /proc/self/ns/user)
inner_net=$(/usr/bin/readlink /proc/self/ns/net)
[[ "$inner_user" != "$LAB_PARENT_USER" ]] ||
  fail "Bubblewrap no creó el user namespace anidado"
[[ "$inner_net" == "$LAB_PARENT_NET" ]] ||
  fail "Bubblewrap abandonó el network namespace aislado preparado por init"
printf 'STRUCT_NAMESPACE_CHAIN user_parent=%s user_inner=%s nested=true net_parent=%s net_inner=%s inherited=true\n' \
  "$LAB_PARENT_USER" "$inner_user" "$LAB_PARENT_NET" "$inner_net"

uid=$(/usr/bin/id -u)
gid=$(/usr/bin/id -g)
[[ "$uid" == "1000" && "$gid" == "1000" ]] ||
  fail "identidad interior inesperada: uid=$uid gid=$gid"
printf 'STRUCT_IDENTITY uid=%s gid=%s\n' "$uid" "$gid"

interfaces=$(/usr/bin/awk -F: 'NR>2 {gsub(/[[:space:]]/,"",$1); print $1}' /proc/net/dev)
[[ "$interfaces" == "lo" ]] || fail "interfaces inesperadas: $interfaces"
bad_routes4=$(/usr/bin/awk 'NR>1 && NF && $1 != "lo" {n++} END {print n+0}' \
  /proc/net/route)
[[ "$bad_routes4" == "0" ]] || fail "hay rutas IPv4 fuera de loopback"
bad_routes6=$(/usr/bin/awk 'NF && $NF != "lo" {n++} END {print n+0}' \
  /proc/net/ipv6_route)
[[ "$bad_routes6" == "0" ]] || fail "hay rutas IPv6 fuera de loopback"
if /usr/bin/grep -qE '^0{31}1 .* lo$' /proc/net/if_inet6; then
  loopback=up
elif [[ "${LAB_EXPECT_LOOPBACK_DOWN:-0}" == "1" ]]; then
  loopback=down-degraded
else
  fail "loopback no está arriba; los servidores internos producirían falsos rojos"
fi
printf 'STRUCT_NETWORK interfaces=lo external_routes=0 loopback=%s\n' "$loopback"

[[ ! -e /run/postgresql ]] || fail "/run/postgresql existe"
[[ ! -e /var/run/postgresql ]] || fail "/var/run/postgresql existe"
host_home_entries=$(/usr/bin/find /home -mindepth 1 -print -quit)
[[ -z "$host_home_entries" ]] || fail "apareció contenido del home host: $host_home_entries"
printf 'STRUCT_FILESYSTEM host_postgres_socket=absent host_home=absent\n'

cap_line=$(/usr/bin/capsh --print | /usr/bin/sed -n 's/^Current: //p' | /usr/bin/head -1)
[[ -z "$cap_line" || "$cap_line" == "=" ]] || fail "quedaron capacidades: $cap_line"
if /usr/bin/capsh --has-p=cap_net_admin >/dev/null 2>&1; then
  fail "CAP_NET_ADMIN sobrevivió dentro de Bubblewrap"
fi
printf 'STRUCT_CAPABILITIES Current:%s cap_net_admin=absent\n' "$cap_line"

/usr/bin/touch /workspace/.lab-write-probe
[[ -f /workspace/.lab-write-probe ]] ||
  fail "el workspace privado no permitió escritura"
set +e
readonly_error=$(/usr/bin/touch /input/repo/.lab-host-write-probe 2>&1)
readonly_rc=$?
set -e
[[ $readonly_rc -ne 0 ]] ||
  fail "el clon del host aceptó escritura"
[[ ! -e /input/repo/.lab-host-write-probe ]] ||
  fail "la sonda apareció en el clon de solo lectura"
printf 'STRUCT_WRITES workspace=allowed host_clone=denied rc=%s diagnostic=%q\n' \
  "$readonly_rc" "$readonly_error"

set +e
nested=$(/usr/bin/unshare --user --map-root-user /usr/bin/true 2>&1)
nested_rc=$?
set -e
[[ $nested_rc -ne 0 ]] || fail "se pudo crear un user namespace anidado"
printf 'STRUCT_NESTED_USERNS disabled=true rc=%s diagnostic=%q\n' "$nested_rc" "$nested"

if [[ "${EXPECT_FD_CLOSED:-}" =~ ^[0-9]+$ ]]; then
  [[ ! -e "/proc/self/fd/$EXPECT_FD_CLOSED" ]] ||
    fail "el fd heredado $EXPECT_FD_CLOSED cruzó Bubblewrap"
  printf 'STRUCT_INHERITED_FD fd=%s closed=true\n' "$EXPECT_FD_CLOSED"
fi

printf 'STRUCT_SUMMARY pass=true\n'
