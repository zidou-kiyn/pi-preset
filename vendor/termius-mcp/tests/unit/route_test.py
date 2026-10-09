# -*- coding: utf-8 -*-
"""pi-preset: jump host chains and proxies."""
import socket
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch

from termius.cloud.client.transformers.many import BulkTransformer
from termius.core import ssh_exec
from termius.core.models.base import RemoteInstance
from termius.core.models.terminal import Group, Host, Identity, SshConfig
from termius.core.proxy import (
    DEFAULT_BYPASS, Proxy, ProxyError, matches_bypass, open_via_proxy, proxy_for, proxy_from_env,
)
from termius.core.ssh_merge import HostLookupError, get_jump_route
from termius.mcp.tools import call_tool
from termius.runtime import Runtime


# ── proxy selection ──────────────────────────────────────────────────────────

class ProxySelectionTest(unittest.TestCase):
    def test_local_setting_wins_and_bypasses_private_addresses_by_default(self):
        env = {'TERMIUS_MCP_PROXY': 'socks5://u:p%40ss@127.0.0.1:7890', 'ALL_PROXY': 'http://other:1'}
        proxy = proxy_from_env(env)
        self.assertEqual((proxy.scheme, proxy.host, proxy.port), ('socks5', '127.0.0.1', 7890))
        self.assertEqual((proxy.username, proxy.password), ('u', 'p@ss'))
        self.assertEqual(proxy.describe(), 'socks5://127.0.0.1:7890 (/termius proxy)')
        self.assertNotIn('p@ss', proxy.describe())
        self.assertIsNone(proxy_for('192.168.1.5', env))
        self.assertIsNone(proxy_for('db.local', env))
        self.assertIsNotNone(proxy_for('203.0.113.7', env))
        self.assertIsNotNone(proxy_for('example.com', env))

    def test_local_off_disables_even_with_system_variables(self):
        self.assertIsNone(proxy_from_env({'TERMIUS_MCP_PROXY': 'off', 'ALL_PROXY': 'socks5://x:1'}))

    def test_explicit_bypass_list_replaces_the_default(self):
        env = {'TERMIUS_MCP_PROXY': 'http://p:3128', 'TERMIUS_MCP_NO_PROXY': '.corp.example'}
        self.assertIsNotNone(proxy_for('10.0.0.1', env))
        self.assertIsNone(proxy_for('git.corp.example', env))

    def test_system_variables_and_no_proxy(self):
        env = {'https_proxy': 'http://127.0.0.1:7890', 'NO_PROXY': 'internal.example,10.0.0.0/8'}
        self.assertEqual(proxy_from_env(env).source, 'https_proxy')
        self.assertIsNone(proxy_for('a.internal.example', env))
        self.assertIsNone(proxy_for('10.1.2.3', env))
        self.assertIsNone(proxy_for('localhost', env))
        self.assertIsNotNone(proxy_for('192.168.1.1', env))
        self.assertIsNone(proxy_from_env({}))

    def test_bad_urls(self):
        with self.assertRaises(ProxyError):
            proxy_from_env({'TERMIUS_MCP_PROXY': 'ftp://x:1'})
        with self.assertRaises(ProxyError):
            proxy_from_env({'TERMIUS_MCP_PROXY': 'socks5://x:notaport'})

    def test_bypass_patterns(self):
        self.assertTrue(matches_bypass('anything', ['*']))
        self.assertTrue(matches_bypass('fd00::1', DEFAULT_BYPASS))
        self.assertTrue(matches_bypass('[::1]', DEFAULT_BYPASS))
        self.assertFalse(matches_bypass('example.com', ['ample.com']))
        self.assertTrue(matches_bypass('a.example.com', ['example.com']))


# ── proxy handshakes against local fake proxies ─────────────────────────────

def _serve_once(handler):
    server = socket.socket()
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    seen = {}

    def run():
        conn, _ = server.accept()
        try:
            handler(conn, seen)
        finally:
            conn.close()
            server.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return server.getsockname()[1], seen, thread


def _recv(conn, size):
    data = b''
    while len(data) < size:
        data += conn.recv(size - len(data))
    return data


