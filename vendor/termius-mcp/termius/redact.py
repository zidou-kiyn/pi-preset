# -*- coding: utf-8 -*-
"""Scrub vault secrets from tool results before they reach the model.

pi-preset local change. exec and files return whatever the remote side
prints, and a remote file or command can echo a password or key that lives
in the vault (a reused password, an authorized key file, an env dump). Every
tool result passes through ``redact_payload`` before it is serialized. Only
the result changes; remote files and commands are untouched.

* every secret string in the vault (identity passwords, SSH private keys and
  passphrases, the vault password itself) is replaced by a labelled marker
  such as ``[redacted:password of identity "web"]``: the label names the
  credential, never its value, so the agent can tell secrets apart;
* that also happens inside base64 file content (binary or non-UTF-8 files,
  in UTF-8, GBK, and UTF-16), and to a piece of a secret at the edge of a cut
  output or a partial file read;
* any PEM / OpenSSH private key block is replaced even when it is not in the
  vault.

The markers cannot be turned back into the secret: these are the
credentials of the user's servers, and a marker the server swapped back on
the remote side would let an injected command send them anywhere. Writing a
marker back would replace the real value with the marker text, so exec,
``files write``, and ``files put`` refuse content that holds one
(``contains_marker``).

Token shapes and named values (``API_TOKEN=...``) are left to pi-preset's
secret-redact extension, which sees every tool result, this one included.

Very short secrets (under MIN_SECRET_LENGTH characters) are skipped: they
would match ordinary output everywhere and protect nothing.
"""
from __future__ import unicode_literals

import base64
import binascii
import re

REDACTED = '[redacted]'
MIN_SECRET_LENGTH = 4
LABEL_LIMIT = 60

PRIVATE_KEY_BLOCK = re.compile(
    r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----',
    re.DOTALL,
)
PRIVATE_KEY_BLOCK_BYTES = re.compile(
    PRIVATE_KEY_BLOCK.pattern.encode('ascii'), re.DOTALL,
)
PRIVATE_KEY_MARKER = '[redacted:private key]'
# This server's markers and pi-preset's ([REDACTED:github-pat-1]).
MARKER = re.compile(r'\[redacted(?::[^\]\n]{0,200})?\]', re.IGNORECASE)
MARKER_BYTES = re.compile(MARKER.pattern.encode('ascii'), re.IGNORECASE)
# Markers ssh_exec puts where it cut the middle of an output stream.
CUT_MARKER = re.compile(
    r'(\n\.\.\.\[\d+ (?:bytes|characters of std(?:out|err)) cut\]\.\.\.\n)'
)
# A file that is not UTF-8 is often GBK (Chinese Windows) or UTF-16.
SECRET_ENCODINGS = ('utf-8', 'gbk', 'utf-16-le')


def marker(label=None):
    """The text that replaces a secret: ``[redacted:<label>]``."""
    if not label:
        return REDACTED
    clean = re.sub(r'[\x00-\x1f\x7f\]]', ' ', str(label)).strip()
    if len(clean) > LABEL_LIMIT:
        clean = clean[:LABEL_LIMIT - 1] + '…'
    return '[redacted:{}]'.format(clean) if clean else REDACTED


def _named(kind, label):
    label = (label or '').strip()
    return '{} "{}"'.format(kind, label) if label else kind


def vault_secrets(runtime):
    """``(secret, marker)`` for every secret the vault holds, longest first.

    A value used by several credentials (a reused password) gets one marker
    that names the first of them and counts the rest.
    """
    from .core.models.terminal import Identity, SshKey
    from .vault import resolve

    labels = {}

    def add(value, label):
        if not isinstance(value, str):
            return
        for candidate in (value, value.strip()):
            if len(candidate.strip()) >= MIN_SECRET_LENGTH:
                labels.setdefault(candidate, set()).add(label)

    try:
        for identity in runtime.storage.get_all(Identity):
            name = identity.label or identity.username
            add(identity.password, _named('password of identity', name))
        for key in runtime.storage.get_all(SshKey):
            add(key.private_key, _named('private key', key.label))
            add(key.passphrase, _named('passphrase of key', key.label))
    except Exception:  # pylint: disable=broad-except
        pass
    try:
        add(resolve(runtime), 'Termius vault password')
    except Exception:  # pylint: disable=broad-except
        pass
    pairs = []
    for value, names in labels.items():
        names = sorted(names)
        label = names[0]
        if len(names) > 1:
            label = '{} (+{} more)'.format(label, len(names) - 1)
        pairs.append((value, marker(label)))
    return sorted(pairs, key=lambda pair: len(pair[0]), reverse=True)


