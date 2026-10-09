# -*- coding: utf-8 -*-
"""Print the *structure* of the Termius Cloud sync payload, never its values.

A development aid for following protocol changes (new entity sets such as
jump-host chains or proxies). It signs nothing new: it uses the existing
sign-in and the remembered vault password, fetches the same sync payload a
pull fetches, decrypts it in memory, and prints per set the record count
and each field's type. Strings print as ``str``, references to other
records as ``ref``; no value, label, address, or secret is ever printed.

Run inside the server environment:  python scripts/sync_schema.py
"""
from __future__ import print_function

import json
import sys
from collections import OrderedDict, defaultdict


def shape(value, depth=0):
    """Type description of a value, without the value."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'bool'
    if isinstance(value, int):
        return 'int'
    if isinstance(value, float):
        return 'float'
    if isinstance(value, str):
        return 'str'
    if isinstance(value, list):
        inner = sorted({shape(item, depth + 1) for item in value[:20]})
        return 'list[{}]'.format('|'.join(inner) if inner else '')
    if isinstance(value, dict):
        if set(value) <= {'id', 'local_id'}:
            return 'ref'
        if depth >= 2:
            return 'dict'
        return '{' + ', '.join('{}: {}'.format(k, shape(v, depth + 1)) for k, v in sorted(value.items())) + '}'
    return type(value).__name__


def main():
    from termius.cloud.client.controllers import ApiController
    from termius.cloud.client.cryptor import UnifiedCryptor
    from termius.cloud.client.keyring import load_keyring
    from termius.runtime import Runtime
    from termius.sync import require_signed_in
    from termius.vault import resolve

    runtime = Runtime()
    salt, hmac_salt = require_signed_in(runtime.config)
    password = resolve(runtime)
    if not password:
        print('vault password is not remembered; sign in first', file=sys.stderr)
        return 1
    cryptor = UnifiedCryptor(password, salt, hmac_salt)
    controller = ApiController(runtime.storage, runtime.config, cryptor)
    pkset = {
        name: runtime.config.get_safe('User', name)
        for name in ('public_key', 'encrypted_private_key', 'encrypted_personal_key')
    }
    cryptor.keyring = load_keyring(controller.api, runtime.config, cryptor, pkset)
    cryptor._sodium = None  # pylint: disable=protected-access

    url = sys.argv[1] if len(sys.argv) > 1 else 'v4/terminal/sync/'
    payload = controller.api.get(url)
    report = OrderedDict()
    for key in sorted(payload):
        value = payload[key]
        if not isinstance(value, list):
            report[key] = shape(value)
            continue
        fields = defaultdict(set)
        undecryptable = 0
        for record in value:
            plain = controller.crypto_controller.decrypt_payload(record) if isinstance(record, dict) else record
            if not isinstance(plain, dict):
                fields['<item>'].add(shape(plain))
                continue
            if plain.get('_undecryptable'):
                undecryptable += 1
            for name, item in plain.items():
                fields[name].add(shape(item))
        report[key] = OrderedDict([
            ('count', len(value)),
            ('undecryptable', undecryptable),
            ('fields', OrderedDict((name, sorted(kinds)) for name, kinds in sorted(fields.items()))),
        ])
    json.dump(report, sys.stdout, indent=1)
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
