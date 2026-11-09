import contextlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import guest_observer as observer


FSID = struct.pack('<ii', 0x12345678, 0x23456789)
DIRECTORY = (FSID, 1, b'dir1')
CHILD = (FSID, 1, b'file')


def info(kind, payload, pad=0):
    return struct.pack('<BBH', kind, pad, len(payload) + 4) + payload


def fid(kind, name=None, key=DIRECTORY):
    fsid, handle_type, handle = key
    raw = fsid + struct.pack('<Ii', len(handle), handle_type) + handle
    if name is not None:
        raw += name + b'\0'
    raw += b'\0' * (-len(raw) % 4)
    return info(kind, raw)


def pidfd(value=102):
    return info(4, struct.pack('<i', value))


def event(records=b'', mask=2, pid=81, fd=-1):
    # Independent literal Linux amd64 metadata layout, not the parser's Struct.
    return struct.pack('<IBBHQii', 24 + len(records), 3, 0, 24, mask, fd, pid) + records


def changed(raw, offset, value):
    return raw[:offset] + value + raw[offset + len(value):]


def context():
    return {'activated': True, 'sourceCommit': observer.SOURCE, 'runId': '123', 'attempt': 1,
            'instanceNonce': '1' * 32, 'segmentNonce': '2' * 32, 'notBeforeUnix': 1000, 'deadlineUnix': 1600}


