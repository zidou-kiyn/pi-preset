# -*- coding: utf-8 -*-
import os
from unittest.mock import Mock
from pathlib2 import Path
from six.moves import configparser
from unittest import TestCase

from termius.core.settings import Config


class ConfigGetSafeTest(TestCase):
    def tearDown(self):
        path = Path('/tmp/config')
        if path.is_file():
            os.remove(str(path))

    def test_get_safe_with_nooption(self):
        config = get_config()
        default = False
        falled_back = config.get_safe('User', 'key', default=default)
        self.assertEqual(falled_back, default)

    def test_get_safe_with_general_error(self):
        config = get_config()
        with self.assertRaises(TypeError):
            config.get_safe()

    def test_get_with_nooption(self):
        config = get_config()
        with self.assertRaises(configparser.NoSectionError):
            config.get('User', 'key')


def get_config():
    config = Config(Mock(**{'app.directory_path': '/tmp'}))
    config.touch_files()
    return config
