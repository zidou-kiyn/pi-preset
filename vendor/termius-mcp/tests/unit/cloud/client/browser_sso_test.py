# -*- coding: utf-8 -*-
from unittest import TestCase

from termius.cloud.client.browser_sso import (
    desktop_sso_url, parse_continue_sso_url, parse_google_callback,
)
from termius.core.exceptions import ApiError


class ParseContinueSsoUrlTest(TestCase):
    def test_desktop_callback(self):
        parsed = parse_continue_sso_url(
            'termius://app/continue-sso?email=you@example.com'
            '&firebaseToken=abc.def.ghi&requestId=req-1'
        )
        self.assertEqual(parsed['email'], 'you@example.com')
        self.assertEqual(parsed['firebase_token'], 'abc.def.ghi')
        self.assertEqual(parsed['request_id'], 'req-1')

    def test_nested_url_query(self):
        parsed = parse_continue_sso_url(
            'http://127.0.0.1:9/cb?url='
            'termius%3A%2F%2Fapp%2Fcontinue-sso%3Femail%3Da%40b.c'
            '%26firebaseToken%3Dtok%26requestId%3Drid'
        )
        self.assertEqual(parsed['email'], 'a@b.c')
        self.assertEqual(parsed['firebase_token'], 'tok')
        self.assertEqual(parsed['request_id'], 'rid')

    def test_rejects_garbage(self):
        with self.assertRaises(ApiError):
            parse_continue_sso_url('https://example.com/')

    def test_query_string_only(self):
        parsed = parse_continue_sso_url(
            'email=you@example.com&firebaseToken=tok&requestId=rid'
        )
        self.assertEqual(parsed['email'], 'you@example.com')
        self.assertEqual(parsed['firebase_token'], 'tok')
        self.assertEqual(parsed['request_id'], 'rid')


class ParseGoogleCallbackTest(TestCase):
    def test_hash_id_token(self):
        parsed = parse_google_callback(
            'http://127.0.0.1:8765/callback#id_token=abc.def.ghi&state=x'
        )
        self.assertEqual(parsed['id_token'], 'abc.def.ghi')

    def test_not_google(self):
        self.assertIsNone(parse_google_callback('https://example.com/'))


class DesktopSsoUrlTest(TestCase):
    def test_builds_account_url(self):
        url = desktop_sso_url('google', 'abc-123')
        self.assertEqual(
            url,
            'https://account.termius.com/sso/desktop?provider=google&request=abc-123',
        )
