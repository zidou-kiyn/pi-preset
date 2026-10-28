# -*- coding: utf-8 -*-
"""Per-host settings from pi's /termius (pi-preset).

pi keeps them in the server's config.json and passes its path in
``TERMIUS_MCP_POLICY``. The file is re-read whenever it changes, so a change
made in /termius applies to the next call without restarting the server.

The server uses:

``hosts.<key>.level == "off"``
    The host is disabled: ``hosts`` leaves it out, ``host`` / ``exec`` /
    ``files`` refuse it. It can still be a jump host for other hosts.
``route`` / ``hosts.<key>.route``
    The global route mode and a per-host override.
``hosts.<key>.proxy``
    A proxy URL for this host; it replaces the proxy setting wherever this
    host's route uses a proxy.

``<key>`` is the host's Termius cloud id (``local:<id>`` for a host that has
none), so renaming a host keeps its settings.

Route modes (docs/termius-design.md, 2.4):

``termius``
    The Termius jump host chain, first hop dialed directly. A host without a
    chain uses the proxy setting (with its bypass list).
``termius-proxy``
    The chain with its first hop through the proxy. A host without a chain
    uses the proxy setting.
``direct``
    No chain, no proxy.
``proxy``
    No chain, through the proxy.

A route that needs a proxy when none is configured is an error. Nothing falls
back to another route: the user picks routes to know how a host is reached.

Access levels other than ``off`` are pi's concern (it asks for approval),
as is the baseline for the "new" mark.
"""
from __future__ import unicode_literals

import io
import json
import os
import threading
import time

from .core.proxy import Proxy, ProxyError, proxy_for, proxy_from_env

POLICY_ENV = 'TERMIUS_MCP_POLICY'
ROUTE_MODES = ('termius', 'termius-proxy', 'direct', 'proxy')
DEFAULT_ROUTE = 'termius'


class PolicyError(Exception):
    """The /termius settings file exists but cannot be read."""


def policy_key(model):
    """The key pi stores a host's settings under: its cloud id."""
    remote = getattr(model, 'remote_instance', None)
    if isinstance(remote, dict):
        value = remote.get('id')
    else:
        value = getattr(remote, 'id', None)
    if value is not None:
        return str(value)
    return 'local:{}'.format(getattr(model, 'id', None))


class Policy(object):
    """The parts of config.json the server acts on."""

    def __init__(self, data=None):
        data = data if isinstance(data, dict) else {}
        route = data.get('route')
        self.route = route if route in ROUTE_MODES else DEFAULT_ROUTE
        hosts = data.get('hosts')
        self.hosts = {}
        if isinstance(hosts, dict):
            for key, entry in hosts.items():
                if isinstance(entry, dict):
                    self.hosts[str(key)] = entry

    def entry(self, key):
        return self.hosts.get(str(key), {}) if key is not None else {}

    def is_disabled(self, key):
        return self.entry(key).get('level') == 'off'

    def route_for(self, key):
        """``(mode, source)``; source is ``host`` for an override, else ``global``."""
        value = self.entry(key).get('route')
        if value in ROUTE_MODES:
            return value, 'host'
        return self.route, 'global'

    def proxy_url_for(self, key):
        value = self.entry(key).get('proxy')
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None


_CACHE = {}
_CACHE_LOCK = threading.Lock()


def _read(path):
    error = None
    # pi replaces the file atomically; the retries cover editors and older
    # writers that truncate first.
    for _ in range(3):
        try:
            with io.open(path, encoding='utf-8') as handle:
                return json.load(handle)
        except (IOError, OSError) as exc:
            if not os.path.exists(path):
                return {}
            error = exc
        except ValueError as exc:
            error = exc
        time.sleep(0.05)
    raise PolicyError(
        'The /termius settings ({}) cannot be read: {}. Ask the user to '
        'open /termius, which rewrites them.'.format(path, error)
    )


def load_policy(environ=None):
    """The current settings. A missing file means nothing is configured;
    an unreadable one raises PolicyError, so a disabled host never becomes
    reachable because its setting could not be read."""
    env = os.environ if environ is None else environ
    path = (env.get(POLICY_ENV) or '').strip()
    if not path:
        return Policy()
    try:
        stat = os.stat(path)
    except OSError:
        return Policy()
    # pi replaces the file by renaming a new one over it: a new inode.
    stamp = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
    with _CACHE_LOCK:
        cached = _CACHE.get(path)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    policy = Policy(_read(path))
    with _CACHE_LOCK:
        _CACHE[path] = (stamp, policy)
    return policy


def _required_proxy(host_proxy, mode, environ):
    proxy = host_proxy or proxy_from_env(environ)
    if proxy is None:
        raise ProxyError(
            'route {} needs a proxy and none is configured (no proxy URL in '
            '/termius and no ALL_PROXY / HTTPS_PROXY / HTTP_PROXY)'.format(mode)
        )
    return proxy


def plan_route(mode, chain, address, host_proxy_url=None, environ=None):
    """``(hops, proxy)`` for a host reached with route ``mode``.

    ``chain`` is the host's Termius jump host chain (any sequence; it is
    returned as the hops when the mode uses it). ``proxy`` carries the first
    TCP connection, or is None for a direct one. Raises ProxyError when the
    mode needs a proxy that is not there or a proxy URL is invalid.
    """
    host_proxy = Proxy(host_proxy_url, 'host setting', []) if host_proxy_url else None
    if mode == 'direct':
        return [], None
    if mode == 'proxy':
        return [], _required_proxy(host_proxy, mode, environ)
    chain = list(chain or [])
    if chain:
        if mode == 'termius-proxy':
            return chain, _required_proxy(host_proxy, mode, environ)
        return chain, None
    if host_proxy is not None:
        return [], host_proxy
    return [], proxy_for(address, environ)


def describe_route(mode, source, hops, proxy, error=None):
    """The route as data for host rows and results (no credentials)."""
    data = {
        'mode': mode,
        'source': source,
        'jump_hosts': [getattr(hop, 'label', None) or getattr(hop, 'address', '') for hop in hops],
        'proxy': proxy.describe() if proxy is not None else None,
    }
    if error:
        data['error'] = error
    return data
