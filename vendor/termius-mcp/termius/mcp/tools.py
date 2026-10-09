# -*- coding: utf-8 -*-
"""MCP tool definitions and handlers."""
from __future__ import unicode_literals

import logging

from ..account.managers import AccountManager
from ..core.exceptions import ApiError, NotSignedIn
from ..core.models.terminal import Group, Host, Identity, Snippet, SshKey
from ..core.ssh_command import render_command
from ..core.ssh_exec import SshExecError, run_host_command
from ..core.ssh_files import ACTIONS as FILE_ACTIONS
from ..core.ssh_files import SshFileError, run_file_action
from ..core.proxy import ProxyError, proxy_for
from ..core.ssh_merge import HostLookupError, find_host, get_jump_route, get_merged_ssh_config
from ..redact import redact_payload, redact_text, vault_secrets
from ..sync import (
    ensure_fresh, inventory_counts, last_synced_raw, pull, status_payload,
)
from ..vault import VaultPasswordRequired

# pi-preset: sign-in never goes through the model. There is no login tool;
# the user signs in with /termius login in pi (or `termius login`).
SIGN_IN_HINT = (
    'Ask the user to sign in with /termius login in pi (or `termius login` '
    'in a terminal); never ask for the password in chat.'
)


LOGGER = logging.getLogger(__name__)


class ToolError(Exception):
    """User-facing tool failure."""

    def __init__(self, message, code=None):
        super(ToolError, self).__init__(message)
        self.code = code


def _input_schema(properties=None, required=None):
    """JSON Schema object for an MCP tool (spec: type must be object).

    Do not set additionalProperties:false. Harnesses inject extra fields
    (OMP's intent `i`) and no-arg tools with a closed empty object are
    dropped or rejected by several MCP schema converters.
    """
    schema = {'type': 'object', 'properties': properties or {}}
    if required:
        schema['required'] = required
    return schema


def _tool(name, title, description, schema, hints):
    """One MCP Tool: name, title, description, inputSchema, annotations.

    Clients display title, then annotations.title, then name. description is
    the model-facing hint. outputSchema is required once we return
    structuredContent (MCP tools spec). Shapes vary per tool; object is
    the honest common envelope.
    """
    annotations = {'title': title}
    annotations.update(hints)
    return {
        'name': name,
        'title': title,
        'description': description,
        'inputSchema': schema,
        'outputSchema': {'type': 'object'},
        'annotations': annotations,
    }


_READ = {'readOnlyHint': True, 'openWorldHint': True}
_WRITE = {
    'readOnlyHint': False,
    'destructiveHint': False,
    'idempotentHint': False,
    'openWorldHint': True,
}
_DESTRUCTIVE = {
    'readOnlyHint': False,
    'destructiveHint': True,
    'idempotentHint': False,
    'openWorldHint': True,
}


