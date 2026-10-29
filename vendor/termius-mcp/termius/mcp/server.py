# -*- coding: utf-8 -*-
"""Stdio MCP server for Termius Cloud."""
from __future__ import unicode_literals

import json
import logging
import os
import sys
import threading
import time

from .. import __version__
from ..core.ssh_control import CancelToken
from ..runtime import Runtime
from .protocol import ProtocolError, read_message, write_message
from .tools import HANDLERS, TOOLS, ToolError, call_tool

# OMP and current Cursor speak 2025-11-25. Echo the client's version when we
# implement that revision; otherwise advertise our latest. Always returning
# 2025-06-18 made 2025-11-25-only clients eligible to disconnect after
# initialize (MCP lifecycle: server MUST echo a version it supports).
SUPPORTED_PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18')
PROTOCOL_VERSION = '2025-11-25'
LOGGER = logging.getLogger(__name__)

# pi-preset: seconds between notifications/progress for a running tools/call
# that carries a progressToken. Clients restart their request timeout on
# progress (pi waits 60 s by default), so an exec with a larger timeout is
# not cancelled by the client first.
PROGRESS_INTERVAL = 15.0

# JSON-RPC error codes.
PARSE_ERROR = -32700
INVALID_PARAMS = -32602
METHOD_NOT_FOUND = -32601

INSTRUCTIONS = (
    'SSH into the user\'s Termius hosts: inventory, remote exec, and SFTP '
    'files. Credentials stay inside this server; vault secrets in results '
    'appear as [redacted:...] markers, which a command or file write must '
    'not contain (it is refused). Call status first. If not signed in, ask the user to run '
    '/termius login in pi; there is no login tool and the password must '
    'never be asked for in chat. hosts, host, exec, files, and inventory '
    'auto-pull the vault.'
)


def _json_text(data):
    return json.dumps(data, default=str, separators=(',', ':'))


def _ok(data, summary):
    return {
        'content': [
            {'type': 'text', 'text': summary},
            {'type': 'text', 'text': _json_text(data)},
        ],
        'structuredContent': data,
    }


def _error_result(message, code=None):
    payload = {'error': message}
    if code:
        payload['code'] = code
    return {
        'content': [
            {'type': 'text', 'text': message},
            {'type': 'text', 'text': _json_text(payload)},
        ],
        'structuredContent': payload,
        'isError': True,
    }


def _negotiated_protocol_version(params):
    requested = None
    if isinstance(params, dict):
        requested = params.get('protocolVersion')
    if requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return PROTOCOL_VERSION


def _initialize_result(params=None):
    return {
        'protocolVersion': _negotiated_protocol_version(params),
        'capabilities': {'tools': {'listChanged': False}},
        'serverInfo': {
            'name': 'termius',
            'title': 'Termius Cloud',
            'version': __version__,
        },
        'instructions': INSTRUCTIONS,
    }


def handle_rpc(runtime, message, cancel=None):
    """Return a JSON-RPC response dict, or None for a notification.

    ``cancel`` is an optional CancelToken for a tools/call request.
    """
    method = message.get('method')
    message_id = message.get('id')
    params = message.get('params') or {}
    if method == 'initialize':
        return _rpc_result(message_id, _initialize_result(params))
    if method == 'notifications/initialized':
        return None
    if method == 'tools/list':
        return _rpc_result(message_id, {'tools': TOOLS})
    if method == 'tools/call':
        name = params.get('name')
        arguments = params.get('arguments') or {}
        # An unknown tool or malformed arguments are protocol errors
        # (MCP tools spec), not tool results.
        if name not in HANDLERS:
            return _rpc_error(
                message_id, INVALID_PARAMS, 'Unknown tool: {}'.format(name),
            )
        if not isinstance(arguments, dict):
            return _rpc_error(
                message_id, INVALID_PARAMS, 'arguments must be an object',
            )
        try:
            data, summary = call_tool(runtime, name, arguments, cancel=cancel)
            return _rpc_result(message_id, _ok(data, summary))
        except ToolError as exc:
            return _rpc_result(message_id, _error_result(str(exc), exc.code))
        except Exception as exc:
            LOGGER.exception('Tool %s failed', name)
            return _rpc_result(
                message_id, _error_result(str(exc), 'internal_error')
            )
    if method == 'ping':
        return _rpc_result(message_id, {})
    if message_id is not None:
        return _rpc_error(
            message_id, METHOD_NOT_FOUND, 'Method not found: {}'.format(method),
        )
    return None


def _rpc_result(message_id, result):
    return {'jsonrpc': '2.0', 'id': message_id, 'result': result}


def _rpc_error(message_id, code, message):
    return {
        'jsonrpc': '2.0',
        'id': message_id,
        'error': {'code': code, 'message': message},
    }


def _progress_token(message):
    """The request's ``_meta.progressToken`` (a string or integer), or None."""
    params = message.get('params')
    meta = params.get('_meta') if isinstance(params, dict) else None
    token = meta.get('progressToken') if isinstance(meta, dict) else None
    if isinstance(token, bool) or not isinstance(token, (str, int)):
        return None
    return token


