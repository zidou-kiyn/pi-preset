# -*- coding: utf-8 -*-
"""Process-wide Termius paths, config, and local storage."""
from os.path import expanduser
import os
import shutil
import threading

from pathlib2 import Path

from .core.settings import Config
from .core.signals import post_logout
from .core.storage import ApplicationStorage
from .core.storage.strategies import RelatedGetStrategy, SyncSaveStrategy
from .core.subscribers import clean_data
from .keychain import create_secret_store
from .vault import migrate_legacy_file


class Runtime(object):
    """Application context used by MCP tools. Not a CLI app."""

    def __init__(self, directory_path=None):
        # MCP tool calls run in worker threads. Hold this lock for any
        # access to config, secrets, storage, or Cloud sync.
        self.lock = threading.RLock()
        if directory_path is None:
            directory_path = expanduser('~/.termius/')
        self.directory_path = Path(directory_path)
        if not self.directory_path.is_dir():
            self.directory_path.mkdir(parents=True)
        post_logout.connect(clean_data)
        self.secrets = create_secret_store(self.directory_path)
        self._disk_stamp = None
        self._load_from_disk()
        self._remove_legacy_plaintext()

    def _load_from_disk(self):
        # Stamp first: a write that lands while reading shows up as a
        # changed stamp on the next refresh instead of being missed.
        self._disk_stamp = self._read_disk_stamp()
        self.config = Config(self, secrets=self.secrets)
        self._storage_cipher = self.secrets.storage_cipher()
        self.storage = self._open_storage()

    def _read_disk_stamp(self):
        stamp = []
        for name in ('config', 'storage'):
            try:
                st = os.stat(str(self.directory_path / name))
            except OSError:
                stamp.append(None)
                continue
            mtime_ns = getattr(st, 'st_mtime_ns', int(st.st_mtime * 1e9))
            stamp.append((st.st_ino, mtime_ns, st.st_size))
        return tuple(stamp)

    def refresh(self):
        """Re-read config and storage when another process changed them.

        pi-preset: sign-in, sign-out, and sync from /termius run in a
        separate ``termius login-json`` process (the CLI and other pi
        sessions write the same files). Without this the server would
        keep the session it read at startup and report "Not signed in"
        until restarted. Hold ``self.lock``.
        """
        if self._read_disk_stamp() != self._disk_stamp:
            self._load_from_disk()

    def reload_storage(self):
        """Re-open storage after another writer flushed the file."""
        self.storage = self._open_storage()

    def _open_storage(self):
        return ApplicationStorage(
            self,
            get_strategy=RelatedGetStrategy,
            save_strategy=SyncSaveStrategy,
            cipher=self._storage_cipher,
        )

    def _remove_legacy_plaintext(self):
        """Clean up plaintext secrets that older versions wrote to disk."""
        migrate_legacy_file(self)
        ssh_keys = self.directory_path / 'ssh_keys'
        if ssh_keys.is_dir():
            shutil.rmtree(str(ssh_keys))
        if self.config.config.has_section('SSH_keys'):
            self.config.remove_section('SSH_keys')
            self.config.write()