class ProxyHandshakeTest(unittest.TestCase):
    def test_socks5_with_password_and_host_name(self):
        def handler(conn, seen):
            head = _recv(conn, 2)
            seen['methods'] = _recv(conn, head[1])
            conn.sendall(b'\x05\x02')
            _recv(conn, 1)
            user = _recv(conn, _recv(conn, 1)[0])
            password = _recv(conn, _recv(conn, 1)[0])
            seen['auth'] = (user, password)
            conn.sendall(b'\x01\x00')
            request = _recv(conn, 4)
            name = _recv(conn, _recv(conn, 1)[0])
            port = struct.unpack('>H', _recv(conn, 2))[0]
            seen['target'] = (request[3], name, port)
            conn.sendall(b'\x05\x00\x00\x01' + b'\x00' * 6)
            seen['payload'] = conn.recv(5)

        port, seen, thread = _serve_once(handler)
        proxy = Proxy('socks5://me:secret@127.0.0.1:{}'.format(port), 'test', [])
        sock = open_via_proxy(proxy, 'bastion.example.com', 2222, 5)
        sock.sendall(b'hello')
        thread.join(5)
        sock.close()
        self.assertEqual(seen['methods'], b'\x00\x02')
        self.assertEqual(seen['auth'], (b'me', b'secret'))
        self.assertEqual(seen['target'], (3, b'bastion.example.com', 2222))
        self.assertEqual(seen['payload'], b'hello')

    def test_socks5_refusal_is_reported(self):
        def handler(conn, seen):
            _recv(conn, 3)
            conn.sendall(b'\x05\x00')
            _recv(conn, 10)
            conn.sendall(b'\x05\x05\x00\x01' + b'\x00' * 6)

        port, _, thread = _serve_once(handler)
        with self.assertRaises(ProxyError) as caught:
            open_via_proxy(Proxy('socks5://127.0.0.1:{}'.format(port), 't', []), '203.0.113.1', 22, 5)
        thread.join(5)
        self.assertIn('could not connect', str(caught.exception))

    def test_http_connect_with_basic_auth(self):
        def handler(conn, seen):
            data = b''
            while b'\r\n\r\n' not in data:
                data += conn.recv(1024)
            seen['request'] = data.decode()
            conn.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')

        port, seen, thread = _serve_once(handler)
        sock = open_via_proxy(Proxy('http://a:b@127.0.0.1:{}'.format(port), 't', []), 'h.example', 22, 5)
        thread.join(5)
        sock.close()
        self.assertTrue(seen['request'].startswith('CONNECT h.example:22 HTTP/1.1\r\n'))
        self.assertIn('Proxy-Authorization: Basic YTpi', seen['request'])

    def test_http_refusal(self):
        def handler(conn, seen):
            conn.recv(1024)
            conn.sendall(b'HTTP/1.1 403 Forbidden\r\n\r\n')

        port, _, thread = _serve_once(handler)
        with self.assertRaises(ProxyError):
            open_via_proxy(Proxy('http://127.0.0.1:{}'.format(port), 't', []), 'h', 22, 5)
        thread.join(5)


# ── host chains ─────────────────────────────────────────────────────────────

class _Crypto(object):
    def decrypt_payload(self, payload, crypto_fields=None):
        return payload


class HostChainTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.runtime = Runtime(directory_path=self.tmpdir.name)
        self.storage = self.runtime.storage

    def tearDown(self):
        self.tmpdir.cleanup()

    def _config(self, remote_id, port=None, username='root'):
        identity = self.storage.save(Identity(label=username, username=username, is_visible=True))
        return self.storage.save(SshConfig(port=port, identity=identity.id, remote_instance=RemoteInstance(id=remote_id)))

    def _host(self, label, remote_id, config, group=None):
        return self.storage.save(Host(
            label=label, address='{}.example'.format(label), ssh_config=config.id,
            group=group.id if group else None, remote_instance=RemoteInstance(id=remote_id),
        ))

    def _apply(self, rows):
        transformer = BulkTransformer.__new__(BulkTransformer)
        transformer.storage = self.storage
        transformer.crypto_controller = _Crypto()
        with self.storage:
            transformer.apply_host_chains({'hostchain_set': rows})

    def test_chains_are_stored_inherited_from_groups_and_cleared(self):
        with self.storage:
            group_config = self._config(500)
            group = self.storage.save(Group(label='prod', ssh_config=group_config.id))
            bastion = self._host('bastion', 1, self._config(101, port=2222, username='jump'))
            inner = self._host('inner', 2, self._config(102))
            app = self._host('app', 3, self._config(103), group=group)
            gateway = self._host('gateway', 4, self._config(104), group=group)
        self._apply([
            {'id': 9, 'ssh_config': 102, 'hosts_chain': [1]},
            {'id': 10, 'ssh_config': {'id': 500}, 'hosts_chain': [4, 1]},
        ])
        inner = self.storage.get(Host, id=inner.id)
        self.assertEqual([hop.label for hop, _ in get_jump_route(self.storage, inner)], ['bastion'])
        # Group chain: app inherits it; gateway is in its own group's chain, so its route ends before itself.
        app = self.storage.get(Host, id=app.id)
        route = get_jump_route(self.storage, app)
        self.assertEqual([hop.label for hop, _ in route], ['gateway', 'bastion'])
        self.assertEqual(route[1][1].port, 2222)
        self.assertEqual(get_jump_route(self.storage, self.storage.get(Host, id=gateway.id)), [])
        self.assertEqual(get_jump_route(self.storage, self.storage.get(Host, id=bastion.id)), [])

        # The pull is a full snapshot: chains not in it are cleared.
        self._apply([{'id': 9, 'ssh_config': 102, 'hosts_chain': [1]}])
        self.assertEqual(get_jump_route(self.storage, self.storage.get(Host, id=app.id)), [])

    def test_a_jump_host_with_its_own_chain_is_reached_through_it(self):
        with self.storage:
            edge = self._host('edge', 1, self._config(101))
            mid = self._host('mid', 2, self._config(102))
            target = self._host('target', 3, self._config(103))
        self._apply([
            {'id': 8, 'ssh_config': 103, 'hosts_chain': [2]},
            {'id': 9, 'ssh_config': 102, 'hosts_chain': [1]},
        ])
        route = get_jump_route(self.storage, self.storage.get(Host, id=target.id))
        self.assertEqual([hop.label for hop, _ in route], ['edge', 'mid'])
        # A loop is refused instead of recursing forever.
        self._apply([
            {'id': 8, 'ssh_config': 103, 'hosts_chain': [2]},
            {'id': 9, 'ssh_config': 102, 'hosts_chain': [1]},
            {'id': 10, 'ssh_config': 101, 'hosts_chain': [3]},
        ])
        with self.assertRaises(HostLookupError):
            get_jump_route(self.storage, self.storage.get(Host, id=target.id))
        del edge, mid

    def test_missing_jump_host(self):
        with self.storage:
            inner = self._host('inner', 2, self._config(102))
        self._apply([{'id': 9, 'ssh_config': 102, 'hosts_chain': [77]}])
        with self.assertRaises(HostLookupError):
            get_jump_route(self.storage, self.storage.get(Host, id=inner.id))

    def test_host_chain_is_never_pushed(self):
        from termius.cloud.client.transformers.single import BulkEntryTransformer
        config = SshConfig(port=22, host_chain='1,2')
        transformer = BulkEntryTransformer.__new__(BulkEntryTransformer)
        transformer.model_class = SshConfig
        from operator import attrgetter
        transformer.attrgetter = attrgetter(*SshConfig.fields)
        transformer.skip = False
        with patch.object(BulkEntryTransformer, 'serialize_field'):
            payload = transformer.to_payload(config)
        self.assertNotIn('host_chain', payload)

    def test_host_tool_reports_jump_hosts_and_ssh_command(self):
        with self.storage:
            self._host('bastion', 1, self._config(101, port=2222, username='jump'))
            self._host('inner', 2, self._config(102))
        self._apply([{'id': 9, 'ssh_config': 102, 'hosts_chain': [1]}])
        with patch('termius.mcp.tools._auto_sync', return_value={}):
            data, _ = call_tool(self.runtime, 'host', {'name': 'inner'})
        self.assertEqual(data['jump_hosts'], ['bastion'])
        self.assertIsNone(data['proxy'])
        self.assertTrue(data['ssh_command'].startswith('ssh -J jump@bastion.example:2222 '), data['ssh_command'])


# ── connection routing ──────────────────────────────────────────────────────

