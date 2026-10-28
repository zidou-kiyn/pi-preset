# -*- coding: utf-8 -*-
"""pi-preset: /termius per-host settings (disabled hosts, route modes)."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from termius import policy as policy_module
from termius.cloud.client.transformers.many import BulkTransformer
from termius.core import ssh_exec
from termius.core.models.base import RemoteInstance
from termius.core.models.terminal import Host, Identity, SshConfig, Tag, TagHost
from termius.core.proxy import ProxyError
from termius.json_login import handle
from termius.mcp.tools import ToolError, call_tool
from termius.policy import Policy, PolicyError, load_policy, plan_route, policy_key
from termius.runtime import Runtime

PROXY_ENV = {'TERMIUS_MCP_PROXY': 'socks5://127.0.0.1:7890'}


class PolicyFileTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmpdir.name, 'config.json')
        self.env = {'TERMIUS_MCP_POLICY': self.path}

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write(self, data):
        # The way pi writes it: a new file renamed over the old one.
        temp = self.path + '.tmp'
        with open(temp, 'w') as handle:
            handle.write(data if isinstance(data, str) else json.dumps(data))
        os.replace(temp, self.path)

    def test_nothing_configured(self):
        self.assertEqual(load_policy({}).route, 'termius')
        self.assertEqual(load_policy(self.env).hosts, {})

    def test_levels_routes_and_proxies(self):
        self._write({
            'mode': 'auto', 'route': 'direct',
            'hosts': {
                '11': {'level': 'off'},
                '12': {'level': 'trusted', 'route': 'proxy', 'proxy': ' socks5://h:1 '},
                '13': {'route': 'nonsense'},
                '14': 'not an object',
            },
        })
        policy = load_policy(self.env)
        self.assertTrue(policy.is_disabled('11'))
        self.assertFalse(policy.is_disabled('12'))
        self.assertFalse(policy.is_disabled(None))
        self.assertEqual(policy.route_for('12'), ('proxy', 'host'))
        self.assertEqual(policy.route_for('13'), ('direct', 'global'))
        self.assertEqual(policy.route_for('99'), ('direct', 'global'))
        self.assertEqual(policy.proxy_url_for('12'), 'socks5://h:1')
        self.assertIsNone(policy.proxy_url_for('11'))
        self.assertNotIn('14', policy.hosts)
        self.assertEqual(Policy({'route': 'bogus'}).route, 'termius')

    def test_changes_are_picked_up(self):
        self._write({'hosts': {'1': {'level': 'off'}}})
        self.assertTrue(load_policy(self.env).is_disabled('1'))
        self._write({'hosts': {'1': {'level': 'auto'}}})
        self.assertFalse(load_policy(self.env).is_disabled('1'))

    def test_an_unreadable_file_fails_closed(self):
        self._write('{"hosts": {"1": {"level": "off"')
        with patch('termius.policy.time.sleep'):
            with self.assertRaises(PolicyError):
                load_policy(self.env)

    def test_policy_key_is_the_cloud_id(self):
        self.assertEqual(policy_key(Host(label='a', remote_instance=RemoteInstance(id=42))), '42')
        host = Host(label='a')
        host.id = 7
        self.assertEqual(policy_key(host), 'local:7')


class PlanRouteTest(unittest.TestCase):
    chain = ['bastion']

    def test_direct_ignores_chain_and_proxy(self):
        self.assertEqual(plan_route('direct', self.chain, 'example.com', 'socks5://h:1', PROXY_ENV), ([], None))

    def test_proxy_skips_the_chain_and_the_bypass_list(self):
        hops, proxy = plan_route('proxy', self.chain, '192.168.1.5', None, PROXY_ENV)
        self.assertEqual(hops, [])
        self.assertEqual((proxy.host, proxy.port), ('127.0.0.1', 7890))

    def test_a_host_proxy_url_wins(self):
        hops, proxy = plan_route('proxy', [], 'example.com', 'http://u:p@10.0.0.2:3128', PROXY_ENV)
        self.assertEqual((proxy.scheme, proxy.host, proxy.source), ('http', '10.0.0.2', 'host setting'))
        self.assertNotIn('u:p', proxy.describe())
        _, proxy = plan_route('termius', [], 'example.com', 'socks5://h:9', {})
        self.assertEqual(proxy.host, 'h')

    def test_a_missing_proxy_is_an_error_not_a_direct_connection(self):
        for mode in ('proxy', 'termius-proxy'):
            with self.assertRaises(ProxyError):
                plan_route(mode, self.chain, 'example.com', None, {'TERMIUS_MCP_PROXY': 'off'})

    def test_termius_uses_the_chain_with_a_direct_first_hop(self):
        self.assertEqual(plan_route('termius', self.chain, 'example.com', None, PROXY_ENV), (['bastion'], None))

    def test_termius_proxy_sends_the_first_hop_through_the_proxy(self):
        hops, proxy = plan_route('termius-proxy', self.chain, '10.0.0.9', None, PROXY_ENV)
        self.assertEqual(hops, ['bastion'])
        self.assertEqual(proxy.port, 7890)

    def test_without_a_chain_both_termius_modes_follow_the_proxy_setting(self):
        for mode in ('termius', 'termius-proxy'):
            self.assertIsNotNone(plan_route(mode, [], 'example.com', None, PROXY_ENV)[1])
            self.assertIsNone(plan_route(mode, [], '192.168.1.5', None, PROXY_ENV)[1], 'bypassed')
            self.assertIsNone(plan_route(mode, [], 'example.com', None, {})[1], 'nothing configured')


class FirstHopProxyTest(unittest.TestCase):
    def _target(self, label, port=22):
        host = Host(label=label, address='{}.example'.format(label))
        return ssh_exec.ssh_target(host, SshConfig(port=port, identity=Identity(username='u')))

    def test_the_first_hop_goes_through_the_proxy_and_stages_are_reported(self):
        from termius.core.proxy import Proxy
        connects = []

        class Client(object):
            via, route = [], []

            def get_transport(self):
                return self

            def open_channel(self, kind, dest, src, timeout=None):
                return 'channel-to-{}'.format(dest[0])

            def close(self):
                pass

        def fake_connect(target, timeout, sock, role, cancel, deadline):
            connects.append((target.label, sock))
            return Client()

        stages = []
        proxy = Proxy('socks5://127.0.0.1:1', 'test', [])
        with patch.object(ssh_exec, '_connect_single', side_effect=fake_connect), \
                patch.object(ssh_exec, 'open_via_proxy', return_value='proxied') as proxy_open:
            client, _ = ssh_exec.connect_host(
                self._target('target'), timeout=5, route=[self._target('jump', 2222)],
                proxy=proxy, on_stage=stages.append,
            )
        self.assertEqual(proxy_open.call_args[0][1:3], ('jump.example', 2222))
        self.assertEqual(connects, [('jump', 'proxied'), ('target', 'channel-to-target.example')])
        self.assertEqual(client.route, ['proxy socks5://127.0.0.1:1 (test)', 'jump host jump (jump.example)'])
        self.assertEqual([(s['label'], s['via']) for s in stages], [
            ('jump', 'proxy socks5://127.0.0.1:1 (test)'), ('target', 'jump host jump'),
        ])

    def test_proxy_none_dials_directly_even_with_a_proxy_set(self):
        with patch.object(ssh_exec, '_connect_single', return_value=type('C', (), {'via': [], 'route': []})()), \
                patch.object(ssh_exec, 'open_via_proxy') as proxy_open, \
                patch.dict('os.environ', PROXY_ENV):
            ssh_exec.connect_host(self._target('target'), timeout=5, proxy=None)
        proxy_open.assert_not_called()


class _Crypto(object):
    def decrypt_payload(self, payload, crypto_fields=None):
        return payload


class PolicyToolsTest(unittest.TestCase):
    """Two hosts behind a bastion: inner (cloud 2) and other (cloud 3)."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.runtime = Runtime(directory_path=self.tmpdir.name)
        self.storage = self.runtime.storage
        self.policy_path = os.path.join(self.tmpdir.name, 'config.json')
        self.env = patch.dict('os.environ', {'TERMIUS_MCP_POLICY': self.policy_path, 'TERMIUS_MCP_PROXY': 'off'})
        self.env.start()
        with self.storage:
            self.bastion = self._host('bastion', 1, self._config(101, port=2222, username='jump'))
            self.inner = self._host('inner', 2, self._config(102))
            self.other = self._host('other', 3, self._config(103))
            tag = self.storage.save(Tag(label='prod'))
            self.storage.save(TagHost(host=self.inner.id, tag=tag.id))
        transformer = BulkTransformer.__new__(BulkTransformer)
        transformer.storage = self.storage
        transformer.crypto_controller = _Crypto()
        with self.storage:
            transformer.apply_host_chains({'hostchain_set': [
                {'id': 9, 'ssh_config': 102, 'hosts_chain': [1]},
                {'id': 10, 'ssh_config': 103, 'hosts_chain': [1]},
            ]})
        self.sync = patch('termius.mcp.tools._auto_sync', return_value={})
        self.sync.start()

    def tearDown(self):
        self.sync.stop()
        self.env.stop()
        self.tmpdir.cleanup()

    def _config(self, remote_id, port=None, username='root'):
        identity = self.storage.save(Identity(label=username, username=username, is_visible=True))
        return self.storage.save(SshConfig(port=port, identity=identity.id, remote_instance=RemoteInstance(id=remote_id)))

    def _host(self, label, remote_id, config):
        return self.storage.save(Host(
            label=label, address='{}.example'.format(label), ssh_config=config.id,
            remote_instance=RemoteInstance(id=remote_id),
        ))

    def _policy(self, data):
        temp = self.policy_path + '.tmp'
        with open(temp, 'w') as handle:
            json.dump(data, handle)
        os.replace(temp, self.policy_path)

    def _exec(self, name):
        seen = {}

        def fake_run(target, command, timeout=60, route=None, cancel=None, proxy=None):
            seen.update(target=target.label, hops=[hop.label for hop in route], proxy=proxy)
            return {'host': target.label, 'exit_code': 0, 'stdout': '', 'stderr': ''}

        with patch('termius.mcp.tools.run_host_command', fake_run):
            call_tool(self.runtime, 'exec', {'name': name, 'command': 'true'})
        return seen

    def test_hosts_leave_out_disabled_ones_and_report_tags_and_routes(self):
        self._policy({'hosts': {'3': {'level': 'off'}}})
        data, summary = call_tool(self.runtime, 'hosts', {})
        self.assertEqual(sorted(row['label'] for row in data['hosts']), ['bastion', 'inner'])
        self.assertEqual(data['hidden'], 1)
        self.assertIn('1 more disabled', summary)
        inner = next(row for row in data['hosts'] if row['label'] == 'inner')
        self.assertEqual(inner['cloud_id'], '2')
        self.assertEqual(inner['tags'], ['prod'])
        self.assertEqual(inner['route'], {'mode': 'termius', 'source': 'global', 'jump_hosts': ['bastion'], 'proxy': None})
        self.assertEqual(call_tool(self.runtime, 'hosts', {'query': 'prod'})[0]['count'], 1)

    def test_a_disabled_host_is_refused_by_name(self):
        self._policy({'hosts': {'3': {'level': 'off'}}})
        for tool, args in (('host', {}), ('exec', {'command': 'true'}), ('files', {'action': 'list'})):
            with self.assertRaises(ToolError) as caught:
                call_tool(self.runtime, tool, dict(args, name='other'))
            self.assertEqual(caught.exception.code, 'host_disabled')
            self.assertIn('/termius', str(caught.exception))

    def test_a_disabled_jump_host_still_carries_other_hosts(self):
        self._policy({'hosts': {'1': {'level': 'off'}}})
        self.assertEqual(self._exec('inner')['hops'], ['bastion'])

    def test_route_modes_reach_exec(self):
        self._policy({'route': 'direct'})
        self.assertEqual(self._exec('inner'), {'target': 'inner', 'hops': [], 'proxy': None})
        self._policy({'route': 'direct', 'hosts': {'2': {'route': 'termius'}}})
        self.assertEqual(self._exec('inner')['hops'], ['bastion'])
        self.assertEqual(self._exec('other')['hops'], [])
        self._policy({'hosts': {'2': {'route': 'termius-proxy', 'proxy': 'socks5://127.0.0.1:9'}}})
        seen = self._exec('inner')
        self.assertEqual((seen['hops'], seen['proxy'].port), (['bastion'], 9))

    def test_a_route_without_its_proxy_is_refused(self):
        self._policy({'route': 'proxy'})
        with self.assertRaises(ToolError) as caught:
            self._exec('inner')
        self.assertEqual(caught.exception.code, 'route_unavailable')
        data, _ = call_tool(self.runtime, 'host', {'name': 'inner'})
        self.assertIn('needs a proxy', data['route']['error'])

    def test_host_reports_the_effective_route(self):
        self._policy({'hosts': {'2': {'route': 'direct'}}})
        data, _ = call_tool(self.runtime, 'host', {'name': 'inner'})
        self.assertEqual(data['jump_hosts'], [])
        self.assertEqual(data['route']['source'], 'host')
        self.assertFalse(data['ssh_command'].startswith('ssh -J'), data['ssh_command'])

    def test_login_json_hosts_lists_every_host_with_its_hops(self):
        self._policy({'hosts': {'3': {'level': 'off'}}})
        response = handle({'action': 'hosts'}, lambda: self.runtime)
        self.assertTrue(response['ok'])
        rows = {row['label']: row for row in response['hosts']}
        self.assertEqual(sorted(rows), ['bastion', 'inner', 'other'])
        self.assertEqual(rows['other']['via'], ['1'])
        self.assertEqual(rows['bastion']['port'], 2222)
        self.assertNotIn('password', json.dumps(response).replace('has_password', ''))

    def test_login_json_test_reports_each_hop(self):
        def fake_connect(target, timeout=60, route=None, cancel=None, deadline=None, proxy=None, on_stage=None):
            for hop in list(route) + [target]:
                on_stage({'label': hop.label, 'address': hop.address, 'port': hop.port, 'via': 'direct', 'seconds': 0.1})
            return type('C', (), {'close': lambda self: None})(), target.username

        with patch('termius.core.ssh_exec.connect_host', fake_connect):
            response = handle({'action': 'test', 'host': '2'}, lambda: self.runtime)
        self.assertTrue(response['ok'], response)
        self.assertEqual([stage['label'] for stage in response['stages']], ['bastion', 'inner'])

        def failing_connect(target, timeout=60, route=None, cancel=None, deadline=None, proxy=None, on_stage=None):
            on_stage({'label': 'bastion', 'address': 'bastion.example', 'port': 2222, 'via': 'direct', 'seconds': 0.1})
            raise ssh_exec.SshExecError('SSH to inner.example failed: auth')

        with patch('termius.core.ssh_exec.connect_host', failing_connect):
            response = handle({'action': 'test', 'host': 'inner'}, lambda: self.runtime)
        self.assertEqual(response['code'], 'test_failed')
        self.assertEqual(response['failed']['label'], 'inner')
        self.assertEqual(handle({'action': 'test', 'host': 'nope'}, lambda: self.runtime)['code'], 'host_not_found')


if __name__ == '__main__':
    unittest.main()