TOOLS = [
    _tool(
        'status',
        'Termius Status',
        (
            'Show Termius login state, last cloud sync time, whether the '
            'local vault cache is stale, whether the vault password is '
            'remembered, and inventory counts. Pulls only when signed in '
            'but never synced. Call this first when you do not know if the '
            'user is signed in.'
        ),
        _input_schema(),
        _READ,
    ),
    _tool(
        'sync',
        'Sync Termius Vault',
        (
            'Force a pull from Termius Cloud now. hosts and host pull '
            'when their cache is older than 600 seconds; exec, files, and '
            'inventory pull when it is older than TERMIUS_SYNC_TTL. Uses the '
            'vault password the user remembered when signing in. Returns the '
            'new last_synced and the counts.'
        ),
        _input_schema(),
        _WRITE,
    ),
    _tool(
        'hosts',
        'List Hosts',
        (
            'List Termius hosts (id, label, address, group, username). '
            'Pulls Termius Cloud when the local cache is older than 600 '
            'seconds. If that pull fails, returns the local cache and sets '
            'stale to true. Filter with query '
            'against label, address, group, or username. Use host for full '
            'SSH settings. Use exec to run a command. Use files for SFTP.'
        ),
        _input_schema({
            'query': {
                'type': 'string',
                'description': (
                    'Optional case-insensitive substring on label, '
                    'address, group, or username'
                ),
            },
        }),
        _READ,
    ),
    _tool(
        'host',
        'Host Details',
        (
            'One host plus merged SSH settings and a generated ssh(1) '
            'command. Pulls Termius Cloud when the local cache is older '
            'than 600 seconds. If that pull fails, returns the local cache '
            'and sets stale to true. name is id or '
            'label. Does not return passwords or private keys.'
        ),
        _input_schema({
            'name': {
                'type': 'string',
                'description': 'Host numeric id or exact label',
            },
        }, ['name']),
        _READ,
    ),
    _tool(
        'exec',
        'Run SSH Command',
        (
            'Run a shell command on a Termius host over SSH. Required: '
            'name (host numeric id or exact label from hosts) and '
            'command; optional timeout in seconds. Uses the '
            'username, password, or key from the vault. Auto-pulls a stale '
            'vault first (TERMIUS_SYNC_TTL). Returns stdout, stderr, and '
            'exit_code. Never echo '
            'secrets from the output unless the user asked for that command.'
        ),
        _input_schema({
            'name': {
                'type': 'string',
                'description': 'Host numeric id or exact label',
            },
            'command': {
                'type': 'string',
                'description': 'Remote shell command',
            },
            'timeout': {
                'type': 'integer',
                'description': 'Seconds to wait (default 60)',
            },
        }, ['name', 'command']),
        _DESTRUCTIVE,
    ),
    _tool(
        'files',
        'SFTP Files',
        (
            'Manage files on a Termius host over SFTP. Required: name '
            '(host numeric id or exact label from hosts) and action; '
            'path is required for every action except list (defaults '
            'to .). '
            'Uses the username, '
            'password, or key from the vault. Auto-pulls a stale vault '
            'first (TERMIUS_SYNC_TTL). action=list lists a directory; stat '
            'shows one path; '
            'read returns file content (utf-8 or base64, max 200000 '
            'bytes); write uploads content; get copies remote -> '
            'local_path on this machine; put copies local_path -> remote; '
            'mkdir creates a directory (recursive=true creates parents); '
            'rm deletes a file or empty dir (recursive=true deletes a '
            'tree); rename moves a remote path (needs dest). Prefer this '
            'over exec for copy and edit. Never echo secrets from file '
            'content unless the user asked.'
        ),
        _input_schema({
            'name': {
                'type': 'string',
                'description': 'Host numeric id or exact label',
            },
            'action': {
                'type': 'string',
                'enum': list(FILE_ACTIONS),
                'description': 'SFTP operation',
            },
            'path': {
                'type': 'string',
                'description': (
                    'Remote path. Default . (login directory) for list'
                ),
            },
            'local_path': {
                'type': 'string',
                'description': (
                    'Path on the MCP host filesystem (get and put)'
                ),
            },
            'dest': {
                'type': 'string',
                'description': 'Destination remote path (rename)',
            },
            'content': {
                'type': 'string',
                'description': 'File text or base64 payload (write)',
            },
            'encoding': {
                'type': 'string',
                'enum': ['utf-8', 'base64'],
                'description': 'write payload encoding. Default utf-8',
            },
            'recursive': {
                'type': 'boolean',
                'description': (
                    'mkdir/write/put create parents; rm deletes a tree. '
                    'Default false'
                ),
            },
            'timeout': {
                'type': 'integer',
                'description': 'Seconds to wait (default 60)',
            },
        }, ['name', 'action']),
        _DESTRUCTIVE,
    ),
    _tool(
        'inventory',
        'List Inventory',
        (
            'List groups, identities, SSH keys, or snippets. Auto-pulls a '
            'stale vault first (TERMIUS_SYNC_TTL). Identities and keys omit '
            'secret material; snippets list labels only.'
        ),
        _input_schema({
            'kind': {
                'type': 'string',
                'enum': ['groups', 'identities', 'keys', 'snippets'],
                'description': 'Which inventory set to list',
            },
        }, ['kind']),
        _READ,
    ),
]


# hosts and host use a short TTL so two calls close together share one pull.
# This is not TERMIUS_SYNC_TTL. A failed pull still returns the local cache.
HOST_PULL_TTL = 600