class _FakeTransport(object):
    def __init__(self, log, name):
        self.log = log
        self.name = name

    def open_channel(self, kind, dest, src, timeout=None):
        self.log.append(('channel', self.name, kind, dest))
        return 'channel-to-{}'.format(dest[0])


class _FakeClient(object):
    def __init__(self, log, name):
        self.log = log
        self.name = name
        self.via = []
        self.route = []

    def get_transport(self):
        return _FakeTransport(self.log, self.name)

    def close(self):
        self.log.append(('close', self.name))


class RoutingTest(unittest.TestCase):
    def _host(self, label, port=None):
        host = Host(label=label, address='{}.example'.format(label))
        return host, SshConfig(port=port, identity=Identity(username='u'))

    def test_jumps_chain_channels_and_skip_the_proxy(self):
        log = []

        def fake_connect(host, config, timeout, sock, role):
            log.append(('connect', host.label, sock, role))
            return _FakeClient(log, host.label), 'u'

        a, a_cfg = self._host('a')
        b, b_cfg = self._host('b', port=2200)
        target, target_cfg = self._host('target', port=22)
        with patch.object(ssh_exec, '_connect_single', side_effect=fake_connect), \
                patch.object(ssh_exec, 'open_via_proxy') as proxy_open, \
                patch.dict('os.environ', {'TERMIUS_MCP_PROXY': 'socks5://127.0.0.1:1'}):
            client, _ = ssh_exec.connect_host(target, target_cfg, timeout=5, route=[(a, a_cfg), (b, b_cfg)])
        proxy_open.assert_not_called()
        self.assertEqual(log, [
            ('connect', 'a', None, 'jump host '),
            ('channel', 'a', 'direct-tcpip', ('b.example', 2200)),
            ('connect', 'b', 'channel-to-b.example', 'jump host '),
            ('channel', 'b', 'direct-tcpip', ('target.example', 22)),
            ('connect', 'target', 'channel-to-target.example', ''),
        ])
        self.assertEqual(client.route, ['jump host a (a.example)', 'jump host b (b.example)'])
        self.assertEqual([jump.name for jump in client.via], ['a', 'b'])

    def test_a_failing_hop_closes_the_earlier_ones(self):
        log = []

        def fake_connect(host, config, timeout, sock, role):
            if host.label == 'target':
                raise ssh_exec.SshExecError('nope')
            return _FakeClient(log, host.label), 'u'

        a, a_cfg = self._host('a')
        target, target_cfg = self._host('target')
        with patch.object(ssh_exec, '_connect_single', side_effect=fake_connect):
            with self.assertRaises(ssh_exec.SshExecError):
                ssh_exec.connect_host(target, target_cfg, timeout=5, route=[(a, a_cfg)])
        self.assertIn(('close', 'a'), log)

    def test_direct_hosts_use_the_proxy_unless_bypassed(self):
        target, cfg = self._host('target', port=2022)
        with patch.object(ssh_exec, '_connect_single', return_value=(_FakeClient([], 't'), 'u')) as connect, \
                patch.object(ssh_exec, 'open_via_proxy', return_value='proxied-sock') as proxy_open, \
                patch.dict('os.environ', {'TERMIUS_MCP_PROXY': 'socks5://127.0.0.1:1'}):
            client, _ = ssh_exec.connect_host(target, cfg, timeout=5)
            proxy_open.assert_called_once()
            self.assertEqual(proxy_open.call_args[0][1:3], ('target.example', 2022))
            self.assertEqual(connect.call_args[0][3], 'proxied-sock')
            self.assertEqual(client.route, ['proxy socks5://127.0.0.1:1 (/termius proxy)'])

            private, private_cfg = Host(label='lan', address='192.168.1.9'), cfg
            proxy_open.reset_mock()
            ssh_exec.connect_host(private, private_cfg, timeout=5)
            proxy_open.assert_not_called()

    def test_a_broken_proxy_setting_is_an_ssh_error(self):
        target, cfg = self._host('target')
        with patch.dict('os.environ', {'TERMIUS_MCP_PROXY': 'gopher://x:1'}):
            with self.assertRaises(ssh_exec.SshExecError):
                ssh_exec.connect_host(target, cfg, timeout=5)


if __name__ == '__main__':
    unittest.main()
