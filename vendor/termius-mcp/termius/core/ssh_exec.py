"""Run a command on a Termius host with paramiko."""
from __future__ import unicode_literals

from io import StringIO
import os

import paramiko

from .exceptions import TermiusException

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


def connect_host(host, ssh_config, timeout=60):
    """Open an SSH client. The caller must close it.

    Returns ``(client, username)``.
    """
    username, password, pkey, port = _auth_from_config(host, ssh_config)
    client = paramiko.SSHClient()
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
        )
    except paramiko.BadHostKeyException as exc:
        close_quiet(client)
        raise SshExecError(
            'Host key of {} changed since it was pinned ({} {}). Refusing to '
            'connect. If the change is expected, the user can remove that '
            'host from {}.'.format(
                host.address, exc.key.get_name(),
                exc.key.get_fingerprint().hex(), path,
            )
        )
    except Exception as exc:
        close_quiet(client)
        raise SshExecError('SSH to {} failed: {}'.format(
            host.address, exc,
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
        'exit_code': code,
        'stdout': out,
        'stderr': err,
        'truncated': truncated,
    }


def run_host_command(host, ssh_config, command, timeout=60):
    """Execute ``command`` on ``host`` using merged ssh_config credentials."""
    if not command or not str(command).strip():
        raise SshExecError('Command is empty')
    client, username = connect_host(host, ssh_config, timeout=timeout)
    try:
        return _exec_command(client, host, username, command, timeout)
    finally:
        close_quiet(client)
