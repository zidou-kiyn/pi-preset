# -*- coding: utf-8 -*-
"""pi-preset local changes: redaction, pinned host keys, JSON login, snippets."""
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import paramiko

from termius.core.models.terminal import Host, Identity, Snippet, SshConfig, SshKey
from termius.core.ssh_exec import TrustOnFirstUsePolicy, known_hosts_path
from termius.json_login import handle, main as login_json_main
from termius.mcp.tools import call_tool
from termius.redact import REDACTED, redact_payload, redact_text
from termius.runtime import Runtime

PEM = (
    '-----BEGIN OPENSSH PRIVATE KEY-----\n'
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n'
    '-----END OPENSSH PRIVATE KEY-----'
)


class RedactTest(unittest.TestCase):
    def test_secrets_and_key_blocks_are_replaced(self):
        text = 'pw=Sup3rSecret!\n{}\nok'.format(PEM)
        out = redact_text(text, ['Sup3rSecret!'])
        self.assertNotIn('Sup3rSecret!', out)
        self.assertNotIn('BEGIN OPENSSH', out)
        self.assertEqual(out.count(REDACTED), 2)

    def test_payload_is_walked_recursively(self):
        data = {'stdout': 'x hunter22 y', 'nested': [{'v': 'hunter22'}], 'n': 3}
        self.assertEqual(
            redact_payload(data, ['hunter22']),
            {'stdout': 'x [redacted] y', 'nested': [{'v': '[redacted]'}], 'n': 3},
        )


class ToolHardeningTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.runtime = Runtime(directory_path=self.tmpdir.name)
        self.runtime.config.set('User', 'username', 'you@example.com')
        self.runtime.config.set('User', 'apikey', 'token')
        self.runtime.config.set('User', 'salt', 'c2FsdA==')
        self.runtime.config.set('User', 'hmac_salt', 'aG1hYw==')
        self.runtime.config.write()
        with self.runtime.storage:
            key = self.runtime.storage.save(
                SshKey(label='deploy', private_key=PEM, passphrase='keypass99')
            )
            identity = self.runtime.storage.save(Identity(
                label='web', username='root', password='Sup3rSecret!',
                ssh_key=key.id, is_visible=True,
            ))
            config = self.runtime.storage.save(SshConfig(port=22, identity=identity.id))
            self.host = self.runtime.storage.save(
                Host(label='web', address='10.0.0.1', ssh_config=config.id)
            )
            self.runtime.storage.save(Snippet(label='deploy', script='TOKEN=abc123456 ./deploy'))

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_exec_output_is_redacted(self):
        fake = {
            'host': 'web', 'address': '10.0.0.1', 'username': 'root',
            'command': 'cat secrets', 'exit_code': 0, 'truncated': False,
            'stdout': 'password=Sup3rSecret! pass=keypass99\n' + PEM,
            'stderr': '',
        }
        with patch('termius.mcp.tools.ensure_fresh', return_value={}), \
                patch('termius.mcp.tools.run_host_command', return_value=dict(fake)):
            data, _ = call_tool(self.runtime, 'exec', {'name': 'web', 'command': 'cat secrets'})
        self.assertNotIn('Sup3rSecret!', json.dumps(data))
        self.assertNotIn('keypass99', data['stdout'])
        self.assertNotIn('PRIVATE KEY', data['stdout'])

    def test_snippets_list_labels_only(self):
        with patch('termius.mcp.tools.ensure_fresh', return_value={}):
            data, _ = call_tool(self.runtime, 'inventory', {'kind': 'snippets'})
        self.assertEqual(list(data['items'][0].keys()), ['id', 'label'])

    def test_sync_takes_no_password(self):
        from termius.mcp.tools import TOOLS
        sync = [tool for tool in TOOLS if tool['name'] == 'sync'][0]
        self.assertEqual(sync['inputSchema']['properties'], {})
        for tool in TOOLS:
            self.assertNotIn('password', tool['inputSchema']['properties'], tool['name'])