def _bool_arg(arguments, key, default=True):
    if key not in arguments or arguments.get(key) is None:
        return default
    value = arguments.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes')
    return bool(value)


def _pull_failed(exc, allow_stale):
    if not allow_stale:
        raise ToolError(
            'Cloud pull failed: {}'.format(exc), code='sync_failed'
        )
    LOGGER.warning('Cloud pull failed; serving the local cache: %s', exc)
    return {'pulled': False, 'stale': True, 'sync_error': str(exc)}


def _auto_sync(runtime, ttl=None, allow_stale=False):
    try:
        result = ensure_fresh(runtime, ttl=ttl)
    except NotSignedIn as exc:
        raise ToolError(str(exc), code='not_signed_in')
    except VaultPasswordRequired as exc:
        raise ToolError(str(exc), code='vault_password_required')
    except Exception as exc:  # pylint: disable=broad-except
        return _pull_failed(exc, allow_stale)
    if not isinstance(result, dict):
        result = {}
    result = dict(result)
    result['stale'] = False
    return result


def _apply_sync_state(data, sync):
    """Mark a host payload when the pull failed and the cache was used."""
    if sync.get('stale'):
        data['stale'] = True
        data['sync_error'] = sync.get('sync_error') or ''
    return data


def _host_row(runtime, host):
    ssh_config = get_merged_ssh_config(host)
    identity = ssh_config.identity
    return {
        'id': host.id,
        'label': host.label,
        'address': host.address,
        'group': getattr(host.group, 'label', None),
        'username': identity.username if identity else None,
        'has_password': bool(identity and identity.password),
    }


def _matches_query(row, query):
    if not query:
        return True
    needle = query.lower()
    haystacks = (
        str(row.get('label') or ''),
        str(row.get('address') or ''),
        str(row.get('group') or ''),
        str(row.get('username') or ''),
    )
    return any(needle in item.lower() for item in haystacks)


def handle_status(runtime, arguments):
    data = status_payload(runtime)
    # Signed in but never synced (e.g. signed in with the CLI): pull once, so
    # status does not report an empty inventory that is merely not loaded.
    if data['logged_in'] and not data['last_synced'] and data['vault_remembered']:
        sync = _auto_sync(runtime, ttl=HOST_PULL_TTL, allow_stale=True)
        data = _apply_sync_state(status_payload(runtime), sync)
    return data, _status_summary(data)


def _status_summary(data):
    if not data['logged_in']:
        return 'Not signed in. ' + SIGN_IN_HINT
    stale = 'stale' if data['stale'] else 'fresh'
    return 'Signed in as {}, {} hosts, cache {}.'.format(
        data['username'] or 'unknown', data['hosts'], stale
    )


def handle_sync(runtime, arguments):
    from ..vault import resolve
    password = resolve(runtime)
    if not password:
        raise ToolError(
            'Vault password is not available. ' + SIGN_IN_HINT,
            code='vault_password_required',
        )
    try:
        data = pull(runtime, password)
    except NotSignedIn as exc:
        raise ToolError(str(exc), code='not_signed_in')
    except Exception as exc:
        raise ToolError(
            'Cloud pull failed: {}'.format(exc), code='sync_failed'
        )
    data['counts'] = inventory_counts(runtime)
    return data, 'Pulled inventory. last_synced={}.'.format(
        data.get('last_synced') or last_synced_raw(runtime.config)
    )


def handle_hosts(runtime, arguments):
    sync = _auto_sync(runtime, ttl=HOST_PULL_TTL, allow_stale=True)
    query = arguments.get('query') or ''
    rows = []
    for host in runtime.storage.get_all(Host):
        row = _host_row(runtime, host)
        if _matches_query(row, query):
            rows.append(row)
    data = _apply_sync_state({'hosts': rows, 'count': len(rows)}, sync)
    if data.get('stale'):
        summary = (
            '{} hosts. Cloud pull failed; this list is the local cache.'
        ).format(len(rows))
    else:
        summary = '{} hosts.'.format(len(rows))
    return data, summary


