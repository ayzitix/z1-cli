"""Run SearXNG in this process and exit when the z1 parent disappears.

The CLI spawns this file with the venv interpreter, a log descriptor and
``Z1_PARENT_PID`` in the environment. Waitress runs in this same process, so a
watchdog thread can terminate the server with ``os._exit`` when z1 is gone; no
detached console, no orphaned waitress, and a force-killed z1 is covered too.

The command line still carries ``--listen=...`` and ``searx.webapp:app`` so the
CLI's identity check can recognise the process it started.
"""

import ctypes
import os
import sys
import threading
import time

# A script run by path puts its own directory on sys.path[0], not the cwd.
# startServer sets the cwd to the extracted SearXNG source, which is where the
# searx package lives.
sys.path.insert(0, os.getcwd())

from searx.webapp import app
from waitress import serve


def parent_alive(pid: int) -> bool:
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        try:
            # WAIT_TIMEOUT means the parent is alive; WAIT_OBJECT_0 means it exited.
            return kernel32.WaitForSingleObject(handle, 0) == 0x102
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def watch(pid: int) -> None:
    while True:
        if not parent_alive(pid):
            os._exit(0)
        time.sleep(0.5)


parent = int(os.environ.get("Z1_PARENT_PID", "0") or "0")
if parent > 0:
    threading.Thread(target=watch, args=(parent,), daemon=True).start()

listen = os.environ.get("Z1_SEARX_LISTEN", "127.0.0.1:8888")
host, port = listen.rsplit(":", 1)
threads = int(os.environ.get("Z1_SEARX_THREADS", "8"))
channel_timeout = int(os.environ.get("Z1_SEARX_CHANNEL_TIMEOUT", "300"))

serve(app, host=host, port=int(port), threads=threads, channel_timeout=channel_timeout)
