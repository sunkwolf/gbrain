#!/usr/bin/env python3
"""Canarios TCP y AF_UNIX que viven en el host, nunca dentro del laboratorio."""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("uso: canario-host.py DIRECTORIO_ESTADO")

    state_dir = Path(sys.argv[1])
    state_dir.mkdir(parents=True, exist_ok=True)
    unix_path = state_dir / "host-canary.sock"
    count_path = state_dir / "connections"
    count_path.write_text("0\n", encoding="utf-8")
    lock = threading.Lock()
    count = 0

    tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tcp.bind(("127.0.0.1", 0))
    tcp.listen()

    unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    unix.bind(str(unix_path))
    unix.listen()

    def serve(listener: socket.socket) -> None:
        nonlocal count
        while True:
            conn, _ = listener.accept()
            with conn:
                with lock:
                    count += 1
                    tmp = count_path.with_suffix(".tmp")
                    tmp.write_text(f"{count}\n", encoding="utf-8")
                    os.replace(tmp, count_path)
                conn.sendall(b"HOST_CANARY_REACHED\n")

    threading.Thread(target=serve, args=(tcp,), daemon=True).start()
    threading.Thread(target=serve, args=(unix,), daemon=True).start()

    ready = {
        "port": tcp.getsockname()[1],
        "unix_socket": str(unix_path),
        "pid": os.getpid(),
    }
    (state_dir / "ready.json").write_text(
        json.dumps(ready, sort_keys=True) + "\n", encoding="utf-8"
    )
    threading.Event().wait()


if __name__ == "__main__":
    main()