def handle_host(runtime, arguments):
    sync = _auto_sync(runtime, ttl=HOST_PULL_TTL, allow_stale=True)
    try:
        host = find_host(runtime.storage, arguments.get('name'))
    except HostLookupError as exc:
        raise ToolError(str(exc), code='host_not_found')
    ssh_config = get_merged_ssh_config(host)
    identity = ssh_config.identity
    ssh_key = ssh_config.get_ssh_key()
    ssh_config['agent_forwarding'] = (
        AccountManager(runtime.config).get_settings().get('agent_forwarding')
    )
    route = _route(runtime, host)
    jumps = [
        '{}@{}{}'.format(
            (cfg.identity.username if cfg.identity else '') or '', hop.address,
            ':{}'.format(cfg.port) if cfg.port and int(cfg.port) != 22 else '',
        ).lstrip('@')
        for hop, cfg in route
    ]
    command = render_command(ssh_config, host.address)
    if jumps:
        command = command.replace('ssh ', 'ssh -J {} '.format(','.join(jumps)), 1)
    snippet = ssh_config.startup_snippet
    data = {
        'id': host.id,
        'label': host.label,
        'address': host.address,
        'group': getattr(host.group, 'label', None),
        'port': ssh_config.port,
        'username': identity.username if identity else None,
        'has_password': bool(identity and identity.password),
        'ssh_key': ssh_key.label if ssh_key else None,
        'strict_host_key_check': ssh_config.strict_host_key_check,
        'use_ssh_key': ssh_config.use_ssh_key,
        'timeout': ssh_config.timeout,
        'keep_alive_packages': ssh_config.keep_alive_packages,
        'agent_forwarding': ssh_config.agent_forwarding,
        'startup_snippet': snippet.label if snippet else None,
        'jump_hosts': [hop.label or hop.address for hop, _ in route],
        'proxy': _proxy_text(host, route),
        'ssh_command': command,
    }
    _apply_sync_state(data, sync)
    summary = '{} ({})'.format(host.label or host.address, host.address)
    if data.get('stale'):
        summary = '{} Cloud pull failed; this is the local cache.'.format(
            summary
        )
    return data, summary


def _route(runtime, host):
    try:
        return get_jump_route(runtime.storage, host)
    except HostLookupError as exc:
        raise ToolError(str(exc), code='host_not_found')


def _proxy_text(host, route):
    if route:
        return None
    try:
        proxy = proxy_for(host.address)
    except ProxyError as exc:
        return 'invalid proxy setting: {}'.format(exc)
    return proxy.describe() if proxy else None


def handle_exec(runtime, arguments):
    _auto_sync(runtime)
    command = arguments.get('command')
    if not command or not str(command).strip():
        raise ToolError('command is required', code='invalid_argument')
    try:
        host = find_host(runtime.storage, arguments.get('name'))
    except HostLookupError as exc:
        raise ToolError(str(exc), code='host_not_found')
    ssh_config = get_merged_ssh_config(host)
    timeout = _int_timeout(arguments.get('timeout'))
    try:
        result = run_host_command(
            host, ssh_config, command, timeout=timeout,
            route=_route(runtime, host),
        )
    except SshExecError as exc:
        raise ToolError(str(exc), code='ssh_failed')
    result['ok'] = result.get('exit_code') == 0
    summary = 'exit {} on {}.'.format(
        result.get('exit_code'), result.get('host')
    )
    return result, summary


def _int_timeout(value):
    if value is None:
        return 60
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ToolError('timeout must be an integer', code='invalid_argument')


def _lookup_host(runtime, name):
    try:
        return find_host(runtime.storage, name)
    except HostLookupError as exc:
        raise ToolError(str(exc), code='host_not_found')


def _files_path(arguments, action):
    path = arguments.get('path')
    if path is not None and str(path).strip() != '':
        return path
    if action == 'list':
        return '.'
    raise ToolError('path is required', code='invalid_argument')


def _files_args(arguments):
    action = (arguments.get('action') or '').strip().lower()
    if action not in FILE_ACTIONS:
        raise ToolError(
            'action must be {}'.format(', '.join(FILE_ACTIONS)),
            code='invalid_argument',
        )
    return action, _files_path(arguments, action), _int_timeout(
        arguments.get('timeout')
    )


