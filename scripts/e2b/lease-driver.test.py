"""Exercise the real lease guard without opening a display or executing a driver."""
import contextlib
import io
import json
import os
import runpy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('lease-driver.py')
BOT = 'bot-fixture'
OWNER = 'owner-fixture'


def run_guard(state, *, bot=BOT, owner=OWNER, version='3', display=':1'):
    # execv is intercepted; code 42 proves the guard reached only its final exec.
    with patch.object(sys, 'argv', [str(SCRIPT), display, bot, owner, version]), \
         patch.dict(os.environ, {'DISPLAY': display}), \
         patch.object(Path, 'read_text', return_value=json.dumps(state)), \
         patch.object(os, 'execv', side_effect=SystemExit(42)), \
         contextlib.redirect_stderr(io.StringIO()):
        try:
            runpy.run_path(str(SCRIPT))
        except SystemExit as result:
            return result.code
    raise AssertionError('guard must stop before returning')


class LeaseGuardTest(unittest.TestCase):
    def test_owner_display_policy_version_and_user_takeover_are_fenced(self):
        state = {'botId': BOT, 'ownerId': OWNER, 'display': 1,
                 'computerAllowed': True, 'policyVersion': 3}
        self.assertEqual(run_guard(state), 42)
        self.assertEqual(run_guard(state, bot='other'), 1)
        self.assertEqual(run_guard(state, owner='other'), 1)
        self.assertEqual(run_guard(state, display=':2'), 1)
        self.assertEqual(run_guard(state, version='2'), 1)
        self.assertEqual(run_guard({**state, 'computerAllowed': False}), 1)
        self.assertEqual(run_guard({**state, 'controlledBy': 'person', 'controlUntil': 4102444800}), 1)


if __name__ == '__main__':
    unittest.main()
