#!/usr/bin/env python3
"""Control negativo: el host sí alcanza ambos canarios."""

from __future__ import annotations

import socket
import sys


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in {"tcp", "unix"}:
        raise SystemExit("uso: cliente-canario.py tcp PUERTO | unix RUTA")
    if sys.argv[1] == "tcp":
        sock = socket.create_connection(("127.0.0.1", int(sys.argv[2])), timeout=2)
    else:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect(sys.argv[2])
    with sock:
        reply = sock.recv(100).decode("ascii").strip()
    if reply != "HOST_CANARY_REACHED":
        raise SystemExit(f"respuesta inesperada: {reply!r}")
    print(f"HOST_CONTROL_PASS kind={sys.argv[1]} reply={reply}")


if __name__ == "__main__":
    main()