def watch_parent(interval=1.0, getppid=os.getppid, exit_now=os._exit, sleep=time.sleep):
    """Exit when the client process is gone (pi-preset).

    End of stdin already stops the server, but only between requests: a
    request in progress (a long ``exec``) would keep the server and its SSH
    connections alive after the client was killed. On POSIX the parent
    changes when it dies (the server is re-parented), so a daemon thread
    exits the process then. Returns the thread, or None on Windows.
    """
    if os.name == 'nt':
        return None
    parent = getppid()

    def run():
        while True:
            sleep(interval)
            if getppid() != parent:
                LOGGER.warning('Client process %s is gone; exiting.', parent)
                exit_now(0)
                return

    thread = threading.Thread(target=run, name='parent-watch', daemon=True)
    thread.start()
    return thread


def _request_key(message_id):
    """Key for an in-flight request. JSON-RPC ids are strings or numbers."""
    return json.dumps(message_id, sort_keys=True)


class StdioServer(object):
    """MCP stdio server that runs each tools/call in its own thread.

    The reader thread answers initialize, tools/list, and ping at once,
    so a slow SSH command does not block other requests. A
    notifications/cancelled message cancels the matching call: its SSH
    connection is closed and no response is sent, as the MCP spec asks.
    """

    def __init__(self, runtime, stdin, stdout,
                 progress_interval=PROGRESS_INTERVAL):
        self.runtime = runtime
        self.stdin = stdin
        self.stdout = stdout
        self.progress_interval = progress_interval
        self._write_lock = threading.Lock()
        self._calls_lock = threading.Lock()
        self._calls = {}
        self._threads = []

    def serve(self):
        """Serve until EOF on stdin, then wait for running calls."""
        while True:
            try:
                message = read_message(self.stdin)
            except ProtocolError as exc:
                LOGGER.warning('Bad MCP frame: %s', exc)
                self._write(_rpc_error(None, PARSE_ERROR, str(exc)))
                continue
            if message is None:
                break
            if isinstance(message, dict):
                self.dispatch(message)
        self.wait()

    def dispatch(self, message):
        method = message.get('method')
        if method == 'tools/call' and message.get('id') is not None:
            self._start_call(message)
            return
        if method == 'notifications/cancelled':
            self.cancel(message.get('params') or {})
            return
        response = handle_rpc(self.runtime, message)
        if response is not None:
            self._write(response)

    def cancel(self, params):
        """Cancel the in-flight request named by ``params.requestId``."""
        if not isinstance(params, dict) or 'requestId' not in params:
            return
        key = _request_key(params.get('requestId'))
        with self._calls_lock:
            token = self._calls.get(key)
        if token is None:
            return
        LOGGER.info(
            'Cancelling request %s: %s', key, params.get('reason') or '',
        )
        token.cancel()

    def wait(self, timeout=None):
        """Wait for running calls. Each call ends within its own timeout."""
        with self._calls_lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(timeout)

    def _start_call(self, message):
        key = _request_key(message.get('id'))
        token = CancelToken()
        thread = threading.Thread(
            target=self._run_call,
            args=(key, token, message),
            name='mcp-call-{}'.format(key),
        )
        thread.daemon = True
        with self._calls_lock:
            self._calls[key] = token
            self._threads = [t for t in self._threads if t.is_alive()]
            self._threads.append(thread)
        thread.start()

    def _run_call(self, key, token, message):
        done = threading.Event()
        self._start_progress(message, done)
        try:
            response = handle_rpc(self.runtime, message, cancel=token)
        except BaseException as exc:  # pylint: disable=broad-except
            LOGGER.exception('Request %s failed', key)
            response = _rpc_result(
                message.get('id'), _error_result(str(exc), 'internal_error'),
            )
        finally:
            # Set before the response is written: no progress follows it.
            done.set()
            with self._calls_lock:
                if self._calls.get(key) is token:
                    del self._calls[key]
        if token.cancelled:
            return
        self._write(response)

    def _start_progress(self, message, done):
        """Send notifications/progress every ``progress_interval`` seconds
        until ``done`` is set, when the request asked for progress.

        The message names the tool and the elapsed time only: command output
        could hold secrets, and redaction happens on the final result.
        """
        token = _progress_token(message)
        if token is None or not self.progress_interval:
            return None
        params = message.get('params') or {}
        name = params.get('name') if isinstance(params, dict) else None
        started = time.monotonic()

        def run():
            count = 0
            while not done.wait(self.progress_interval):
                count += 1
                self._write({
                    'jsonrpc': '2.0',
                    'method': 'notifications/progress',
                    'params': {
                        'progressToken': token,
                        'progress': count,
                        'message': '{} running for {} s'.format(
                            name or 'tool', int(time.monotonic() - started),
                        ),
                    },
                }, unless=done)

        thread = threading.Thread(target=run, name='mcp-progress', daemon=True)
        thread.start()
        return thread

    def _write(self, payload, unless=None):
        with self._write_lock:
            if unless is not None and unless.is_set():
                return
            try:
                write_message(self.stdout, payload)
            except (OSError, ValueError) as exc:
                LOGGER.warning('Could not write MCP response: %s', exc)


def run_stdio(runtime=None, stdin=None, stdout=None):
    """Serve MCP over stdin/stdout until EOF."""
    runtime = runtime or Runtime()
    if stdin is None:
        watch_parent()
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    StdioServer(runtime, stdin, stdout).serve()
