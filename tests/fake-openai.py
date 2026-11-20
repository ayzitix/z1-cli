#!/usr/bin/env python3
"""A deterministic OpenAI-compatible SSE server for the density pty test.

The stock mock returns exactly one tool call per assistant message, which cannot
prove that medium folds *several* same-family calls into one line. This server
answers:

- the session-title request with a short title;
- the first agent request with three `read` tool calls in one assistant message;
- a request that already carries tool results with a plain text answer.

It binds an ephemeral loopback port, writes it to the file named by argv[1], and
serves until killed. Nothing leaves 127.0.0.1.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_FILE = sys.argv[1] if len(sys.argv) > 1 else ''
# Optional: the second read names this path, which makes it fail.
FAIL_PATH = sys.argv[2] if len(sys.argv) > 2 else ''


def tool_calls():
    paths = ['a.txt', 'b.txt', 'c.txt']
    if FAIL_PATH:
        paths[1] = FAIL_PATH
    return [
        {
            'index': index,
            'id': f'call_{index + 1}',
            'type': 'function',
            'function': {'name': 'read', 'arguments': json.dumps({'path': path})},
        }
        for index, path in enumerate(paths)
    ]


def sse(handler, chunks):
    handler.send_response(200)
    handler.send_header('content-type', 'text/event-stream')
    handler.send_header('cache-control', 'no-cache')
    # No keep-alive: a pooled provider socket would keep the CLI's event loop
    # alive after `/exit`, and the pty test would wait for its timeout.
    handler.send_header('connection', 'close')
    handler.end_headers()
    handler.close_connection = True
    try:
        for chunk in chunks:
            handler.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
            handler.wfile.flush()
        handler.wfile.write(b'data: [DONE]\n\n')
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass


def stream_tools(handler):
    calls = tool_calls()
    chunks = [
        {'choices': [{'index': 0, 'delta': {'tool_calls': [call]}}]}
        for call in calls
    ]
    chunks.append({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]})
    sse(handler, chunks)


def stream_text(handler, text):
    sse(
        handler,
        [
            {'choices': [{'index': 0, 'delta': {'content': text}}]},
            {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
        ],
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, _format, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get('content-length', '0') or '0')
        raw = self.rfile.read(length) if length > 0 else b'{}'
        try:
            body = json.loads(raw.decode('utf-8'))
        except json.JSONDecodeError:
            body = {}
        messages = body.get('messages') or []
        system = next(
            (m.get('content', '') for m in messages if m.get('role') == 'system'),
            '',
        )
        if 'You name chat sessions' in system:
            stream_text(self, 'Density test')
            return
        if any(message.get('role') == 'tool' for message in messages):
            stream_text(self, 'The three reads are done.')
            return
        stream_tools(self)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    if PORT_FILE:
        with open(PORT_FILE, 'w', encoding='utf-8') as handle:
            handle.write(str(port))
    server.serve_forever()


if __name__ == '__main__':
    main()