def _pairs(secrets):
    """Accept plain strings (marker ``[redacted]``) or ``(secret, marker)``."""
    pairs = []
    for item in secrets or ():
        if isinstance(item, (tuple, list)):
            pairs.append((item[0], item[1]))
        else:
            pairs.append((item, REDACTED))
    return pairs


def redact_text(text, secrets):
    """Replace secrets and private key blocks in one string."""
    if not isinstance(text, str) or not text:
        return text
    text = PRIVATE_KEY_BLOCK.sub(PRIVATE_KEY_MARKER, text)
    for secret, mark in _pairs(secrets):
        if secret and secret in text:
            text = text.replace(secret, mark)
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


# ── pieces at the edges of a slice ──────────────────────────────────────────

def _cut_partial_suffix(text, secret, mark):
    """``text`` ends with the first part of ``secret``: replace that part."""
    if len(secret) <= MIN_SECRET_LENGTH:
        return text
    start = max(len(text) - (len(secret) - 1), 0)
    head = secret[:MIN_SECRET_LENGTH]
    i = text.find(head, start)
    while i != -1:
        if secret.startswith(text[i:]):
            return text[:i] + mark
        i = text.find(head, i + 1)
    return text


def _cut_partial_prefix(text, secret, mark):
    """``text`` starts with the last part of ``secret``: replace that part."""
    if len(secret) <= MIN_SECRET_LENGTH:
        return text
    window = text[:len(secret) - 1]
    tail = secret[-MIN_SECRET_LENGTH:]
    j = window.rfind(tail)
    while j != -1:
        end = j + MIN_SECRET_LENGTH
        if secret.endswith(text[:end]):
            return mark + text[end:]
        j = window.rfind(tail, 0, end - 1)
    return text


def redact_edges(text, secrets, start=True, end=True):
    """Replace a piece of a secret at the start or the end of ``text``.

    A slice of a file or an output stream cut in the middle can begin with
    the end of a secret or stop after its beginning; neither half matches
    the whole secret. Pieces shorter than MIN_SECRET_LENGTH are left, like
    short secrets. Works on str and bytes (with bytes secrets and markers).
    """
    if not text:
        return text
    for secret, mark in _pairs(secrets):
        if type(secret) is not type(text):
            continue
        if end:
            text = _cut_partial_suffix(text, secret, mark)
        if start:
            text = _cut_partial_prefix(text, secret, mark)
    return text


def redact_around_cuts(text, secrets):
    """Redact secret pieces on both sides of every cut marker in ``text``."""
    if not isinstance(text, str) or not CUT_MARKER.search(text):
        return text
    parts = CUT_MARKER.split(text)
    last = len(parts) - 1
    for index in range(0, len(parts), 2):
        parts[index] = redact_edges(
            parts[index], secrets, start=index > 0, end=index < last,
        )
    return ''.join(parts)


# ── raw file data ───────────────────────────────────────────────────────────

def secret_bytes(secrets):
    """``(bytes, marker bytes)`` for each secret in the likely encodings."""
    found = {}
    for secret, mark in _pairs(secrets):
        for encoding in SECRET_ENCODINGS:
            try:
                found.setdefault(secret.encode(encoding), mark.encode('utf-8'))
            except UnicodeEncodeError:
                continue
    return sorted(found.items(), key=lambda pair: len(pair[0]), reverse=True)


def redact_bytes(data, secrets, start=False, end=False):
    """``redact_text`` for raw file data."""
    data = PRIVATE_KEY_BLOCK_BYTES.sub(PRIVATE_KEY_MARKER.encode('ascii'), data)
    encoded = secret_bytes(secrets)
    for secret, mark in encoded:
        if secret in data:
            data = data.replace(secret, mark)
    if start or end:
        data = redact_edges(data, encoded, start, end)
    return data


def redact_base64(content, secrets, start=False, end=False):
    """Redact inside base64 ``content`` (binary or non-UTF-8 file data,
    which ``redact_text`` cannot see) and re-encode it."""
    if not isinstance(content, str) or not content:
        return content
    try:
        data = base64.b64decode(content, validate=True)
    except (binascii.Error, ValueError):
        return content
    redacted = redact_bytes(data, secrets, start, end)
    if redacted == data:
        return content
    return base64.b64encode(redacted).decode('ascii')


def contains_marker(value):
    """True when ``value`` (str or bytes) holds a redaction marker."""
    if isinstance(value, bytes):
        return MARKER_BYTES.search(value) is not None
    return isinstance(value, str) and MARKER.search(value) is not None
