# -*- coding: utf-8 -*-
"""Scrub vault secrets from tool results before they reach the model.

pi-preset local change. exec and files return whatever the remote side
prints, and a remote file or command can echo a password or key that lives
in the vault (a reused password, an authorized key file, an env dump). Every
tool result passes through ``redact_payload`` before it is serialized:

* every secret string in the vault (identity passwords, SSH private keys and
  passphrases, the vault password itself) is replaced, and
* any PEM / OpenSSH private key block is replaced even when it is not in the
  vault.

Very short secrets (under MIN_SECRET_LENGTH characters) are skipped: they
would match ordinary output everywhere and protect nothing.
"""
from __future__ import unicode_literals

import re

REDACTED = '[redacted]'
MIN_SECRET_LENGTH = 4

PRIVATE_KEY_BLOCK = re.compile(
    r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----',
    re.DOTALL,
)


def vault_secrets(runtime):
    """Every secret string the vault holds, longest first."""
    from .core.models.terminal import Identity, SshKey
    from .vault import resolve

    found = set()

    def add(value):
        if isinstance(value, str) and len(value.strip()) >= MIN_SECRET_LENGTH:
            found.add(value)
            stripped = value.strip()
            if stripped != value and len(stripped) >= MIN_SECRET_LENGTH:
                found.add(stripped)

    try:
        for identity in runtime.storage.get_all(Identity):
            add(identity.password)
        for key in runtime.storage.get_all(SshKey):
            add(key.private_key)
            add(key.passphrase)
    except Exception:  # pylint: disable=broad-except
        pass
    try:
        add(resolve(runtime))
    except Exception:  # pylint: disable=broad-except
        pass
    return sorted(found, key=len, reverse=True)


def redact_text(text, secrets):
    """Replace secrets and private key blocks in one string."""
    if not isinstance(text, str) or not text:
        return text
    text = PRIVATE_KEY_BLOCK.sub(REDACTED, text)
    for secret in secrets:
        if secret in text:
            text = text.replace(secret, REDACTED)
    return text


def redact_payload(value, secrets):
    """Recursively redact every string in a JSON-like value."""
    if isinstance(value, str):
        return redact_text(value, secrets)
    if isinstance(value, dict):
        return {key: redact_payload(item, secrets) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_payload(item, secrets) for item in value]
    return value
