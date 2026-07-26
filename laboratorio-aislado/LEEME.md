# Laboratorio aislado para el diferencial

## Veredicto

La frontera es del kernel y se construye antes de ejecutar una sola línea del
objeto bajo prueba:

1. `unshare --user --map-root-user --net` crea un user namespace y un network
   namespace sin interfaces externas.
2. `netns-init.sh`, como UID/GID 0 **solo dentro de ese user namespace**, usa
   `CAP_NET_ADMIN` para subir `lo`.
3. Bubblewrap crea los namespaces de mount, user, PID, IPC, UTS y cgroup, entra
   como UID/GID 1000, retira todas las capacidades y deshabilita nuevos user
   namespaces.
4. El clon congelado, `node_modules` y el harness entran de solo lectura. La
   copia de trabajo y `GBRAIN_HOME` viven en tmpfs privados.
5. La puerta sustituye stdin por `/dev/null` y cierra todos los descriptores
   heredados salvo stdout/stderr, que son el canal deliberado de evidencia.

Una URL, variable, `.env`, shim, preload o literal malicioso puede seguir
construyéndose. No hay destino de producción al cual conectarse: el network
namespace carece de interfaz/ruta externa y el mount namespace no contiene los
sockets Unix ni el home del host.

## Verificar integridad — 🔴 desde la RAÍZ del repo, no desde aquí

```bash
cd /home/fer/gbrain-parche-medicion      # la raíz, NO laboratorio-aislado/
sha256sum -c laboratorio-aislado/MANIFEST.sha256
```

Las rutas del manifiesto son **relativas a la raíz del repo**. Corriéndolo desde
dentro de esta carpeta, `sha256sum` no encuentra ni un archivo y reporta
`13 listed files could not be read` — que **se lee igual que un manifiesto roto**
y no lo es. Me costó dos intentos sabiendo lo que buscaba; queda escrito para que
no sea conocimiento tribal.

`MANIFEST.sha256.firma-codex` es la copia intacta del manifiesto tal como lo
entregó Codex. `MANIFEST.sha256` se regeneró al añadir esta sección — si difieren
en algo que no sea `LEEME.md`, hay que investigarlo.

## Única puerta

Una corrida normal:

```bash
./laboratorio-aislado/lab.sh /usr/bin/bun --no-env-file test test/config.test.ts
```

La auditoría bidireccional completa, en un host Linux sin un seccomp exterior
que bloquee sockets o netlink:

```bash
./laboratorio-aislado/auditar.sh \
  > laboratorio-aislado/evidencia/auditoria-completa.log 2>&1
```

El resultado válido termina en:

```text
AUDIT_CANARY host_connections=3 lab_connections=0
AUDIT_SUMMARY structural=pass attacks=9/9 directions=both pass=true
```

No se acepta una auditoría que no demuestre primero que los canarios TCP y
AF_UNIX son alcanzables desde el host.

## Qué se midió y cómo

| Afirmación | Medición que la sostiene |
|---|---|
| La raíz preparatoria no es raíz host | `readlink /proc/self/ns/user` cambia respecto al host; dentro del nuevo namespace `id` da UID/GID 0. |
| La capacidad para subir `lo` existe solo en la fase preparatoria | `capsh --has-p=cap_net_admin` pasa en `netns-init.sh`. |
| Bubblewrap anida otro user namespace | Los inode-links `user_parent` y `user_inner` son distintos. |
| El proceso de prueba no es root | `id -u` y `id -g` dan 1000 dentro de Bubblewrap. |
| No quedan capacidades efectivas | `capsh --print` da literalmente `Current:=`; `capsh --has-p=cap_net_admin` falla. |
| Producción no comparte red | El inode-link del net namespace difiere del host; `/proc/net/dev` contiene solo `lo`; no hay rutas IPv4/IPv6 externas. |
| Bubblewrap conserva el net namespace ya preparado | `net_parent` y `net_inner` son iguales. |
| Producción no comparte filesystem | No existen `/run/postgresql`, `/var/run/postgresql` ni contenido host bajo `/home`. |
| El objeto puede escribir sin tocar el clon | `touch /workspace/.lab-write-probe` pasa; el mismo intento bajo `/input/repo` falla `EROFS`. |
| No cruza un canal de red ya abierto | La auditoría abre FD 9 antes de entrar y `estructura.sh` exige que `/proc/self/fd/9` no exista. |
| El objeto no puede fabricar un user namespace nuevo | Un `unshare --user --map-root-user true` interior debe fallar; Bubblewrap también arranca con `--assert-userns-disabled`. |
| Las nueve inyecciones llegaron al código atacado | Cada caso exige un `ATTACK_RESULT` con `injection_observed`; el canario host cuenta después cero conexiones nacidas dentro. |

