# -*- coding: utf-8 -*-
"""Outbound proxies for SSH connections (pi-preset).

A proxy applies only to hosts reached directly; hosts behind a Termius jump
host chain connect to the first jump host directly (the rest of the route runs
inside SSH).

Where the proxy comes from, first match wins:

1. ``TERMIUS_MCP_PROXY`` (set by pi's ``/termius proxy``): a proxy URL, or
   ``off`` / ``direct`` for no proxy. Hosts in ``TERMIUS_MCP_NO_PROXY``
   (comma separated) bypass it; when that is unset, loopback, private, and
   link-local addresses and ``*.local`` names do.
2. The system variables ``ALL_PROXY``, ``HTTPS_PROXY``, ``HTTP_PROXY`` (any
   case), bypassed by ``NO_PROXY`` plus loopback.

Supported: ``socks5://`` and ``socks5h://`` (the proxy resolves the name;
both send the host name, so DNS happens at the proxy), ``socks4://`` /
``socks4a://``, and ``http://`` (HTTP CONNECT). ``user:password@`` is sent
as SOCKS5 username/password or HTTP basic authentication.
"""
from __future__ import unicode_literals

import base64
import fnmatch
import ipaddress
import os
import socket
import struct

try:  # Python 3
    from urllib.parse import unquote, urlsplit
except ImportError:  # pragma: no cover
    from urlparse import urlsplit  # type: ignore
    from urllib import unquote  # type: ignore

PROXY_ENV = 'TERMIUS_MCP_PROXY'
NO_PROXY_ENV = 'TERMIUS_MCP_NO_PROXY'
SOURCE_ENV = 'TERMIUS_MCP_PROXY_SOURCE'
SYSTEM_PROXY_ENV = ('ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')
SYSTEM_NO_PROXY_ENV = ('NO_PROXY', 'no_proxy')
DEFAULT_BYPASS = ('localhost', '*.local', '127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12',
                  '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10')
SCHEMES = ('socks5', 'socks5h', 'socks4', 'socks4a', 'http')


class ProxyError(Exception):
    """The proxy could not be used or refused the connection."""


class Proxy(object):
    """A parsed proxy URL and where it came from."""

    def __init__(self, url, source, bypass):
        parts = urlsplit(url)
        scheme = (parts.scheme or '').lower()
        if scheme not in SCHEMES:
            raise ProxyError('Unsupported proxy scheme in {} (use socks5://, socks4://, or http://)'.format(source))
        if not parts.hostname:
            raise ProxyError('Proxy URL from {} has no host'.format(source))
        try:
            port = parts.port
        except ValueError:
            raise ProxyError('Proxy URL from {} has an invalid port'.format(source))
        self.scheme = scheme
        self.host = parts.hostname
        self.port = port or (1080 if scheme.startswith('socks') else 8080)
        self.username = unquote(parts.username) if parts.username else None
        self.password = unquote(parts.password) if parts.password else None
        self.source = source
        self.bypass = tuple(bypass)

    def describe(self):
        """The proxy without credentials, for results and status."""
        return '{}://{}:{} ({})'.format(self.scheme, self.host, self.port, self.source)

    def bypasses(self, address):
        """True when ``address`` should be reached directly."""
        return matches_bypass(address, self.bypass)


def _split_list(raw):
    return [item.strip() for item in (raw or '').split(',') if item.strip()]


def matches_bypass(address, patterns):
    """Match a host name or IP against NO_PROXY-style patterns.

    A pattern is ``*`` (everything), a CIDR or IP, ``*.example.com`` /
    ``.example.com`` (subdomains), or an exact name (also matching its
    subdomains, as curl does).
    """
    host = (address or '').strip().strip('[]').lower()
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    for raw in patterns:
        pattern = raw.strip().lower()
        if not pattern:
            continue
        if pattern == '*':
            return True
        if ip is not None:
            try:
                if ip in ipaddress.ip_network(pattern, strict=False):
                    return True
            except ValueError:
                pass
            continue
        if pattern.startswith('*.') or pattern.startswith('.'):
            suffix = pattern.lstrip('*')
            if host.endswith(suffix) or host == suffix.lstrip('.'):
                return True
        elif fnmatch.fnmatchcase(host, pattern) or host.endswith('.' + pattern):
            return True
    return False


def proxy_from_env(environ=None):
    """The configured proxy, or None for direct connections."""
    env = os.environ if environ is None else environ
    explicit = (env.get(PROXY_ENV) or '').strip()
    if explicit:
        if explicit.lower() in ('off', 'direct', 'none'):
            return None
        bypass = _split_list(env.get(NO_PROXY_ENV)) if env.get(NO_PROXY_ENV) is not None else list(DEFAULT_BYPASS)
        return Proxy(explicit, env.get(SOURCE_ENV) or '/termius proxy', bypass)
    for name in SYSTEM_PROXY_ENV:
        value = (env.get(name) or '').strip()
        if value:
            no_proxy = []
            for no_name in SYSTEM_NO_PROXY_ENV:
                no_proxy.extend(_split_list(env.get(no_name)))
            return Proxy(value, name, no_proxy + ['localhost', '127.0.0.0/8', '::1'])
    return None


