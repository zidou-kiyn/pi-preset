# -*- coding: utf-8 -*-
"""Merge inherited SSH settings and look up hosts."""
from .exceptions import DoesNotExistException, TooManyEntriesException
from .models.terminal import Host, Identity, SshConfig
from .models.utils import GroupStackGenerator, Merger


class HostLookupError(ValueError):
    """Host id or label did not resolve to a single host."""


def get_group_stack(instance):
    """Return parent groups from nearest to root."""
    return GroupStackGenerator(instance).generate()


def get_merged_ssh_config(instance):
    """Return the host or group SSH config after group inheritance."""
    full_stack = [instance] + get_group_stack(instance)
    return merge_ssh_config(full_stack)


def merge_ssh_config(full_stack):
    """Squash a host/group stack into one SshConfig."""
    ssh_config_merger = Merger(full_stack, 'ssh_config', SshConfig())
    ssh_config = ssh_config_merger.merge()
    visible_identity = _visible_identity(ssh_config_merger)
    if visible_identity:
        ssh_config.identity = visible_identity
    else:
        ssh_config.identity = _identity_merger(ssh_config_merger).merge()
    return ssh_config


def _visible_identity(ssh_config_merger):
    stack = [
        item.identity for item in ssh_config_merger.get_entry_stack()
        if item.identity and item.identity.get('is_visible')
    ]
    return stack[0] if stack else None


def _identity_merger(ssh_config_merger):
    stack = [
        item for item in ssh_config_merger.get_entry_stack()
        if item.identity and not item.identity.get('is_visible')
    ]
    return Merger(stack, 'identity', Identity())


def _chain_hosts(storage, host):
    chain = get_merged_ssh_config(host).get('host_chain') or ''
    hops = []
    for raw in [item for item in chain.split(',') if item.strip()]:
        try:
            hops.append(storage.get(Host, **{'remote_instance.id': int(raw)}))
        except (DoesNotExistException, ValueError):
            raise HostLookupError(
                'A jump host of {} is not in the local cache; call sync.'.format(
                    host.label or host.address
                )
            )
    return hops


def get_jump_route(storage, host, _seen=None):
    """Jump hosts for ``host`` from its Termius host chain, in hop order.

    Returns ``[(jump_host, merged_ssh_config), ...]``; empty when the host
    (and its groups) has no chain. A chain inherited from a group may list
    the target itself; the chain then ends before it. The first jump host is
    reached the way it is reached on its own, so its chain comes first
    (like ``ProxyJump`` on a jump host in ssh_config); the later hops are
    reached through the earlier ones. A loop is an error.
    """
    seen = set(_seen or ()) | {host.id}
    hops = []
    for hop in _chain_hosts(storage, host):
        if hop.id == host.id:
            break
        hops.append(hop)
    if not hops:
        return []
    for hop in hops:
        if hop.id in seen:
            raise HostLookupError(
                'The jump host chain of {} loops through {}.'.format(
                    host.label or host.address, hop.label or hop.address
                )
            )
    first = hops[0]
    route = get_jump_route(storage, first, seen)
    route.extend((hop, get_merged_ssh_config(hop)) for hop in hops)
    return route


def find_host(storage, name):
    """Return one Host by numeric id or exact label."""
    if name is None or str(name).strip() == '':
        raise HostLookupError('Host id or label is required')
    name = str(name)
    try:
        relation_id = int(name)
    except (TypeError, ValueError):
        relation_id = None
    try:
        return storage.get(Host, query_union=any, id=relation_id, label=name)
    except DoesNotExistException:
        raise HostLookupError('Host not found: {}'.format(name))
    except TooManyEntriesException:
        raise HostLookupError(
            'Multiple hosts match "{}". Use the numeric id from hosts.'.format(
                name
            )
        )
