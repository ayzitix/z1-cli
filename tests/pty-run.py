#!/usr/bin/env python3
"""Run a command on a fresh pty and dump everything the terminal received.

The console only takes over the screen when stdout and stdin are terminals, so
the UI paths (banner, tray, `/new`, `/clear`) cannot be exercised through a pipe.
`script(1)` cannot pace its input, and the composer loses keystrokes that arrive
before it attaches, so this harness forks a pty and feeds one line at a time
after the banner has settled; `\\r` submits, which is what the composer expects.

usage: pty-run.py <out-file> <timeout-seconds> <command...>

environment:
  PTY_INPUT_FILE  one line per command, submitted in order (`\\r` is added)
  PTY_SETTLE      seconds to wait before the first line (default 1.5)
  PTY_GAP         seconds between lines (default 0.7)

The raw bytes, escape sequences included, are written to <out-file>. The exit
status is 0 when the child exited within the timeout; a stuck child is killed.
"""
import os
import pty
import select
import signal
import sys
import time

out_path = sys.argv[1]
timeout = float(sys.argv[2])
cmd = sys.argv[3:]

lines = []
input_file = os.environ.get('PTY_INPUT_FILE', '')
if input_file:
    with open(input_file, 'r', encoding='utf-8') as handle:
        lines = [row.rstrip('\n') for row in handle if row.strip() != '']
settle = float(os.environ.get('PTY_SETTLE', '1.5'))
gap = float(os.environ.get('PTY_GAP', '0.7'))

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

chunks = []
deadline = time.time() + timeout
next_send = time.time() + settle
exited = False


def pump(seconds):
    end = time.time() + seconds
    while True:
        left = end - time.time()
        if left <= 0:
            return
        ready, _, _ = select.select([fd], [], [], min(left, 0.1))
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        chunks.append(data)


while time.time() < deadline:
    pump(0.05)
    if lines and time.time() >= next_send:
        try:
            os.write(fd, lines.pop(0).encode() + b'\r')
        except OSError:
            break
        next_send = time.time() + gap
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        done = pid
    if done == pid:
        pump(0.3)
        exited = True
        break
if not exited:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except OSError:
        pass

with open(out_path, 'wb') as handle:
    handle.write(b''.join(chunks))
sys.exit(0 if exited else 1)