class Parser(unittest.TestCase):
    def test_independent_24_byte_header_and_arbitrary_info_order(self):
        self.assertEqual(observer.META.size, 24)
        records = [fid(2, observer.TARGET), fid(1, key=CHILD), pidfd()]
        parsed = []
        for order in (records, list(reversed(records)), [records[2], records[0], records[1]]):
            rows, fds = observer.parse_events(event(b''.join(order)))
            self.assertEqual(fds, (102,))
            self.assertEqual(rows[0]['pidfd'], 102)
            parsed.append(observer.project_event(rows[0], DIRECTORY))
        self.assertEqual(parsed[0], parsed[1])
        self.assertEqual(parsed[1], parsed[2])
        self.assertEqual(parsed[0]['operations'], ['modify'])
        self.assertEqual(parsed[0]['initialDataWriter'], 'unknown')

    def test_staging_to_dot_zero_records_only_directory_entry_actor(self):
        packet = event(fid(12, observer.TARGET) + pidfd() + fid(10, observer.STAGING) + fid(1, key=CHILD), mask=0x10000000)
        rows, _ = observer.parse_events(packet)
        result = observer.project_event(rows[0], DIRECTORY)
        self.assertEqual(result['actorRole'], 'directory_entry_actor_at_read')
        self.assertEqual(result['initialDataWriter'], 'unknown')
        self.assertEqual({x['role']: x['nameClass'] for x in result['entries']}, {'old': 'staging', 'new': 'target'})
        self.assertEqual(result['pathSnapshotRelation'], 'later_path_read_not_bound_to_event_object')

    def test_moved_to_and_close_write_have_distinct_roles(self):
        for mask, role in [(0x80, 'directory_entry_actor_at_read'), (0x8, 'content_event_actor_at_read')]:
            with self.subTest(mask=mask):
                rows, _ = observer.parse_events(event(fid(2, observer.TARGET) + pidfd(), mask=mask))
                self.assertEqual(observer.project_event(rows[0], DIRECTORY)['actorRole'], role)

    def test_same_basename_in_other_directory_is_not_target(self):
        other = (FSID, 1, b'else')
        rows, _ = observer.parse_events(event(fid(2, observer.TARGET, other) + pidfd()))
        self.assertIsNone(observer.project_event(rows[0], DIRECTORY))

    def test_nontarget_fds_are_still_owned_and_closed(self):
        rows, fds = observer.parse_events(event(fid(2, b'unrelated-secret-name') + pidfd(103), fd=104))
        self.assertIsNone(observer.project_event(rows[0], DIRECTORY))
        closed = []
        observer.release_fds(fds, closed.append)
        self.assertEqual(closed, [103, 104])

    def test_overflow_without_name_is_not_filtered_out(self):
        rows, fds = observer.parse_events(event(mask=0x4000, pid=-1))
        self.assertEqual(fds, ())
        self.assertEqual(observer.project_event(rows[0], DIRECTORY), {'type': 'gap', 'reason': 'queue_overflow'})

    def test_unknown_mask_is_incomplete_not_positive_evidence(self):
        rows, _ = observer.parse_events(event(fid(2, observer.TARGET), mask=0x10000))
        self.assertEqual(observer.project_event(rows[0], DIRECTORY)['type'], 'gap')

    def test_every_short_metadata_header_is_rejected(self):
        packet = event()
        for length in range(24):
            with self.subTest(length=length), self.assertRaises(observer.ParseError):
                observer.parse_events(packet[:length])

    def test_bad_event_lengths_version_reserved_and_metadata_length(self):
        packet = event(fid(2, observer.TARGET) + pidfd())
        bad = [changed(packet, 0, struct.pack('<I', n)) for n in (0, 23, len(packet) + 1, 65537)]
        bad += [changed(packet, 4, b'\x02'), changed(packet, 5, b'\x01')]
        bad += [changed(packet, 6, struct.pack('<H', n)) for n in (0, 23, 25, 65535)]
        for n, raw in enumerate(bad):
            with self.subTest(case=n), self.assertRaises(observer.ParseError):
                observer.parse_events(raw)

    def test_short_or_overrunning_info_and_duplicate_pidfd(self):
        records = [b'\x04', struct.pack('<BBH', 4, 0, 0), struct.pack('<BBH', 4, 0, 3),
                   struct.pack('<BBH', 4, 0, 20) + b'\0' * 4, pidfd() + pidfd(), info(4, b'\0' * 3)]
        for n, raw in enumerate(records):
            with self.subTest(case=n), self.assertRaises(observer.ParseError):
                observer.parse_events(event(raw))

    def test_handles_names_and_padding_are_bounded(self):
        prefix = FSID + struct.pack('<Ii', 4, 1)
        payloads = [FSID + struct.pack('<Ii', count, 1) + b'abcd\0' for count in (0, 129, 40)]
        payloads += [prefix + b'abcd' + observer.TARGET,
                     prefix + b'abcd' + b'x' * 256 + b'\0',
                     prefix + b'abcd' + b'../apt.extended_states.0\0',
                     prefix + b'abcd' + b'a\0not-padding',
                     b'\0' * 15]
        for n, payload in enumerate(payloads):
            with self.subTest(case=n), self.assertRaises(observer.ParseError):
                observer.parse_events(event(info(2, payload)))
        with self.assertRaises(observer.ParseError):
            observer.parse_events(event(info(4, struct.pack('<i', 102), pad=1)))

    def test_unknown_record_and_parse_error_retain_known_fd_ownership(self):
        with self.assertRaises(observer.ParseError) as caught:
            observer.parse_events(event(pidfd(105) + info(99, b'unknown'), fd=106))
        self.assertEqual(caught.exception.code, 'unknown_info_record')
        closed = []
        observer.release_fds(caught.exception.fds, closed.append)
        self.assertEqual(closed, [105, 106])

    def test_multiple_records_and_event_count_cap(self):
        rows, fds = observer.parse_events(event(pidfd(107)) + event(pidfd(108)))
        self.assertEqual(len(rows), 2)
        self.assertEqual(fds, (107, 108))
        with self.assertRaises(observer.ParseError):
            observer.parse_events(event() * 513)
        with self.assertRaises(observer.ParseError):
            observer.parse_events(b'\0' * 65537)

    def test_negative_pidfd_is_never_closed(self):
        for value in (-1, -2):
            rows, fds = observer.parse_events(event(pidfd(value)))
            self.assertEqual(rows[0]['pidfd'], value)
            self.assertEqual(fds, ())
        closed = []
        observer.release_fds([-2, -1, None, 0, 0, 4], closed.append)
        self.assertEqual(closed, [0, 4])


class FakeProc:
    def __init__(self, alive=(True, True), pid=(81, 81), start=(100, 100), error=False):
        self.alives, self.pids, self.starts = iter(alive), iter(pid), iter(start)
        self.calls, self.error = [], error

    def alive(self, fd):
        self.calls.append('alive'); return next(self.alives)

    def pid(self, fd):
        self.calls.append('pid'); return next(self.pids)

    def start(self, pid):
        self.calls.append('start'); return next(self.starts)

    def exe(self, pid):
        self.calls.append('exe')
        if self.error:
            raise PermissionError('must not export this message')
        return {'knownPath': '/usr/bin/cp', 'pathSha256': 'a' * 64, 'pathBytes': 11, 'device': 1, 'inode': 2, 'size': 3}


