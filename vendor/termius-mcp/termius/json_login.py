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
    {"action": "sync"}
    {"action": "hosts", "sync": true}
    {"action": "test", "host": "<cloud id, id, or label>", "timeout": 15}

A successful sign-in also pulls the inventory with the password it was given,
so the host list is there at once; a failed pull does not fail the sign-in
(the response carries ``synced: false`` and ``sync_error``). ``sync`` pulls
with the remembered vault password.

``hosts`` returns every host for pi's host list, disabled ones included
(the user manages them there), with tags, the route, and the cloud ids of
the jump hosts the route goes through; ``sync: true`` pulls first when the
cache is over 10 minutes old (a failed pull still returns the cache, with
``sync_error``). ``test`` connects to a host along its route, one hop at a
time, authenticates, runs nothing, and reports each hop and its time; on a
failure it names the hop that failed. Neither returns a secret.

Response: ``{"ok": true, ...}`` or ``{"ok": false, "code": ..., "error": ...}``
with code ``otp_required`` (retry with an authenticator code),
``approve_required`` (approve the login in the Termius app, then retry),
``invalid_request``, ``login_failed``, ``not_signed_in``,
``vault_password_required``, or ``sync_failed``. Error text never echoes the
request.
"""
from __future__ import unicode_literals

import json
import sys
import time

from .redact import redact_text, vault_secrets


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


def _pull(runtime, password, secrets=()):
    """Pull the inventory; return the sync fields of a response."""
    from .sync import pull
    try:
        data = pull(runtime, password)
    except Exception as exc:  # pylint: disable=broad-except
        return {'synced': False, 'sync_error': redact_text(str(exc), list(secrets))}
    return {'synced': True, 'hosts': data.get('hosts', 0), 'last_synced': data.get('last_synced') or ''}


def _hosts(runtime, request):
    from .core.models.terminal import Host
    from .core.ssh_merge import get_merged_ssh_config
    from .mcp.tools import host_route, host_row, tags_by_host
    from .policy import PolicyError, load_policy, policy_key
    from .sync import ensure_fresh, is_signed_in, last_synced_raw
    response = {'ok': True, 'logged_in': is_signed_in(runtime.config)}
    if request.get('sync') and response['logged_in']:
        try:
            ensure_fresh(runtime, ttl=600)
        except Exception as exc:  # pylint: disable=broad-except
            response['sync_error'] = redact_text(str(exc), vault_secrets(runtime))
    try:
        policy = load_policy()
    except PolicyError as exc:
        return _fail('policy_unreadable', str(exc))
    tags = tags_by_host(runtime)
    rows = []
    for host in runtime.storage.get_all(Host):
        row = host_row(runtime, host, policy, tags)
        hops = host_route(runtime, host, policy)[0] or []
        row['via'] = [policy_key(hop) for hop, _ in hops]
        row['port'] = int(get_merged_ssh_config(host).port or 22)
        row['os'] = host.os_name or None
        rows.append(row)
    response['hosts'] = rows
    response['last_synced'] = last_synced_raw(runtime.config)
    return response


def _find_host(runtime, name):
    from .core.models.terminal import Host
    from .core.ssh_merge import HostLookupError, find_host
    from .policy import policy_key
    for host in runtime.storage.get_all(Host):
        if policy_key(host) == str(name):
            return host
    try:
        return find_host(runtime.storage, name)
    except HostLookupError:
        return None


def _test(runtime, request):
    from .core.ssh_control import close_quiet
    from .mcp.tools import ToolError, host_route, resolve_connection
    from .policy import PolicyError, load_policy
    from .core.ssh_exec import connect_host
    host = _find_host(runtime, request.get('host'))
    if host is None:
        return _fail('host_not_found', 'Host not found: {}'.format(request.get('host')))
    try:
        policy = load_policy()
        target, hops, proxy = resolve_connection(runtime, host, policy)
    except PolicyError as exc:
        return _fail('policy_unreadable', str(exc))
    except ToolError as exc:
        return _fail(exc.code or 'route_unavailable', str(exc), vault_secrets(runtime))
    route = host_route(runtime, host, policy)[2]
    try:
        timeout = max(1, int(request.get('timeout') or 15))
    except (TypeError, ValueError):
        timeout = 15
    stages = []
    started = time.monotonic()
    try:
        client, _ = connect_host(
            target, timeout=timeout, route=hops, proxy=proxy, on_stage=stages.append,
        )
    except Exception as exc:  # pylint: disable=broad-except
        sequence = list(hops) + [target]
        failed = sequence[min(len(stages), len(sequence) - 1)]
        response = _fail('test_failed', str(exc), vault_secrets(runtime))
        response.update({
            'route': route, 'stages': stages,
            'failed': {'label': failed.label, 'address': failed.address, 'port': failed.port},
        })
        return response
    close_quiet(client)
    return {
        'ok': True, 'route': route, 'stages': stages,
        'seconds': round(time.monotonic() - started, 3),
    }


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
    if action == 'hosts':
        return _hosts(runtime, request)
    if action == 'test':
        return _test(runtime, request)
    if action == 'sync':
        from .sync import is_signed_in
        from .vault import resolve
        if not is_signed_in(runtime.config):
            return _fail('not_signed_in', 'Not signed in; run /termius login.')
        password = resolve(runtime)
        if not password:
            return _fail('vault_password_required', 'The vault password is not remembered; run /termius login again.')
        result = _pull(runtime, password, [password])
        if not result['synced']:
            return _fail('sync_failed', 'Cloud pull failed: {}'.format(result['sync_error']))
        return dict(result, ok=True)

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
    response = {
        'ok': True,
        'username': data.get('username'),
        'vault_remembered': bool(data.get('vault_remembered')),
    }
    response.update(_pull(runtime, request.get('password'), secrets))
    return response


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
