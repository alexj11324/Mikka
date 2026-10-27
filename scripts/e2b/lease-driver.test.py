import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('lease_driver', Path(__file__).with_name('lease-driver.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class LeaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / '1.lock').touch()
        self.state = {'botId': 'bot', 'ownerId': 'owner', 'display': 1,
                      'computerAllowed': True, 'policyVersion': 1,
                      'controlledBy': None, 'controlUntil': 0}
        self.publish()

    def tearDown(self):
        self.temp.cleanup()

    def publish(self):
        with (self.root / '1.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            (self.root / '1.json').write_text(json.dumps(self.state))
            fcntl.flock(lock, fcntl.LOCK_UN)

    def waiter(self):
        result = []
        def run():
            try:
                result.append(driver.acquire(self.root, ':1', 'bot', 'owner', '1', .01))
            except Exception as error:
                result.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, result

    def test_person_holds_control_until_handback(self):
        self.state.update(controlledBy='person', controlUntil=time.time() + 60)
        self.publish()
        thread, result = self.waiter()
        time.sleep(.1)
        self.assertTrue(thread.is_alive())
        self.assertEqual(result, [])
        self.state.update(controlledBy=None, controlUntil=0)
        self.publish()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result[0], int)
        os.close(result[0])

    def test_agents_are_exclusive_and_policy_revocation_fences_waiter(self):
        first = driver.acquire(self.root, ':1', 'bot', 'owner', '1', .01)
        thread, result = self.waiter()
        time.sleep(.1)
        self.assertTrue(thread.is_alive())
        # Publish the new policy while holding the same lease, as the server
        # does after the first operation releases it.
        self.state.update(computerAllowed=False, policyVersion=2)
        (self.root / '1.json').write_text(json.dumps(self.state))
        os.close(first)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result[0], ValueError)


if __name__ == '__main__':
    unittest.main()