Recibo estructural de esta ejecución:
`evidencia/estructura-degradada.log`.

## Control normal

El control sin ataques ejecutó seis archivos representativos dentro de la
burbuja, incluidos config, guarda E2E, receipts, PGLite con escritura y
aislamiento por source:

```text
SUITE_SUMMARY files=6 green_files=6 red_files=0 tests_pass=189 tests_fail=0 unknown=0
```

Recibo: `evidencia/control-negativo-degradado.log`.

No apareció ninguna alarma de ataque en esa corrida. El único diagnóstico fue
el aviso explícito de modo degradado del dispatcher exterior.

La corrida amplia degradada recorrió 1304 archivos: 1286 verdes y 18 rojos.
Ese resultado no se presenta como suite verde ni como fallo del cerco. Incluye
tests que abren listeners, usan IPC/socketpairs o ejercitan subprocess pipes,
operaciones que el seccomp exterior impide, y otros rojos que requieren triage
de producto/banco aparte. El log íntegro está en
`evidencia/suite-completa-degradada.log`; una repetición aislada de
`init-fresh-pglite` quedó verde (14/14) en
`evidencia/repeticion-init-fresh-timeout-corregido.log`.

## Modo degradado

Este dispatcher permite crear los namespaces pero niega el netlink usado para
subir `lo`; también niega al proceso host crear el canario. Solo para comprobar
estructura y tests que no necesitan servidores locales:

```bash
exec 9<>/tmp/gbrain-lab-fd-probe
LAB_ALLOW_LOOPBACK_DOWN=1 \
  ./laboratorio-aislado/lab.sh \
  /usr/bin/env LAB_EXPECT_LOOPBACK_DOWN=1 EXPECT_FD_CLOSED=9 \
  /harness/estructura.sh \
  > laboratorio-aislado/evidencia/estructura-degradada.log 2>&1
```

El modo degradado no convierte una negativa de conexión en evidencia de
seguridad. `ataques.sh` lo marca como `confounded=outer-seccomp` y sale 2.
`auditar.sh` falla cerrado si no puede levantar primero los canarios host.

## Residual declarado

- La auditoría bidireccional completa queda pendiente de una ejecución fuera
  del seccomp del dispatcher actual. Aquí se midió estructura y control normal;
  las negativas de conexión observadas aquí están confundidas y no se cuentan
  como prueba.
- El laboratorio protege el host frente al código de prueba; no pretende
  ocultar al código los tres inputs que se montan deliberadamente de solo
  lectura: clon, dependencias y harness. Cualquier secreto ya presente en esos
  inputs sería legible. La precondición operacional es usar un clon congelado y
  saneado.
- stdout/stderr son un canal de salida deliberado. El laboratorio impide que el
  objeto alcance producción, no que imprima contenido de sus inputs.
- La garantía termina en el kernel y los binarios fijados `unshare`, `ip`,
  Bubblewrap y Bun. Un kernel o binario de confianza comprometido queda fuera
  del modelo.
- Los tests que necesitan servidores loopback internos requieren `lo` arriba.
  En modo normal, si no puede subirse, la puerta aborta; el override degradado
  existe solo para auditoría estructural y tests sin red.

