#!/usr/bin/env bash
# Corre ya dentro de los namespaces. Copia el objeto congelado a tmpfs para que
# los tests puedan escribir sin modificar el clon ni compartir un directorio
# escribible con el host.
set -Eeuo pipefail

[[ $# -gt 0 ]] || {
  printf 'LAB_ABORTA: bootstrap sin comando\n' >&2
  exit 1
}

/usr/bin/cp -a /input/repo/. /workspace/
/usr/bin/rm -f /workspace/node_modules
/usr/bin/ln -s /input/node_modules /workspace/node_modules

/usr/bin/mkdir -p /tmp/gb-diff-home/.gbrain
/usr/bin/cp /harness/config-laboratorio.json \
  /tmp/gb-diff-home/.gbrain/config.json

cd /workspace
exec "$@"
