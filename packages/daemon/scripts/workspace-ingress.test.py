"""Offline policy/state checks; never changes the host's netfilter rules.

The separate fixed-source E2B acceptance proves real kernel/provider behavior.
"""
import importlib.util
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ingress', Path(__file__).with_name('workspace-ingress.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def native_ack_rules(ports):
    """Independent numeric nft fixture; header sizes are bytes, not product helpers."""
    for family, version in (('ip', 2), ('ip6', 10)):
        for tcp_bytes in range(20, 61, 4):
            expr = [
                {'match': {'op': '==', 'left': {'meta': {'key': 'nfproto'}}, 'right': version}},
                {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 6}},
                {'match': {'op': '==', 'left': {'ct': {'key': 'direction'}}, 'right': 1}},
                {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'sport'}},
                           'right': ports[0] if len(ports) == 1 else {'set': list(ports)}}},
                {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'flags'}}, 'right': 16}},
            ]
            if family == 'ip':
                expr.extend([
                    {'match': {'op': '==', 'left': {'&': [{'payload': {'protocol': 'ip', 'field': 'frag-off'}}, 16383]}, 'right': 0}},
                    {'match': {'op': '==', 'left': {'payload': {'protocol': 'ip', 'field': 'hdrlength'}}, 'right': 5}},
                ])
            else:
                expr.append({'match': {'op': '==', 'left': {'payload': {'protocol': 'ip6', 'field': 'length'}}, 'right': tcp_bytes}})
                expr.append({'match': {'op': '==', 'left': {'payload': {'protocol': 'ip6', 'field': 'nexthdr'}}, 'right': 6}})
            expr.extend([
                {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'doff'}}, 'right': tcp_bytes // 4}},
                {'match': {'op': '==', 'left': {'meta': {'key': 'length'}}, 'right': tcp_bytes + (20 if family == 'ip' else 40)}},
            ])
            if family == 'ip':
                expr.append({'match': {'op': '==', 'left': {'payload': {'protocol': 'ip', 'field': 'length'}}, 'right': tcp_bytes + 20}})
            expr.append({'return': None})
            yield {'rule': {'family': 'inet', 'table': 'mikka_review_v1', 'chain': 'guard',
                            'handle': 10 + (0 if family == 'ip' else 11) + (tcp_bytes - 20) // 4, 'expr': expr}}


def native_table(ports=(49983,)):
    """Documented nft 1.0.6/1.0.9 numeric listing; no product policy reuse."""
    return {'nftables': [
        {'metainfo': {'version': '1.0.6', 'release_name': 'fixture', 'json_schema_version': 1}},
        {'table': {'family': 'inet', 'name': 'mikka_review_v1', 'handle': 1}},
        {'chain': {'family': 'inet', 'table': 'mikka_review_v1', 'name': 'guard', 'handle': 2}},
        {'rule': {'family': 'inet', 'table': 'mikka_review_v1', 'chain': 'guard', 'handle': 4, 'expr': [
            {'match': {'op': '==', 'left': {'meta': {'key': 'skuid'}}, 'right': 0}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'sport'}},
                       'right': ports[0] if len(ports) == 1 else {'set': list(ports)}}},
            {'return': None}]}},
        *native_ack_rules(ports),
        {'rule': {'family': 'inet', 'table': 'mikka_review_v1', 'chain': 'guard', 'handle': 5, 'expr': [
            {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 6}},
            {'match': {'op': '==', 'left': {'ct': {'key': 'direction'}}, 'right': 1}},
            {'match': {'op': '!=', 'left': {'meta': {'key': 'mark'}}, 'right': 1296781398}},
            {'reject': {'type': 'tcp reset'}}]}},
        {'chain': {'family': 'inet', 'table': 'mikka_review_v1', 'name': 'output', 'handle': 3,
                   'type': 'filter', 'hook': 'output', 'prio': -1, 'policy': 'accept'}},
        {'rule': {'family': 'inet', 'table': 'mikka_review_v1', 'chain': 'output', 'handle': 6, 'expr': [
            {'match': {'op': '!=', 'left': {'meta': {'key': 'oifname'}}, 'right': 'lo'}},
            {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 6}},
            {'jump': {'target': 'guard'}}]}},
    ]}


class Netfilter:
    def __init__(self):
        self.value = None
        self.foreign = [{'table': {'family': 'ip', 'name': 'provider', 'handle': 100}}]
        self.calls = []
        self.scripts = []
        self.fail_exact = None
        self.raw = None

    def run(self, args, **options):
        self.calls.append(args)
        assert args[0] == 'nft'
        tail = args[1:]
        if tail == ['--version']:
            return SimpleNamespace(returncode=0, stdout=b'nftables v1.0.6 (fixture)', stderr=b'')
        if self.fail_exact == tuple(args):
            return SimpleNamespace(returncode=1, stdout=b'', stderr=b'Operation not supported')
        if tail == ['-j', '-n', 'list', 'ruleset']:
            output = {'nftables': deepcopy(self.foreign) + (self.value['nftables'] if self.value else [])}
        elif tail == ['-f', '-']:
            assert self.value is None
            script = options['input'].decode('ascii')
            self.scripts.append(script)
            self.value = native_table((49983, 50005) if 'tcp sport { 49983, 50005 }' in script else (49983,))
            if 'tcp sport' not in script:
                rows = self.value['nftables']
                self.value['nftables'] = rows[:3] + rows[-3:]
                self.value['nftables'][-3]['rule']['expr'][-1] = {'drop': None}
            output = None
        elif tail == ['-j', '-n', 'list', 'table', 'inet', 'mikka_review_v1']:
            assert self.value is not None
            if self.raw is not None:
                return SimpleNamespace(returncode=0, stdout=self.raw, stderr=b'')
            output = self.value
        else:
            raise AssertionError(args)
        return SimpleNamespace(returncode=0, stdout=json.dumps(output).encode() if output is not None else b'', stderr=b'')


class IngressPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid() != 0:
            raise RuntimeError('Ingress root-owned state tests require root; do not silently skip this gate')

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='mikka-ingress-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.filter = Netfilter()
        for name, value in (('ROOT', self.root / 'state'), ('RECEIPT', self.root / 'state/receipt.json'),
                            ('MACHINE_FILES', (self.root / 'bootstrap.json', self.root / 'device.json', self.root / 'preloaded.pid'))):
            installed = patch.object(guard, name, value)
            installed.start()
            self.addCleanup(installed.stop)
        for installed in (patch.object(guard.subprocess, 'run', side_effect=self.filter.run),
                          patch.object(guard.shutil, 'which', side_effect=lambda name, **_kw: name),
                          patch.object(guard, 'provider_ports', return_value=[49983])):
            installed.start()
            self.addCleanup(installed.stop)

    def test_private_cloudflare_boot_has_no_provider_port_exceptions(self):
        receipt = guard.prepare(cloudflare=True)
        self.assertEqual(receipt['provider'], 'cloudflare')
        self.assertEqual(receipt['providerPorts'], [])
        self.assertEqual(receipt['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.assertNotIn('tcp sport', self.filter.scripts[0])
        self.assertIn('meta mark != 1296781398 drop', self.filter.scripts[0])
        self.assertEqual(guard.prepare(cloudflare=True), receipt)
        with self.assertRaisesRegex(guard.IngressError, 'provider'):
            guard.prepare()
        self.filter.value['nftables'].insert(3, native_table()['nftables'][3])
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()

    def test_emitted_ack_rules_bind_exact_lengths_to_complete_headers(self):
        # The netfilter fixture is deliberately independent of policy(). Check
        # its emitted input too: no packet emulator or product ACK helper is
        # used to construct the required header-only length relationships.
        for ports in ([49983], [49983, 50005]):
            source_ports = '49983' if len(ports) == 1 else '{ 49983, 50005 }'
            lines = guard.policy(ports).splitlines()
            self.assertEqual(len(lines), 28)
            for family, start, ip_bytes in (('ipv4', 4, 20), ('ipv6', 15, 40)):
                prefix = (f'add rule inet mikka_review_v1 guard meta nfproto {family} '
                          'meta l4proto tcp ct direction reply tcp sport ' + source_ports
                          + ' tcp flags == ack ')
                shape = (r'ip frag-off & 0x3fff == 0 ip hdrlength 5 tcp doff (?P<doff>\d+) '
                         r'meta length (?P<actual>\d+) ip length (?P<declared>\d+) return'
                         if family == 'ipv4' else
                         r'ip6 length (?P<declared>\d+) ip6 nexthdr tcp tcp doff (?P<doff>\d+) '
                         r'meta length (?P<actual>\d+) return')
                for line, tcp_bytes in zip(lines[start:start + 11], range(20, 61, 4), strict=True):
                    with self.subTest(ports=ports, family=family, tcp_bytes=tcp_bytes):
                        match = re.fullmatch(re.escape(prefix) + shape, line)
                        self.assertIsNotNone(match, 'ACK rule changed a mandatory predicate or exact flags equality')
                        values = {key: int(value) for key, value in match.groupdict().items()}
                        self.assertEqual(values, {'doff': tcp_bytes // 4, 'actual': ip_bytes + tcp_bytes,
                                                  'declared': tcp_bytes + (20 if family == 'ipv4' else 0)})

    def test_fresh_policy_is_global_dual_stack_and_preserves_only_observed_root_provider(self):
        foreign = deepcopy(self.filter.foreign)
        proof = guard.prepare()
        self.assertTrue(proof['preparedBeforeWorker'])
        self.assertEqual(proof['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.assertEqual(proof['providerPorts'], [49983])
        self.assertEqual(self.filter.foreign, foreign)
        self.assertEqual(len(self.filter.scripts), 1)
        self.assertNotIn('50005', self.filter.scripts[0])
        self.assertNotIn('flush', self.filter.scripts[0])
        self.assertTrue(all(args[0] == 'nft' for args in self.filter.calls))

    def test_finalizer_without_xt_owner_uses_one_native_inet_transaction(self):
        calls = []
        # Native output schema comes from nftables 1.0.6 src/json.c and its
        # inet/tcp + inet/reject fixtures, with numeric output enabled.
        native = native_table()

        def run(args, **options):
            calls.append((args, options.get('input')))
            if args[0] != 'nft':
                if '--uid-owner' in args:
                    return SimpleNamespace(returncode=4, stdout=b'',
                                           stderr=b'Warning: Extension owner revision 0 not supported, missing kernel module?')
                return SimpleNamespace(returncode=0, stdout=b'iptables v1.8.9 (nf_tables)', stderr=b'')
            if args[1:] == ['--version']:
                return SimpleNamespace(returncode=0, stdout=b'nftables v1.0.6 (fixture)', stderr=b'')
            if args[1:] == ['-j', '-n', 'list', 'ruleset']:
                output = {'nftables': []}
            elif args[1:] == ['-f', '-']:
                output = None
            elif args[1:] == ['-j', '-n', 'list', 'table', 'inet', 'mikka_review_v1']:
                output = native
            else:
                raise AssertionError(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps(output).encode() if output else b'', stderr=b'')

        with patch.object(guard.subprocess, 'run', side_effect=run):
            proof = guard.prepare()
        self.assertEqual(proof['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.assertTrue(all(args[0] == 'nft' for args, _ in calls))
        scripts = [value.decode() for args, value in calls if args[1:] == ['-f', '-']]
        self.assertEqual(len(scripts), 1)
        lines = scripts[0].splitlines()
        self.assertEqual(len(lines), 28)
        self.assertEqual(lines[:4], [
            'create table inet mikka_review_v1',
            'add chain inet mikka_review_v1 guard',
            'add chain inet mikka_review_v1 output { type filter hook output priority -1; policy accept; }',
            'add rule inet mikka_review_v1 guard meta l4proto tcp meta skuid 0 tcp sport 49983 return',
        ])
        self.assertEqual(lines[-2:], [
            'add rule inet mikka_review_v1 guard meta l4proto tcp ct direction reply meta mark != 1296781398 reject with tcp reset',
            'add rule inet mikka_review_v1 output oifname != "lo" meta l4proto tcp jump guard',
        ])

    def test_repeated_prepare_only_verifies_original_receipt_and_never_repairs_rules(self):
        proof = guard.prepare()
        original = guard.RECEIPT.read_bytes()
        (self.root / 'bootstrap.json').write_text('{}')
        self.filter.calls.clear()
        self.assertEqual(guard.prepare(), proof)
        self.assertEqual(guard.RECEIPT.read_bytes(), original)
        self.assertTrue(all(args[1:] == ['--version'] or args[1:] == ['-j', '-n', 'list', 'table', 'inet', 'mikka_review_v1']
                            for args in self.filter.calls))
        self.filter.value['nftables'].pop(4)
        with self.assertRaises(guard.IngressError):
            guard.prepare()
        self.assertEqual(guard.RECEIPT.read_bytes(), original)
        self.assertEqual(len(self.filter.scripts), 1)

    def test_late_install_or_unknown_partial_table_never_creates_a_receipt(self):
        (self.root / 'preloaded.pid').write_text('123')
        with self.assertRaisesRegex(guard.IngressError, 'late_install'):
            guard.prepare()
        self.assertFalse(self.filter.calls)
        (self.root / 'preloaded.pid').unlink()
        self.filter.fail_exact = ('nft', '-f', '-')
        with self.assertRaises(guard.IngressError):
            guard.prepare()
        self.assertFalse(guard.RECEIPT.exists())
        self.assertIsNone(self.filter.value)
        self.filter.fail_exact = None
        self.filter.value = {'nftables': [{'table': {'family': 'inet', 'name': 'mikka_review_v1', 'handle': 1}}]}
        with self.assertRaises(guard.IngressError):
            guard.prepare()
        self.assertFalse(guard.RECEIPT.exists(), 'a later request cannot adopt a partially installed chain')
        self.assertFalse(self.filter.scripts)
        self.filter.value = None
        self.filter.foreign.append({'chain': {'family': 'ip6', 'table': 'filter', 'name': 'MIKKA_REVIEW_REPLY_V1'}})
        with self.assertRaisesRegex(guard.IngressError, 'state'):
            guard.prepare()
        self.assertFalse(self.filter.scripts, 'legacy rules without their receipt must not be adopted')

    def test_each_native_boundary_reports_the_actual_failing_call(self):
        operations = {
            'install_policy': ['-f', '-'],
            'list_ruleset': ['-j', '-n', 'list', 'ruleset'],
            'list_table': ['-j', '-n', 'list', 'table', 'inet', 'mikka_review_v1'],
        }
        for operation, arguments in operations.items():
            with self.subTest(operation=operation):
                self.filter.value = None
                self.filter.fail_exact = tuple(['nft', *arguments])
                directory = self.root / operation
                with patch.object(guard, 'ROOT', directory), patch.object(guard, 'RECEIPT', directory / 'receipt.json'):
                    with self.assertRaises(guard.IngressCommandError) as failed:
                        guard.prepare()
                    receipt = guard.failure_receipt(failed.exception)
                    self.assertEqual(receipt['detail'], 'command')
                    self.assertEqual({key: receipt['command'][key] for key in ('family', 'operation', 'failureKind', 'returnCode')},
                                     {'family': 'inet', 'operation': operation, 'failureKind': 'exit', 'returnCode': 1})
                    self.assertFalse(guard.RECEIPT.exists(), 'failure must not grant a readiness receipt')

    def test_rule_precedence_and_added_broad_allow_fail_verification(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        self.filter.value['nftables'][-2]['chain']['prio'] = 0
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()
        self.filter.value = deepcopy(original)
        self.filter.value['nftables'][3]['rule']['expr'].insert(0, {'accept': None})
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()
        self.filter.value = deepcopy(original)
        self.filter.value['nftables'][3:5] = reversed(self.filter.value['nftables'][3:5])
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()

    def test_complete_native_conditions_and_unknown_objects_cannot_be_weakened(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        changes = (
            lambda rows: rows[0]['metainfo'].update(handle=1),
            lambda rows: rows[1]['table'].update(flags=['dormant']),
            lambda rows: rows[1]['table'].update(flags=['owner']),
            lambda rows: rows[1]['table'].update(family='ip'),
            lambda rows: rows[2]['chain'].update(comment='unexpected'),
            lambda rows: rows[3]['rule']['expr'].pop(0),
            lambda rows: rows[3]['rule']['expr'][0]['match'].update(right=False),
            lambda rows: rows[3]['rule']['expr'][1]['match'].update(right=50005),
            lambda rows: rows[3]['rule']['expr'][-1].update(accept=None),
            lambda rows: rows[-3]['rule']['expr'][0]['match'].update(right=17),
            lambda rows: rows[-3]['rule']['expr'][1]['match'].update(right=0),
            lambda rows: rows[-3]['rule']['expr'][2]['match'].update(left={'ct': {'key': 'mark'}}),
            lambda rows: rows[-3]['rule']['expr'][2]['match'].update(op='=='),
            lambda rows: rows[-2]['chain'].update(prio=-200),
            lambda rows: rows[-2]['chain'].update(hook='input'),
            lambda rows: rows[-1]['rule']['expr'][0]['match'].update(right='eth0'),
            lambda rows: rows.append({'set': {'family': 'inet', 'table': 'mikka_review_v1', 'name': 'dynamic'}}),
            lambda rows: rows.append(deepcopy(rows[2])),
            lambda rows: rows.append(deepcopy(rows[-1])),
        )
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.filter.value = deepcopy(original)
                change(self.filter.value['nftables'])
                with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
                    guard.verify()
        self.assertEqual(len(self.filter.scripts), 1, 'verification must never repair a bad policy')

    def test_known_native_output_forms_keep_all_conditions_and_actual_provider_set(self):
        with patch.object(guard, 'provider_ports', return_value=[49983, 50005]):
            proof = guard.prepare()
        self.assertEqual(proof['providerPorts'], [49983, 50005])
        self.assertIn('meta skuid 0 tcp sport { 49983, 50005 } return', self.filter.scripts[0])
        rows = self.filter.value['nftables']
        rows[3]['rule']['expr'].insert(0, deepcopy(rows[-3]['rule']['expr'][0]))
        rows[1]['table']['flags'] = []
        self.assertEqual(guard.verify()['rulesVerified'], {'ipv4': True, 'ipv6': True})

    def assert_bad_ack_listing(self, original, change):
        self.filter.value = deepcopy(original)
        change(self.filter.value['nftables'])
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()
        self.assertEqual(len(self.filter.scripts), 1, 'verification must not repair or reinstall a weakened policy')

    def test_ack_readback_requires_all_22_distinct_ordered_header_cases(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        for row in range(4, 26):
            for kind in ('missing', 'duplicate', 'extra', 'misordered'):
                with self.subTest(row=row, mutation=kind):
                    def change(rows):
                        if kind == 'missing':
                            rows.pop(row)
                        elif kind == 'duplicate':
                            rows[row] = deepcopy(rows[4 if row != 4 else 5])
                        elif kind == 'extra':
                            rows.insert(row, deepcopy(rows[row]))
                        else:
                            rows[row], rows[26] = rows[26], rows[row]
                    self.assert_bad_ack_listing(original, change)

    def test_ack_readback_cannot_omit_any_safety_predicate_or_return(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        for row in range(4, 26):
            expr = original['nftables'][row]['rule']['expr']
            # The first two expressions are protocol dependencies which nft may
            # omit when IP/TCP payload fields already imply them. Every other
            # condition, including the verdict, is independently mandatory.
            for index in range(2, len(expr)):
                with self.subTest(row=row, expression=expr[index]):
                    self.assert_bad_ack_listing(original, lambda rows: rows[row]['rule']['expr'].pop(index))

    def test_ack_readback_rejects_non_exact_flags_and_persistent_flow_authority(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        for row in range(4, 26):
            changes = {
                'ack-bit-only': lambda expr: expr[4]['match'].update(
                    left={'&': [{'payload': {'protocol': 'tcp', 'field': 'flags'}}, 16]}),
                'synack': lambda expr: expr[4]['match'].update(right=18),
                'ack-ece': lambda expr: expr[4]['match'].update(right=80),
                'ack-inequality': lambda expr: expr[4]['match'].update(op='!='),
                'accept-verdict': lambda expr: expr.__setitem__(-1, {'accept': None}),
                'ct-mark-write': lambda expr: expr.insert(-1, {'mangle': {'key': {'ct': {'key': 'mark'}}, 'value': 1296781398}}),
                'skb-mark-write': lambda expr: expr.insert(-1, {'mangle': {'key': {'meta': {'key': 'mark'}}, 'value': 1296781398}}),
                'ct-state-instead-of-direction': lambda expr: expr[2]['match'].update(left={'ct': {'key': 'state'}}),
            }
            for label, change in changes.items():
                with self.subTest(row=row, mutation=label):
                    self.assert_bad_ack_listing(original, lambda rows: change(rows[row]['rule']['expr']))

    def test_ack_readback_lengths_are_exact_correlated_integers(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        for row in range(4, 26):
            expr = original['nftables'][row]['rule']['expr']
            for index, statement in enumerate(expr):
                match = statement.get('match', {})
                if type(match.get('right')) is not int:
                    continue
                for replacement in (match['right'] + 1, bool(match['right']), float(match['right']), str(match['right']),
                                    {'range': [match['right'], match['right'] + 1]}):
                    with self.subTest(row=row, field=match['left'], replacement=replacement):
                        self.assert_bad_ack_listing(original, lambda rows: rows[row]['rule']['expr'][index]['match'].update(right=replacement))
            family = 'ip' if row < 15 else 'ip6'
            length_fields = ({'meta': {'key': 'length'}}, {'payload': {'protocol': family, 'field': 'length'}})
            length_indexes = [index for index, statement in enumerate(expr)
                              if statement.get('match', {}).get('left') in length_fields]
            self.assertEqual(len(length_indexes), 2)
            for index in length_indexes:
                with self.subTest(row=row, weakened_length_index=index):
                    self.assert_bad_ack_listing(original, lambda rows: rows[row]['rule']['expr'][index]['match'].update(op='<='))
            with self.subTest(row=row, mutation='skb-length-replaced-by-ip-length'):
                meta_index = next(index for index in length_indexes if expr[index]['match']['left'] == length_fields[0])
                self.assert_bad_ack_listing(original, lambda rows: rows[row]['rule']['expr'][meta_index]['match'].update(
                    left=deepcopy(length_fields[1])))

    def test_ack_readback_rejects_fragments_extensions_and_unregistered_ports(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        for row in range(4, 26):
            changes = {
                'optional-port-was-not-present': lambda expr: expr[3]['match'].update(right={'set': [49983, 50005]}),
                'task-port-added': lambda expr: expr[3]['match'].update(right={'set': [49983, 3000]}),
                'source-port-range': lambda expr: expr[3]['match'].update(right={'range': [49983, 50005]}),
                'destination-port': lambda expr: expr[3]['match'].update(left={'payload': {'protocol': 'tcp', 'field': 'dport'}}),
                'original-direction': lambda expr: expr[2]['match'].update(right=0),
            }
            if row < 15:
                changes.update({
                    'first-fragment-allowed': lambda expr: expr[5]['match'].update(
                        left={'&': [{'payload': {'protocol': 'ip', 'field': 'frag-off'}}, 8191]}),
                    'offset-fragment-allowed': lambda expr: expr[5]['match'].update(
                        left={'&': [{'payload': {'protocol': 'ip', 'field': 'frag-off'}}, 8192]}),
                    'ipv4-options-allowed': lambda expr: expr[6]['match'].update(right={'range': [5, 15]}),
                })
            else:
                changes.update({
                    'fragment-header': lambda expr: expr[6]['match'].update(right=44),
                    'extension-header-ignored': lambda expr: expr[6]['match'].update(left={'meta': {'key': 'l4proto'}}),
                })
            for label, change in changes.items():
                with self.subTest(row=row, mutation=label):
                    self.assert_bad_ack_listing(original, lambda rows: change(rows[row]['rule']['expr']))

    def test_ack_readback_accepts_only_known_protocol_dependency_elision(self):
        guard.prepare()
        original = deepcopy(self.filter.value)
        for omitted in ((), (0,), (1,), (0, 1)):
            with self.subTest(omitted=omitted):
                self.filter.value = deepcopy(original)
                for row in self.filter.value['nftables'][4:26]:
                    row['rule']['expr'] = [statement for index, statement in enumerate(row['rule']['expr']) if index not in omitted]
                self.assertEqual(guard.verify()['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.assertEqual(len(self.filter.scripts), 1)

    def test_observed_nft_ipv6_header_order_keeps_every_safety_condition(self):
        guard.prepare()
        # Captured nft 1.0.9 readback: adjacent IPv6 payload loads are printed
        # in header order, with length before nexthdr. Dependencies are elided,
        # but nexthdr itself is present and must never be normalized away.
        observed = {'family': 'inet', 'table': 'mikka_review_v1', 'chain': 'guard', 'expr': [
            {'match': {'op': '==', 'left': {'ct': {'key': 'direction'}}, 'right': 1}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'sport'}}, 'right': 49983}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'flags'}}, 'right': 16}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'ip6', 'field': 'length'}}, 'right': 20}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'ip6', 'field': 'nexthdr'}}, 'right': 6}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'doff'}}, 'right': 5}},
            {'match': {'op': '==', 'left': {'meta': {'key': 'length'}}, 'right': 60}},
            {'return': None},
        ]}
        self.filter.value['nftables'][15]['rule'] = deepcopy(observed)
        self.assertEqual(guard.verify()['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.filter.value['nftables'][15]['rule']['expr'].pop(4)
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()

    def test_malformed_native_listing_never_grants_readiness_or_leaks_its_contents(self):
        guard.prepare()
        for value in (b'private-untrusted-output', b'{"nftables":[null]}', b'{"nftables":{},"private":true}'):
            self.filter.raw = value
            with self.assertRaises(guard.IngressError) as failed:
                guard.verify()
            self.assertEqual(guard.failure_receipt(failed.exception), {'ok': False, 'detail': 'rule_order'})

    def test_receipt_is_root_private_same_source_and_same_boot(self):
        guard.prepare()
        original = guard.RECEIPT.read_bytes()
        for update in ({'bootId': 'a' * 36}, {'sourceSha256': 'b' * 64}, {'preparedBeforeWorker': False},
                       {'installedTicks': guard.ticks() + 100000}, {'extra': True}):
            guard.RECEIPT.write_text(json.dumps(json.loads(original) | update))
            with self.assertRaisesRegex(guard.IngressError, 'receipt'):
                guard.verify()
        guard.RECEIPT.write_bytes(original)
        guard.RECEIPT.chmod(0o644)
        with self.assertRaisesRegex(guard.IngressError, 'receipt'):
            guard.verify()
        guard.RECEIPT.chmod(0o600)
        guard.RECEIPT.rename(guard.ROOT / 'real.json')
        guard.RECEIPT.symlink_to(guard.ROOT / 'real.json')
        with self.assertRaises(OSError):
            guard.verify()

    def test_unknown_backend_fails_before_changing_rules(self):
        with patch.object(guard.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'iptables v1.8.9 (legacy)')):
            with self.assertRaisesRegex(guard.IngressError, 'backend'):
                guard.prepare()
        self.assertFalse(guard.RECEIPT.exists())
        self.assertFalse(self.filter.calls)


class CommandDiagnostics(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mikka-command-diagnostic-')
        self.addCleanup(temporary.cleanup)
        self.program = Path(temporary.name) / 'fixture'
        self.private = 'synthetic-private-command-value'
        self.program.write_text(f'''#!{sys.executable}
import sys,time
mode=sys.argv[-1]
private={self.private!r}
if mode=='success':
    sys.stdout.write('safe-result')
elif mode=='failure':
    sys.stdout.write(private)
    sys.stderr.write(private+' Warning: Extension owner revision 1 not supported, missing kernel module? could not load match; operation not supported; permission denied; invalid argument')
    sys.exit(23)
elif mode=='oversized':
    sys.stderr.write(private*3000)
elif mode=='timeout':
    sys.stderr.write(private+' operation not permitted'); sys.stderr.flush(); time.sleep(30)
elif mode=='native':
    sys.stderr.write(private+'\\n'+sys.stdin.read()); sys.exit(4)
''')
        self.program.chmod(0o700)

    def test_real_child_failure_emits_only_closed_fields_and_six_independent_flags(self):
        with self.assertRaises(guard.IngressCommandError) as failed:
            guard.execute(str(self.program), ['failure'], family='ipv6', operation='provider_rule')
        value = guard.failure_receipt(failed.exception)
        command = value['command']
        self.assertEqual({key: command[key] for key in ('family', 'operation', 'failureKind', 'returnCode')},
                         {'family': 'ipv6', 'operation': 'provider_rule', 'failureKind': 'exit', 'returnCode': 23})
        flags = {'unsupportedRevision', 'missingKernelModule', 'missingExtension',
                 'operationNotSupported', 'permissionDenied', 'invalidArgument'}
        self.assertEqual(set(command), flags | {'family', 'operation', 'failureKind', 'returnCode', 'extension', 'revision', 'unsupportedExtensions'})
        self.assertEqual((command['extension'], command['revision']), ('owner', 1))
        self.assertEqual(command['unsupportedExtensions'], [{'extension': 'owner', 'revision': 1}])
        self.assertTrue(all(command[key] is True for key in flags))
        self.assertNotIn(self.private, json.dumps(value))
        self.assertNotIn(str(self.program), json.dumps(value))
        success = guard.execute(str(self.program), ['success'], family='ipv4', operation='list_output')
        self.assertEqual((success.returncode, success.stdout), (0, b'safe-result'))

    def test_real_oversized_timeout_and_execution_errors_remain_closed_and_fail(self):
        with self.assertRaises(guard.IngressCommandError) as failed:
            guard.execute(str(self.program), ['oversized'], family='ipv4', operation='list_chain')
        oversized = guard.failure_receipt(failed.exception)
        self.assertEqual((oversized['command']['failureKind'], oversized['command']['returnCode']), ('output_limit', 0))
        run = subprocess.run
        with patch.object(guard.subprocess, 'run', side_effect=lambda *args, **kwargs: run(*args, **{**kwargs, 'timeout': 0.05})):
            with self.assertRaises(guard.IngressCommandError) as failed:
                guard.execute(str(self.program), ['timeout'], family='ipv4', operation='new_chain')
        timed_out = guard.failure_receipt(failed.exception)
        self.assertIsInstance(failed.exception.__cause__, subprocess.TimeoutExpired)
        self.assertEqual((timed_out['command']['failureKind'], timed_out['command']['returnCode']), ('timeout', None))
        with self.assertRaises(guard.IngressCommandError) as failed:
            guard.execute(str(self.program.parent / self.private), [], family='ipv6', operation='new_chain')
        unavailable = guard.failure_receipt(failed.exception)
        self.assertIsInstance(failed.exception.__cause__, FileNotFoundError)
        self.assertEqual((unavailable['command']['failureKind'], unavailable['command']['returnCode']), ('execution', None))
        for value in (oversized, timed_out, unavailable):
            self.assertEqual(value['detail'], 'command')
            self.assertNotIn(self.private, json.dumps(value))
            self.assertNotIn(str(self.program.parent), json.dumps(value))

    def test_real_native_error_locations_map_only_fixed_stdin_lines_to_closed_operations(self):
        expected = ('create_table', 'new_chain', 'base_chain', *('provider_rule',) * 23, 'reply_rule', 'output_jump')
        for number, operation in enumerate(expected, 1):
            location = f'/dev/stdin:{number}:1-99: Error: Operation not supported; {self.private}\n'
            with self.assertRaises(guard.IngressCommandError) as failed:
                guard.execute(str(self.program), ['native'], family='inet', operation='install_policy', script=location.encode())
            command = guard.failure_receipt(failed.exception)['command']
            self.assertEqual((command['family'], command['operation'], command['returnCode']), ('inet', operation, 4))
            self.assertTrue(command['operationNotSupported'])
            self.assertNotIn(self.private, json.dumps(command))
            self.assertNotIn('stdin', json.dumps(command))
        for location in (f'/private/{self.private}:4:1: Error: Operation not supported\n',
                         'stdin:29:1: Error: Operation not supported\n',
                         'stdin:4:1: Error: a\nstdin:27:1: Error: b\n',
                         'prefix stdin:4:1: Error: Operation not supported\n'):
            with self.assertRaises(guard.IngressCommandError) as failed:
                guard.execute(str(self.program), ['native'], family='inet', operation='install_policy', script=location.encode())
            self.assertEqual(failed.exception.diagnostic['operation'], 'install_policy')
            self.assertNotIn(self.private, json.dumps(guard.failure_receipt(failed.exception)))

    def test_invalid_context_and_unbounded_returncodes_cannot_escape_the_closed_schema(self):
        for family, operation, kind in ((self.private, 'new_chain', 'exit'), ('ipv4', self.private, 'exit'),
                                        ('ipv4', 'new_chain', self.private)):
            with self.assertRaises(guard.IngressError) as failed:
                guard.IngressCommandError(family, operation, kind)
            self.assertEqual(guard.failure_receipt(failed.exception), {'ok': False, 'detail': 'runtime'})
        for code in (self.private, True, 256, -256):
            failure = guard.IngressCommandError('ipv4', 'new_chain', 'exit', code)
            self.assertIsNone(guard.failure_receipt(failure)['command']['returnCode'])
        for extension in ('owner', 'multiport', 'conntrack', 'mark', 'tcp'):
            stderr = f'Warning: Extension {extension} revision 255 not supported, missing kernel module?'.encode()
            value = guard.IngressCommandError('ipv4', 'provider_rule', 'exit', 4, stderr).diagnostic
            self.assertEqual((value['extension'], value['revision']), (extension, 255))
            self.assertEqual(value['unsupportedExtensions'], [{'extension': extension, 'revision': 255}])
        for warning, extension, revision in (
                (f'Extension {self.private} revision 1 not supported', 'unknown', None),
                ('Extension owner revision 256 not supported', 'owner', None),
                ('Extension owner revision -1 not supported', 'unknown', None),
                ('Extension owner revision 1 not supported; Extension owner revision 2 not supported', 'owner', None),
                ('Extension owner revision 1 not supported; Extension mark revision 1 not supported', 'unknown', None),
                ('Extension owner revision 0 not supported; Extension owner revision 0 not supported', 'owner', 0)):
            value = guard.IngressCommandError('ipv4', 'provider_rule', 'exit', 4, warning.encode()).diagnostic
            self.assertEqual((value['extension'], value['revision']), (extension, revision))
            self.assertNotIn(self.private, json.dumps(value))
        warnings = '; '.join(f'Warning: Extension owner revision {value} not supported' for value in range(8))
        warnings += '; Warning: Extension multiport revision 1 not supported; Warning: Extension owner revision 0 not supported'
        value = guard.IngressCommandError('ipv4', 'provider_rule', 'exit', 4, warnings.encode()).diagnostic
        self.assertEqual(value['unsupportedExtensions'], [{'extension': 'multiport', 'revision': 1}]
                         + [{'extension': 'owner', 'revision': revision} for revision in range(5)])


class ProviderAndWorkerProof(unittest.TestCase):
    def test_failed_cli_preserves_closed_stdout_protocol_and_builder_stderr(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('workspace-ingress.py')), 'invalid'],
                                capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'ok': False, 'detail': 'operation'})
        self.assertEqual(result.stderr, result.stdout)
        for failure in (OSError('/private/fixture secret'), guard.IngressError('/private/fixture secret')):
            self.assertEqual(guard.failure_detail(failure), 'runtime')
        self.assertEqual(guard.failure_detail(guard.IngressError('rule_order')), 'rule_order')

    def test_final_start_recreates_actual_control_files_before_worker_after_run_was_reset(self):
        repo = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(prefix='mikka-start-order-') as temporary:
            root = Path(temporary)
            runtime = root / 'opt'
            control = root / 'run/control'
            order = root / 'order'
            (runtime / 'runtime/ingress-v1').mkdir(parents=True)
            (runtime / 'runtime/node/bin').mkdir(parents=True)
            installer = runtime / 'worker/packages/daemon/scripts/workspace-control-install.py'
            installer.parent.mkdir(parents=True)
            control.parent.mkdir(parents=True)
            # Only the OS account and fixture paths change. Execute the real
            # install() implementation so chmod/ownership/marker errors cannot
            # be hidden by a fake successful installer process.
            installer.write_text(Path(__file__).with_name('workspace-control-install.py').read_text()
                .replace("Path('/run/mikka-review-control')", 'Path(' + repr(str(control)) + ')')
                .replace("pwd.getpwnam('user')", 'pwd.getpwuid(os.getuid())'))
            (runtime / 'runtime/ingress-v1/guard.py').write_text(
                'import pathlib,sys\nassert sys.argv[1:] == ["prepare"]\n'
                + 'assert not pathlib.Path(' + repr(str(control)) + ').exists()\n'
                + 'pathlib.Path(' + repr(str(order)) + ').write_text("guard\\n")\n')
            node = runtime / 'runtime/node/bin/node'
            node.write_text('#!' + sys.executable + '\nimport pathlib,stat,sys\n'
                + 'order=pathlib.Path(' + repr(str(order)) + ')\n'
                + 'root=pathlib.Path(' + repr(str(control)) + ')\n'
                + 'assert order.read_text()=="guard\\n"\n'
                + 'assert sys.argv[-1]=="--wait-bootstrap"\n'
                + 'assert (root/"version").read_text()=="1\\n"\n'
                + 'assert stat.S_IMODE(root.stat().st_mode)==0o710\n'
                + 'assert all((root/n).stat().st_uid==0 for n in ("version","machine.json","machine.lock"))\n'
                + 'assert all(stat.S_IMODE((root/n).stat().st_mode)==0o660 for n in ("machine.json","machine.lock"))\n'
                + 'order.write_text(order.read_text()+"control-before-worker\\n")\n')
            node.chmod(0o700)
            startup = (repo / 'scripts/e2b/start-prebuilt.sh').read_text()
            startup = startup.replace('/opt/mikka', str(runtime)).replace('/home/user/.mikka', str(root / 'home/.mikka'))
            startup = startup.replace('/run/mikka-viewer', str(root / 'run/viewer')).replace('exec runuser -u user -- env', 'exec env')
            start = root / 'start.sh'
            start.write_text(startup)
            result = subprocess.run(['bash', str(start)], capture_output=True, text=True, timeout=10, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(order.read_text(), 'guard\ncontrol-before-worker\n')

    def test_absent_optional_port_is_not_exempt_and_a_task_uid_cannot_claim_provider(self):
        def table(ports):
            return 'header\n' + '\n'.join(f'0: 00000000:{port:04X} 00000000:0000 0A 0 0 0 {uid} 0 1' for port, uid in ports)
        for ports, expected in [([(49983, 0)], [49983]), ([(49983, 0), (50005, 0)], [49983, 50005])]:
            with patch.object(Path, 'read_text', return_value=table(ports)):
                self.assertEqual(guard.provider_ports(), expected)
        for ports in ([], [(49983, 1000)], [(49983, 0), (50005, 1000)]):
            with patch.object(Path, 'read_text', return_value=table(ports)):
                with self.assertRaisesRegex(guard.IngressError, 'provider'):
                    guard.provider_ports()

    def test_readiness_proves_real_worker_process_started_after_guard(self):
        before = guard.ticks()
        # Some development executors place a child in a PID namespace while
        # mounting the parent's procfs. Ask its own procfs for the visible PID;
        # this still checks the actual process, not a fabricated stat record.
        child = subprocess.Popen([sys.executable, '-c', 'import os,time; print(os.readlink("/proc/self"),flush=True); time.sleep(30)',
                                  guard.WORKER, '--wait-bootstrap'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            pid = int(child.stdout.readline(32))
            with patch.object(guard.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())):
                with patch.object(guard, 'verify', return_value={'installedTicks': before}):
                    self.assertTrue(guard.ready(pid)['workerStartedAfterGuard'])
                with patch.object(guard, 'verify', return_value={'installedTicks': guard.ticks() + 100000}):
                    with self.assertRaisesRegex(guard.IngressError, 'worker_order'):
                        guard.ready(pid)
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