class HostKeyPinningTest(unittest.TestCase):
    def test_first_key_is_pinned_and_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'sub', 'known_hosts')
            client = paramiko.SSHClient()
            key = paramiko.RSAKey.generate(1024)
            TrustOnFirstUsePolicy(path).missing_host_key(client, '[10.0.0.1]:2222', key)
            pinned = paramiko.HostKeys(path)
            self.assertEqual(pinned.lookup('[10.0.0.1]:2222')['ssh-rsa'], key)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_path_can_be_overridden(self):
        with patch.dict(os.environ, {'TERMIUS_KNOWN_HOSTS': '/x/kh'}):
            self.assertEqual(known_hosts_path(), '/x/kh')

    def test_connect_never_auto_adds(self):
        from termius.core import ssh_exec
        with open(ssh_exec.__file__) as source:
            self.assertNotIn('AutoAddPolicy()', source.read())


class JsonLoginTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.factory = lambda: Runtime(directory_path=self.tmpdir.name)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_otp_required_is_reported_without_echoing_secrets(self):
        error = ValueError('This account requires otp. Call login again with otp. pw=hunter22')
        with patch('termius.session.login_email', side_effect=error):
            response = handle(
                {'action': 'email', 'username': 'a@b.c', 'password': 'hunter22'},
                self.factory,
            )
        self.assertEqual(response['code'], 'otp_required')
        self.assertNotIn('hunter22', response['error'])

    def test_approval_is_reported(self):
        from termius.core.exceptions import ApiError
        with patch('termius.session.login_email', side_effect=ApiError('This login needs approval in the Termius app.')):
            response = handle({'action': 'email', 'username': 'a', 'password': 'p'}, self.factory)
        self.assertEqual(response['code'], 'approve_required')

    def test_success_pulls_the_inventory_and_status(self):
        with patch('termius.session.login_email', return_value={'username': 'a@b.c', 'vault_remembered': True}), \
                patch('termius.sync.pull', return_value={'ok': True, 'hosts': 7, 'last_synced': '2026-10-10T00:00:00Z'}) as pull:
            response = handle({'action': 'email', 'username': 'a@b.c', 'password': 'p'}, self.factory)
        self.assertEqual(pull.call_args[0][1], 'p')
        self.assertEqual(response, {
            'ok': True, 'username': 'a@b.c', 'vault_remembered': True,
            'synced': True, 'hosts': 7, 'last_synced': '2026-10-10T00:00:00Z',
        })
        status = handle({'action': 'status'}, self.factory)
        self.assertTrue(status['ok'])
        self.assertIn('logged_in', status)

    def test_a_failed_first_pull_does_not_fail_the_sign_in(self):
        with patch('termius.session.login_email', return_value={'username': 'a', 'vault_remembered': True}), \
                patch('termius.sync.pull', side_effect=RuntimeError('network down for p4ss')):
            response = handle({'action': 'email', 'username': 'a', 'password': 'p4ss'}, self.factory)
        self.assertTrue(response['ok'])
        self.assertFalse(response['synced'])
        self.assertIn('network down', response['sync_error'])
        self.assertNotIn('p4ss', response['sync_error'])

    def test_sync_action(self):
        self.assertEqual(handle({'action': 'sync'}, self.factory)['code'], 'not_signed_in')
        runtime = self.factory()
        runtime.config.set('User', 'username', 'a@b.c')
        runtime.config.set('User', 'apikey', 'token')
        runtime.config.write()
        with patch('termius.vault.resolve', return_value=None):
            self.assertEqual(handle({'action': 'sync'}, self.factory)['code'], 'vault_password_required')
        with patch('termius.vault.resolve', return_value='vault'), \
                patch('termius.sync.pull', return_value={'hosts': 3, 'last_synced': 'x'}) as pull:
            response = handle({'action': 'sync'}, self.factory)
        self.assertEqual(response, {'ok': True, 'synced': True, 'hosts': 3, 'last_synced': 'x'})
        self.assertEqual(pull.call_args[0][1], 'vault')
        with patch('termius.vault.resolve', return_value='vault'), \
                patch('termius.sync.pull', side_effect=RuntimeError('boom')):
            self.assertEqual(handle({'action': 'sync'}, self.factory)['code'], 'sync_failed')

    def test_main_reads_stdin_and_writes_one_line(self):
        out = io.StringIO()
        code = login_json_main(io.StringIO('not json'), out, self.factory)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())['code'], 'invalid_request')
        self.assertEqual(out.getvalue().count('\n'), 1)


if __name__ == '__main__':
    unittest.main()