class IdentityAndBounds(unittest.TestCase):
    def test_valid_pidfd_identifies_only_executable_at_read(self):
        result = observer.identify_actor({'pid': 81, 'pidfd': 102}, FakeProc())
        self.assertEqual(result['status'], 'stable_process_at_read')
        self.assertEqual(result['exeAtRead']['knownPath'], '/usr/bin/cp')
        self.assertEqual(result['exeAtEvent'], 'unknown')

    def test_missing_or_negative_identity_never_reads_proc(self):
        for pid, fd in [(81, None), (81, -1), (81, -2), (0, 102), (-1, 102)]:
            access = FakeProc()
            with self.subTest(pid=pid, fd=fd):
                self.assertEqual(observer.identify_actor({'pid': pid, 'pidfd': fd}, access)['status'], 'unknown')
                self.assertEqual(access.calls, [])

    def test_exited_or_recycled_pid_cannot_supply_an_executable(self):
        cases = [FakeProc(alive=(False,)), FakeProc(pid=(999,)), FakeProc(start=(100, 200)),
                 FakeProc(alive=(True, False)), FakeProc(pid=(81, 999)), FakeProc(error=True)]
        for n, access in enumerate(cases):
            with self.subTest(case=n):
                result = observer.identify_actor({'pid': 81, 'pidfd': 102}, access)
                self.assertEqual(result['status'], 'unknown')
                self.assertIsNone(result['exeAtRead'])
                self.assertNotIn('must not export', json.dumps(result))
        self.assertNotIn('exe', cases[0].calls)
        self.assertNotIn('exe', cases[1].calls)

    def test_context_must_be_bound_fresh_and_closed(self):
        ctx = context()
        self.assertIs(observer.validate_context(ctx, 1200), ctx)
        cases = [None, {}, {**ctx, 'activated': False}, {**ctx, 'extra': 1},
                 {**ctx, 'sourceCommit': '0' * 40}, {**ctx, 'deadlineUnix': 2000},
                 {**ctx, 'instanceNonce': '../else'}, {**ctx, 'attempt': True},
                 {**ctx, 'deadlineUnix': 1200}, {**ctx, 'notBeforeUnix': 1300}]
        for n, bad in enumerate(cases):
            with self.subTest(case=n), self.assertRaises(ValueError):
                observer.validate_context(bad, 1200)

    def test_ack_requires_fresh_challenge_and_same_boot_and_instance(self):
        ctx = context()
        request = {'action': 'checkpoint', 'phase': 'before_strict', 'instanceNonce': ctx['instanceNonce'],
                   'segmentNonce': ctx['segmentNonce'], 'challenge': '3' * 32}
        ack = {'version': 1, 'type': 'ack', 'challenge': request['challenge'], 'context': ctx,
               'bootId': 'boot1', 'observerNonce': '4' * 32, 'phase': request['phase'],
               'sequence': 1, 'markActive': True, 'coverage': 'bounded_segment_notifications'}
        self.assertTrue(observer.request_valid(request, ctx))
        self.assertTrue(observer.ack_valid(ack, ctx, request, 'boot1'))
        for field, value in [('challenge', '5' * 32), ('bootId', 'boot2'), ('context', {**ctx, 'instanceNonce': '6' * 32}),
                             ('markActive', False), ('sequence', 0), ('sequence', True), ('version', True),
                             ('observerNonce', 'old-receipt'), ('coverage', 'complete'), ('phase', 'fresh')]:
            with self.subTest(field=field, value=value):
                self.assertFalse(observer.ack_valid({**ack, field: value}, ctx, request, 'boot1'))
        self.assertFalse(observer.ack_valid({**ack, 'extra': 1}, ctx, request, 'boot1'))
        self.assertFalse(observer.request_valid({**request, 'action': 'run_command'}, ctx))
        self.assertFalse(observer.request_valid({**request, 'phase': '/etc/passwd'}, ctx))

    def test_journal_limit_reserves_terminal_space_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'events.jsonl'
            with patch.multiple(observer, MAX_OUTPUT=2048, TERMINAL_RESERVE=512, MAX_RECORD=512):
                journal = observer.Journal(path, {'version': 1})
                try:
                    with self.assertRaises(FileExistsError):
                        observer.Journal(path, {'version': 1})
                    count = 0
                    while journal.write({'type': 'event', 'fixed': 'x' * 200}):
                        count += 1
                    self.assertGreater(count, 0)
                    self.assertTrue(journal.write({'type': 'terminal', 'coverage': 'incomplete'}, terminal=True))
                    self.assertFalse(journal.write({'oversize': 'x' * 1000}, terminal=True))
                    self.assertLessEqual(path.stat().st_size, 2048)
                finally:
                    observer.os.close(journal.fd)

    def test_default_entry_is_disabled_before_any_runtime_operation(self):
        with patch.object(observer, 'BOUND_CONTEXT', None), patch.object(observer, 'run_bound') as run, \
             patch.object(observer, 'open_notification_group') as kernel, \
             patch.object(observer, 'snapshot') as snapshot, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(observer.main(), 2)
            run.assert_not_called(); kernel.assert_not_called(); snapshot.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {'status': 'disabled', 'reason': 'unbound_review_only'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
