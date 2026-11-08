import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('firewall', Path(__file__).with_name('preview_firewall.py'))
firewall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firewall)


class FirewallPolicy(unittest.TestCase):
    def test_both_families_reject_every_non_loopback_interface_and_verify(self):
        calls, installed = [], set()

        def run(arguments, **options):
            calls.append(arguments)
            key = arguments[0]
            if '--insert' in arguments:
                installed.add(key)
                return SimpleNamespace(returncode=0)
            self.assertIn('--check', arguments)
            return SimpleNamespace(returncode=0 if key in installed else 1)

        result = firewall.protect_port(3000, run=run, which=lambda name: '/sbin/' + name)
        self.assertTrue(result['protected'])
        self.assertEqual(installed, {'/sbin/iptables', '/sbin/ip6tables'})
        self.assertEqual(len(calls), 6)
        for arguments in calls:
            self.assertIn('INPUT', arguments)
            self.assertIn('!', arguments)
            self.assertIn('lo', arguments)
            self.assertIn('REJECT', arguments)
            self.assertIn('tcp-reset', arguments)
            self.assertNotIn('--delete', arguments)
        before = len(calls)
        firewall.protect_port(3000, run=run, which=lambda name: '/sbin/' + name)
        self.assertEqual(len(calls) - before, 4, 'a reused port still rechecks both live rules')

    def test_missing_ipv6_permission_failure_and_unverified_insert_fail_closed(self):
        with self.assertRaises(firewall.FirewallError):
            firewall.protect_port(3000, which=lambda name: '/sbin/iptables' if name == 'iptables' else None)
        for status in (2, 3, 4):
            with self.assertRaises(firewall.FirewallError):
                firewall.protect_port(3000, run=lambda *_args, **_options: SimpleNamespace(returncode=status), which=lambda name: name)
        sequence = iter((1, 0, 1))
        with self.assertRaises(firewall.FirewallError):
            firewall.protect_port(3000, run=lambda *_args, **_options: SimpleNamespace(returncode=next(sequence)), which=lambda name: name)

    def test_no_arbitrary_port_or_infrastructure_port_can_be_protected(self):
        for port in ('3000; true', '3000', True, 0, 80, 49983, 50005, 65536):
            with self.assertRaises(firewall.FirewallError):
                firewall.protect_port(port)


if __name__ == '__main__':
    unittest.main(verbosity=2)
