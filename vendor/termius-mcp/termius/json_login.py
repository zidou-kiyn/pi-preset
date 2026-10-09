# -*- coding: utf-8 -*-
"""``termius login-json``: sign in from a parent process (pi-preset).

pi's /termius command collects the credentials in its own UI and hands them
to this process on stdin, so they never pass through the model, the MCP
protocol, argv, or the environment. One JSON object in, one JSON line out.

Request::

    {"action": "google_url"}
    {"action": "email", "username": "...", "password": "...", "otp": "..."}
    {"action": "google", "callback_url": "termius://...", "password": "...", "otp": "..."}
    {"action": "logout"}
    {"action": "status"}

Response: ``{"ok": true, ...}`` or ``{"ok": false, "code": ..., "error": ...}``
with code ``otp_required`` (retry with an authenticator code),
``approve_required`` (approve the login in the Termius app, then retry),
``invalid_request``, or ``login_failed``. Error text never echoes the request.
"""
from __future__ import unicode_literals

import json
import sys

from .redact import redact_text


def _fail(code, message, secrets=()):
    return {'ok': False, 'code': code, 'error': redact_text(message, list(secrets))}


def _classify(exc):
    text = str(exc)
    lowered = text.lower()
    if 'requires otp' in lowered or 'otp' in lowered and 'required' in lowered:
        return 'otp_required'
    if 'needs approval' in lowered:
        return 'approve_required'
    return 'login_failed'


def handle(request, runtime_factory):
    """Process one request dict and return the response dict."""
    if not isinstance(request, dict):
        return _fail('invalid_request', 'Request must be a JSON object')
    action = str(request.get('action') or '').strip().lower()
    secrets = [
        value for value in (request.get('password'), request.get('otp'), request.get('callback_url'))
        if isinstance(value, str) and value
    ]

    if action == 'google_url':
        from .session import login_google_start
        data = login_google_start()
        return {'ok': True, 'url': data['url']}

    runtime = runtime_factory()
    if action == 'status':
        from .sync import status_payload
        return dict(status_payload(runtime), ok=True)
    if action == 'logout':
        from .session import logout
        return logout(runtime)

    from .session import login_email, login_google_complete
    otp = request.get('otp') or None
    try:
        if action == 'email':
            data = login_email(
                runtime, request.get('username'), request.get('password'),
                otp=otp, remember_password=True,
            )
        elif action == 'google':
            data = login_google_complete(
                runtime, request.get('callback_url'), request.get('password'),
                otp=otp, remember_password=True,
            )
        else:
            return _fail('invalid_request', 'Unknown action: {}'.format(action))
    except Exception as exc:  # pylint: disable=broad-except
        return _fail(_classify(exc), str(exc), secrets)
    return {
        'ok': True,
        'username': data.get('username'),
        'vault_remembered': bool(data.get('vault_remembered')),
    }


def main(stdin=None, stdout=None, runtime_factory=None):
    """Read one request from stdin, write one JSON line to stdout."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    if runtime_factory is None:
        from .runtime import Runtime
        runtime_factory = Runtime
    try:
        request = json.loads(stdin.read() or '{}')
    except ValueError:
        response = _fail('invalid_request', 'stdin is not JSON')
    else:
        try:
            response = handle(request, runtime_factory)
        except Exception as exc:  # pylint: disable=broad-except
            response = _fail('login_failed', str(exc))
    stdout.write(json.dumps(response, default=str) + '\n')
    stdout.flush()
    return 0 if response.get('ok') else 1
