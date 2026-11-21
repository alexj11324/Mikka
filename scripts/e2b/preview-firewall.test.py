import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('firewall', Path(__file__).with_name('preview_firewall.py'))
firewall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firewall)


class FirewallPolicy(unittest.TestCase):
    def receipt(self):
        return {'ok': True, 'version': 1, 'sourceSha256': 'a' * 64, 'bootId': '1' * 36,
                'installedTicks': 123, 'providerPorts': [49983], 'preparedBeforeWorker': True,
                'rulesVerified': {'ipv4': True, 'ipv6': True}}

    def test_each_read_only_verifies_existing_pre_worker_rules(self):
        calls = []
        def run(arguments, **options):
            calls.append(arguments)
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.receipt()).encode())
        for port in (3000, 5173):
            self.assertEqual(firewall.protect_port(port, run=run), {'protected': True, 'ipv4': True, 'ipv6': True, 'port': port})
        self.assertEqual(calls, [[firewall.sys.executable, firewall.GUARD, 'verify']] * 2)

    def test_cloudflare_requires_its_own_verified_empty_provider_ports(self):
        cf = self.receipt() | {'provider': 'cloudflare', 'providerPorts': []}
        for cloudflare, proof, allowed in ((True, cf, True), (True, self.receipt(), False),
                                           (False, cf, False), (True, cf | {'providerPorts': [49983]}, False)):
            def run(*_args, **_options):
                return SimpleNamespace(returncode=0, stdout=json.dumps(proof).encode())
            if allowed:
                self.assertTrue(firewall.protect_port(3000, cloudflare=cloudflare, run=run)['protected'])
            else:
                with self.assertRaisesRegex(firewall.FirewallError, 'firewall_unsupported'):
                    firewall.protect_port(3000, cloudflare=cloudflare, run=run)

    def test_old_vm_stale_partial_or_malformed_proof_never_installs_rules(self):
        bad = [b'', b'null', b'[]', b'false', b'x' * 4097, b'{"ok":false}']
        for update in ({'preparedBeforeWorker': False}, {'rulesVerified': {'ipv4': True, 'ipv6': False}},
                       {'sourceSha256': 'wrong'}, {'providerPorts': [50005]}, {'installedTicks': -1}, {'version': 0}):
            bad.append(json.dumps(self.receipt() | update).encode())
        for value in bad:
            calls = []
            def run(arguments, **options):
                calls.append(arguments)
                return SimpleNamespace(returncode=0, stdout=value)
            with self.assertRaisesRegex(firewall.FirewallError, 'firewall_unsupported'):
                firewall.protect_port(3000, run=run)
            self.assertEqual(calls, [[firewall.sys.executable, firewall.GUARD, 'verify']])
        for status in (1, 2, 3):
            with self.assertRaisesRegex(firewall.FirewallError, 'firewall_unsupported'):
                firewall.protect_port(3000, run=lambda *_a, **_k: SimpleNamespace(returncode=status, stdout=b''))

    def test_failed_bounded_read_preserves_cause(self):
        for failure in (OSError('fixture'), subprocess.TimeoutExpired('fixture', 25)):
            def run(*_a, **_k):
                raise failure
            with self.assertRaisesRegex(firewall.FirewallError, 'firewall_unavailable') as caught:
                firewall.protect_port(3000, run=run)
            self.assertIs(caught.exception.__cause__, failure)

    def test_no_arbitrary_port_or_infrastructure_port_can_be_protected(self):
        for port in ('3000; true', '3000', True, 0, 80, 49983, 50005, 65536):
            with self.assertRaises(firewall.FirewallError):
                firewall.protect_port(port)


if __name__ == '__main__':
    unittest.main(verbosity=2)