def _files_extra(arguments):
    return {
        'local_path': arguments.get('local_path'),
        'dest': arguments.get('dest'),
        'content': arguments.get('content'),
        'encoding': arguments.get('encoding'),
        'recursive': _bool_arg(arguments, 'recursive', False),
    }


def _invoke_files(runtime, host, action, path, timeout, arguments):
    ssh_config = get_merged_ssh_config(host)
    try:
        result = run_file_action(
            host, ssh_config, action, path,
            timeout=timeout, extra=_files_extra(arguments),
            route=_route(runtime, host),
        )
    except SshFileError as exc:
        raise ToolError(str(exc), code='file_failed')
    except SshExecError as exc:
        raise ToolError(str(exc), code='ssh_failed')
    result.setdefault('ok', True)
    return result


def _files_summary(result):
    action = result.get('action')
    host = result.get('host')
    path = result.get('path')
    known = {
        'list': '{} entries in {} on {}.'.format(
            result.get('count'), path, host
        ),
        'read': 'read {} ({} bytes) on {}.'.format(
            path, result.get('size'), host
        ),
        'stat': '{} {} on {}.'.format(result.get('type'), path, host),
        'get': 'get {} -> {} on {}.'.format(
            path, result.get('local_path'), host
        ),
        'put': 'put {} -> {} on {}.'.format(
            result.get('local_path'), path, host
        ),
        'rename': 'rename {} -> {} on {}.'.format(
            path, result.get('dest'), host
        ),
    }
    if action in known:
        return known[action]
    return '{} {} on {}.'.format(action, path, host)


def handle_files(runtime, arguments):
    _auto_sync(runtime)
    action, path, timeout = _files_args(arguments)
    host = _lookup_host(runtime, arguments.get('name'))
    result = _invoke_files(runtime, host, action, path, timeout, arguments)
    return result, _files_summary(result)


def handle_inventory(runtime, arguments):
    _auto_sync(runtime)
    kind = (arguments.get('kind') or '').strip().lower()
    if kind == 'groups':
        rows = [
            {'id': group.id, 'label': group.label}
            for group in runtime.storage.get_all(Group)
        ]
    elif kind == 'identities':
        rows = []
        for ident in runtime.storage.get_all(Identity):
            if ident.is_visible is False:
                continue
            rows.append({
                'id': ident.id,
                'label': ident.label,
                'username': ident.username,
                'has_password': bool(ident.password),
                'ssh_key': ident.ssh_key.label if ident.ssh_key else None,
            })
    elif kind == 'keys':
        rows = [
            {
                'id': key.id,
                'label': key.label,
                'has_private_key': bool(key.private_key),
            }
            for key in runtime.storage.get_all(SshKey)
        ]
    elif kind == 'snippets':
        rows = [
            # pi-preset: snippet scripts can hold credentials; labels only.
            {'id': snippet.id, 'label': snippet.label}
            for snippet in runtime.storage.get_all(Snippet)
        ]
    else:
        raise ToolError(
            'kind must be groups, identities, keys, or snippets',
            code='invalid_argument',
        )
    data = {'kind': kind, 'items': rows, 'count': len(rows)}
    return data, '{} {}.'.format(len(rows), kind)


HANDLERS = {
    'status': handle_status,
    'sync': handle_sync,
    'hosts': handle_hosts,
    'host': handle_host,
    'exec': handle_exec,
    'files': handle_files,
    'inventory': handle_inventory,
}


def call_tool(runtime, name, arguments):
    """Dispatch a tool. Returns (data, summary) or raises ToolError.

    pi-preset: every result and error text is scrubbed of vault secrets
    (see termius.redact) before it leaves the process.
    """
    handler = HANDLERS.get(name)
    if handler is None:
        raise ToolError('Unknown tool: {}'.format(name), code='unknown_tool')
    try:
        data, summary = handler(runtime, arguments or {})
    except ToolError as exc:
        secrets = vault_secrets(runtime)
        raise ToolError(redact_text(str(exc), secrets), code=exc.code)
    secrets = vault_secrets(runtime)
    return redact_payload(data, secrets), redact_text(summary, secrets)
