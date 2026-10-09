"""Run a command on a Termius host with paramiko."""
from __future__ import unicode_literals

from io import StringIO
import os

import paramiko

from .exceptions import TermiusException
from .proxy import ProxyError, open_via_proxy, proxy_for

MAX_OUTPUT = 200000

# pi-preset: host keys are pinned on first use instead of auto-accepted on
# every connection (upstream used AutoAddPolicy, which accepts any key).
KNOWN_HOSTS_ENV = 'TERMIUS_KNOWN_HOSTS'


def known_hosts_path():
    """File that pins host keys: $TERMIUS_KNOWN_HOSTS or ~/.termius/known_hosts."""
    return os.environ.get(KNOWN_HOSTS_ENV) or os.path.expanduser(
        os.path.join('~', '.termius', 'known_hosts')
    )


class TrustOnFirstUsePolicy(paramiko.MissingHostKeyPolicy):
    """Accept and pin an unknown host key; a pinned key that changes is
    rejected by paramiko itself (BadHostKeyException)."""

    def __init__(self, path):
        self.path = path

    def missing_host_key(self, client, hostname, key):
        client.get_host_keys().add(hostname, key.get_name(), key)
        directory = os.path.dirname(self.path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory, mode=0o700)
        pinned = paramiko.HostKeys()
        if os.path.exists(self.path):
            pinned.load(self.path)
        pinned.add(hostname, key.get_name(), key)
        pinned.save(self.path)
        os.chmod(self.path, 0o600)


class SshExecError(TermiusException):
    """SSH execution failed before a command result existed."""


def _load_pkey(identity):
    ssh_key = identity.ssh_key if identity else None
    if not ssh_key or not ssh_key.private_key:
        return None
    data = ssh_key.private_key
    passphrase = ssh_key.passphrase or None
    if passphrase == '':
        passphrase = None
    errors = []
    key_classes = [paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey]
    dss = getattr(paramiko, 'DSSKey', None)
    if dss is not None:
        key_classes.append(dss)
    for cls in key_classes:
        try:
            return cls.from_private_key(StringIO(data), password=passphrase)
        except Exception as exc:
            errors.append('{}: {}'.format(cls.__name__, exc))
    raise SshExecError('Could not parse SSH private key ({})'.format(
        '; '.join(errors)
    ))


def close_quiet(resource):
    """Close an SSH or SFTP resource and ignore errors."""
    try:
        resource.close()
    except Exception:
        pass


def _auth_from_config(host, ssh_config):
    identity = ssh_config.identity if ssh_config else None
    username = identity.username if identity else None
    password = identity.password if identity else None
    if not username:
        raise SshExecError(
            'Host {} has no username. Team identities are linked on pull; '
            'call sync or wait for auto-sync.'.format(
                host.label or host.address
            )
        )
    pkey = _load_pkey(identity)
    port = int(ssh_config.port or 22)
    return username, password, pkey, port


class RoutedSSHClient(paramiko.SSHClient):
    """An SSH client that also closes the jump-host clients it rides on."""

    def __init__(self):
        super(RoutedSSHClient, self).__init__()
        self.via = []
        self.route = []

    def close(self):
        super(RoutedSSHClient, self).close()
        for jump in reversed(self.via):
            close_quiet(jump)
        self.via = []


def _label(host):
    return host.label or host.address