def proxy_for(address, environ=None):
    """The proxy to use for ``address``, or None."""
    proxy = proxy_from_env(environ)
    if proxy is None or proxy.bypasses(address):
        return None
    return proxy


def _recv_exact(sock, size):
    data = b''
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ProxyError('Proxy closed the connection')
        data += chunk
    return data


def _socks5(sock, proxy, host, port):
    methods = b'\x00\x02' if proxy.username is not None else b'\x00'
    sock.sendall(b'\x05' + struct.pack('B', len(methods)) + methods)
    version, method = struct.unpack('BB', _recv_exact(sock, 2))
    if version != 5:
        raise ProxyError('Not a SOCKS5 proxy')
    if method == 0x02:
        user = (proxy.username or '').encode('utf-8')
        password = (proxy.password or '').encode('utf-8')
        sock.sendall(b'\x01' + struct.pack('B', len(user)) + user + struct.pack('B', len(password)) + password)
        if _recv_exact(sock, 2)[1] != 0:
            raise ProxyError('SOCKS5 proxy rejected the username/password')
    elif method != 0x00:
        raise ProxyError('SOCKS5 proxy accepts none of our authentication methods')
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None and ip.version == 4:
        target = b'\x01' + ip.packed
    elif ip is not None:
        target = b'\x04' + ip.packed
    else:
        name = host.encode('idna')
        target = b'\x03' + struct.pack('B', len(name)) + name
    sock.sendall(b'\x05\x01\x00' + target + struct.pack('>H', port))
    reply = _recv_exact(sock, 4)
    if reply[1] != 0:
        raise ProxyError('SOCKS5 proxy could not connect to {}:{} (reply {})'.format(host, port, reply[1]))
    kind = reply[3]
    if kind == 1:
        _recv_exact(sock, 4 + 2)
    elif kind == 4:
        _recv_exact(sock, 16 + 2)
    elif kind == 3:
        _recv_exact(sock, _recv_exact(sock, 1)[0] + 2)
    else:
        raise ProxyError('SOCKS5 proxy sent an unknown address type')


def _socks4(sock, proxy, host, port):
    user = (proxy.username or '').encode('utf-8') + b'\x00'
    try:
        packed = ipaddress.IPv4Address(host).packed
        tail = b''
    except ValueError:
        if proxy.scheme == 'socks4':
            packed = socket.inet_aton(socket.gethostbyname(host))
            tail = b''
        else:  # socks4a: let the proxy resolve
            packed = b'\x00\x00\x00\x01'
            tail = host.encode('idna') + b'\x00'
    sock.sendall(b'\x04\x01' + struct.pack('>H', port) + packed + user + tail)
    reply = _recv_exact(sock, 8)
    if reply[1] != 0x5A:
        raise ProxyError('SOCKS4 proxy could not connect to {}:{}'.format(host, port))


def _http_connect(sock, proxy, host, port):
    target = '[{}]:{}'.format(host, port) if ':' in host else '{}:{}'.format(host, port)
    lines = ['CONNECT {} HTTP/1.1'.format(target), 'Host: {}'.format(target)]
    if proxy.username is not None:
        token = base64.b64encode('{}:{}'.format(proxy.username, proxy.password or '').encode('utf-8')).decode('ascii')
        lines.append('Proxy-Authorization: Basic {}'.format(token))
    sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('utf-8'))
    response = b''
    while b'\r\n\r\n' not in response:
        chunk = sock.recv(4096)
        if not chunk:
            raise ProxyError('HTTP proxy closed the connection')
        response += chunk
        if len(response) > 65536:
            raise ProxyError('HTTP proxy sent an oversized response')
    status = response.split(b'\r\n', 1)[0].decode('latin-1')
    parts = status.split(' ', 2)
    if len(parts) < 2 or parts[1] != '200':
        raise ProxyError('HTTP proxy refused CONNECT to {}: {}'.format(target, status))


def open_via_proxy(proxy, host, port, timeout):
    """A connected socket to ``host:port`` through ``proxy``."""
    try:
        sock = socket.create_connection((proxy.host, proxy.port), timeout=timeout)
    except (OSError, socket.error) as exc:
        raise ProxyError('Cannot reach proxy {}: {}'.format(proxy.describe(), exc))
    try:
        if proxy.scheme in ('socks5', 'socks5h'):
            _socks5(sock, proxy, host, int(port))
        elif proxy.scheme in ('socks4', 'socks4a'):
            _socks4(sock, proxy, host, int(port))
        else:
            _http_connect(sock, proxy, host, int(port))
    except ProxyError:
        sock.close()
        raise
    except (OSError, socket.error) as exc:
        sock.close()
        raise ProxyError('Proxy {} failed: {}'.format(proxy.describe(), exc))
    return sock