def connect_host(host, ssh_config, timeout=60, route=None):
    """Open an SSH client. The caller must close it.

    ``route`` is the Termius jump host chain from ``get_jump_route``: each
    hop is an SSH connection of its own (own credentials, own pinned host
    key), and the next hop runs through a direct-tcpip channel of the one
    before. A host without a chain may go through the configured proxy
    (``proxy.py``). Returns ``(client, username)``; ``client.route`` lists
    how it was reached.
    """
    route = list(route or [])
    jumps = []
    sock = None
    description = []
    try:
        if not route:
            port = int(ssh_config.port or 22) if ssh_config else 22
            try:
                proxy = proxy_for(host.address)
                if proxy is not None:
                    sock = open_via_proxy(proxy, host.address, port, timeout)
                    description.append('proxy {}'.format(proxy.describe()))
            except ProxyError as exc:
                raise SshExecError('SSH to {} failed: {}'.format(host.address, exc))
        targets = [hop for hop, _ in route[1:]] + [host]
        configs = [cfg for _, cfg in route[1:]] + [ssh_config]
        for (hop, hop_config), next_host, next_config in zip(route, targets, configs):
            jump, _ = _connect_single(hop, hop_config, timeout, sock, 'jump host ')
            jumps.append(jump)
            description.append('jump host {} ({})'.format(_label(hop), hop.address))
            next_port = int(next_config.port or 22) if next_config else 22
            try:
                sock = jump.get_transport().open_channel(
                    'direct-tcpip', (next_host.address, next_port), ('127.0.0.1', 0),
                    timeout=timeout,
                )
            except Exception as exc:
                raise SshExecError('Jump host {} could not reach {}:{}: {}'.format(
                    _label(hop), next_host.address, next_port, exc,
                ))
        client, username = _connect_single(host, ssh_config, timeout, sock, '')
    except Exception:
        for jump in reversed(jumps):
            close_quiet(jump)
        raise
    client.via = jumps
    client.route = description
    return client, username


def _connect_single(host, ssh_config, timeout, sock, role):
    """One SSH connection, over ``sock`` when given."""
    username, password, pkey, port = _auth_from_config(host, ssh_config)
    client = RoutedSSHClient()
    path = known_hosts_path()
    if os.path.exists(path):
        client.load_host_keys(path)
    client.set_missing_host_key_policy(TrustOnFirstUsePolicy(path))
    use_local_keys = not password and pkey is None
    try:
        client.connect(
            hostname=host.address,
            port=port,
            username=username,
            password=password or None,
            pkey=pkey,
            timeout=timeout,
            banner_timeout=timeout,
            auth_timeout=timeout,
            allow_agent=use_local_keys,
            look_for_keys=use_local_keys,
            sock=sock,
        )
    except paramiko.BadHostKeyException as exc:
        close_quiet(client)
        raise SshExecError(
            'Host key of {}{} changed since it was pinned ({} {}). Refusing to '
            'connect. If the change is expected, the user can remove that '
            'host from {}.'.format(
                role, host.address, exc.key.get_name(),
                exc.key.get_fingerprint().hex(), path,
            )
        )
    except Exception as exc:
        close_quiet(client)
        raise SshExecError('SSH to {}{} failed: {}'.format(
            role, host.address, exc,
        ))
    return client, username


def _trim_output(out, err):
    truncated = False
    if len(out) > MAX_OUTPUT:
        out = out[:MAX_OUTPUT] + '\n...[stdout truncated]...'
        truncated = True
    if len(err) > MAX_OUTPUT:
        err = err[:MAX_OUTPUT] + '\n...[stderr truncated]...'
        truncated = True
    return out, err, truncated


def _exec_command(client, host, username, command, timeout):
    try:
        unused_stdin, stdout, stderr = client.exec_command(
            command, timeout=timeout,
        )
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        code = stdout.channel.recv_exit_status()
    except Exception as exc:
        raise SshExecError('SSH to {} failed: {}'.format(
            host.address, exc,
        ))
    out, err, truncated = _trim_output(out, err)
    return {
        'host': host.label or host.address,
        'address': host.address,
        'username': username,
        'command': command,
        'route': list(getattr(client, 'route', []) or []) or ['direct'],
        'exit_code': code,
        'stdout': out,
        'stderr': err,
        'truncated': truncated,
    }


def run_host_command(host, ssh_config, command, timeout=60, route=None):
    """Execute ``command`` on ``host`` using merged ssh_config credentials."""
    if not command or not str(command).strip():
        raise SshExecError('Command is empty')
    client, username = connect_host(host, ssh_config, timeout=timeout, route=route)
    try:
        return _exec_command(client, host, username, command, timeout)
    finally:
        close_quiet(client)
