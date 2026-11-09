"""Offline, source-bound reconciliation of the single completed run 42552094175.

Reads preserved artifacts and the nine already-completed PostHog responses.
Does not query a service, execute a model, or modify original evidence.
"""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import math
import re

BASE = Path(__file__).resolve().parents[1]
PUBLIC = BASE / 'public'
PRIVATE = BASE / 'private'
SOURCE = BASE.parent / 'controlled-failure-1d126-source'
PREPARED = BASE.parent / 'controlled-failure-readback-20261109'
REVISION = '1d1261b607c8d60a27e2131ef59b463156d346d1'


def signature(path):
    value = path.read_bytes()
    return {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}


def save(name, value):
    path = PUBLIC / name
    data = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
    # Only these derived outputs are replaced when replaying this offline check.
    path.write_bytes(data)
    return {'path': name, **signature(path)}


templates_path = PREPARED / 'controlled-failure-query-templates.safe.json'
templates = json.loads(templates_path.read_text())
receipt_path = PRIVATE / 'artifacts/extracted/controlled-failure.receipt.json'
overhead_path = PRIVATE / 'artifacts/extracted/overhead.receipt.json'
receipt = json.loads(receipt_path.read_text())
overhead = json.loads(overhead_path.read_text())
scope = json.loads((PUBLIC / 'readback-scope.safe.json').read_text())
verified_scope = {key: scope[key] for key in ('projectId', 'sourceRevision', 'environment', 'service', 'windowUTC', 'traceIds')}
assert receipt['kind'] == 'controlled_failure_otlp_probe'
assert receipt['sourceRevision'] == REVISION == scope['sourceRevision']
assert receipt['environment'] == scope['environment'] == 'dev'
assert receipt['backendObserved'] is False
assert receipt['attempted'] == receipt['failedResponses'] == 20
assert len(receipt['traceIds']) == len(set(receipt['traceIds'])) == 20
assert set(scope['traceIds']) == set(receipt['traceIds'])
assert all(receipt['checks'].values()) and receipt['cleanupComplete'] is True
assert 0 < receipt['initialUnsampled'] <= 20
source_receipt = json.loads((SOURCE / 'source-receipt.safe.json').read_text())
assert source_receipt['source'] == REVISION
for source in source_receipt['files']:
    assert signature(SOURCE / source['path']) == {'bytes': source['bytes'], 'sha256': source['sha256']}
for name, path in [('controlled-failure.receipt.json', receipt_path), ('overhead.receipt.json', overhead_path)]:
    target = PUBLIC / name
    if target.exists():
        assert target.read_bytes() == path.read_bytes()
    else:
        target.write_bytes(path.read_bytes())

BOOL = {'True': True, 'False': False, 'true': True, 'false': False, '1': True, '0': False}
PATTERNS = {
    'trace': r'[0-9a-f]{32}', 'span': r'[0-9a-f]{16}',
    'uuid': r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    'time': r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z',
    'statement': r'[0-9a-f]{12}', 'sha': r'[0-9a-f]{40}',
}


def cell(value, kind):
    nullable = kind.endswith('?')
    kind = kind.rstrip('?')
    if value == '(null)':
        assert nullable, f'Unexpected null for {kind}'
        return None
    if kind in ('bool', 'flag'):
        assert value in BOOL
        return BOOL[value]
    if kind == 'int':
        assert re.fullmatch(r'\d+', value)
        result = int(value)
        assert result <= 2**53 - 1
        return result
    if kind == 'number':
        result = float(value)
        assert math.isfinite(result)
        return result
    if kind == 'parent_span':
        assert value == '' or re.fullmatch(r'[0-9a-f]{16}', value)
        return value
    if kind in PATTERNS:
        assert re.fullmatch(PATTERNS[kind], value), f'Invalid {kind}'
        if kind in ('trace', 'span'):
            assert int(value, 16) != 0
        return value
    if kind in ('service', 'environment'):
        assert value == {'service': 'mikka-web', 'environment': 'dev'}[kind]
    elif kind == 'body':
        assert value in ('completed', 'failed', 'unexpected_body_redacted')
    else:
        assert kind in ('label', 'stage', 'causes')
        assert len(value) <= 256 and not re.search(r'[\x00-\x1f\x7f|]', value)
    return value


captures = []


def read_table(snapshot, name):
    path = PRIVATE / f'posthog/{snapshot}.{name}.original.json'
    envelope = json.loads(path.read_text())
    response = envelope['response']
    assert response.get('isError') is False
    blocks = response['content']
    assert len(blocks) == 1 and blocks[0]['type'] == 'text'
    parsed = json.loads(blocks[0]['text'])
    assert parsed['query']['query'] == envelope['request']['query']
    request_path = PUBLIC / f'requests/{name}.offset-0.request.json'
    assert json.loads(request_path.read_text()) == envelope['request']
    command = envelope['toolArgs']['command']
    assert command.startswith('call execute-sql ') and command.endswith(' --json')
    assert json.loads(command[len('call execute-sql '):-len(' --json')]) == envelope['request']
    assert envelope['request']['truncate'] is False
    for key in ('truncated', 'is_truncated', 'has_more'):
        assert parsed.get(key) not in (True, 1, 'true')
    raw = parsed['results']
    assert isinstance(raw, str) and raw == parsed['__formatted_results_override']
    kind = 'log_counts' if name == 'log_counts_canonical' else name
    definitions = [item.split(':', 1) for item in templates['queries'][kind]['columns']]
    lines = raw.splitlines()
    assert lines and lines[0].split('|') == [name for name, _ in definitions]
    rows = []
    for line in lines[1:]:
        values = line.split('|')
        assert len(values) == len(definitions)
        row = {name: cell(value, kind) for (name, kind), value in zip(definitions, values)}
        row['_rawBooleanFields'] = {name: value for (name, kind), value in zip(definitions, values) if kind.rstrip('?') in ('bool', 'flag')}
        rows.append(row)
    capture = {'snapshot': snapshot, 'name': name, 'requestedAt': envelope['requestedAt'],
        'path': str(path.relative_to(BASE)), **signature(path),
        'querySha256': hashlib.sha256(envelope['request']['query'].encode()).hexdigest(),
        'rawResultsSha256': hashlib.sha256(raw.encode()).hexdigest(), 'actualRows': len(rows),
        'queryEchoExact': True, 'formattedResultsExact': True,
        'explicitServerTruncationFlag': None,
        'enumeration': 'detail is below LIMIT 500 and agrees with independent exact-ID summary' if kind.endswith('_rows') else 'at most 20 fixed trace groups'}
    captures.append(capture)
    return rows, raw


names = ['span_counts', 'log_counts_canonical', 'span_rows', 'log_rows']
snapshots = {s: {n: read_table(s, n) for n in names} for s in ('s1', 's2')}
original_log_counts, _ = read_table('s1', 'log_counts')
assert all(row['error_log_rows'] == 0 for row in original_log_counts)
assert all(snapshots['s1'][name][1] == snapshots['s2'][name][1] for name in names)
span_counts, log_counts, spans, logs = [snapshots['s2'][name][0] for name in names]
assert len(span_counts) == len(log_counts) == 20
assert len(spans) < 500 and len(logs) < 500
expected = {item['traceId']: item for item in receipt['perTrace']}
assert len(expected) == 20 and set(expected) == set(receipt['traceIds'])
assert {row['trace_id_hex'] for row in spans} == {row['trace_id_hex'] for row in logs} == set(expected)
span_counts = {row['trace_id_hex']: row for row in span_counts}
log_counts = {row['trace_id_hex']: row for row in log_counts}
assert set(span_counts) == set(log_counts) == set(expected)
per_trace = []
for trace_id, item in sorted(expected.items()):
    ss = [row for row in spans if row['trace_id_hex'] == trace_id]
    ll = [row for row in logs if row['trace_id_hex'] == trace_id]
    roots = [row for row in ss if row['span_id_hex'] == item['rootSpanId']]
    pg = [row for row in ss if row['db_system'] == 'postgresql' and row['db_operation'] == 'SELECT']
    assert len(roots) == 1
    root = roots[0]
    sc, lc = span_counts[trace_id], log_counts[trace_id]
    expected_span_ids = {item['rootSpanId'], *item['pgSpanIds']}
    actual_error_ids = {row['span_id_hex'] for row in ss if row['status_code'] == 2}
    root_logs = [row for row in ll if row['span_id_hex'] == item['rootSpanId']]
    checks = {
        'exactLocalSpanSet': {row['span_id_hex'] for row in ss} == expected_span_ids,
        'spanPhysicalAndUniqueCounts': len(ss) == sc['span_rows'] == sc['span_row_uuids'] == sc['span_ids'] == len({row['span_row_uuid'] for row in ss}) == len(expected_span_ids),
        'oneActualRoot': sum(row['is_root_span'] for row in ss) == sc['root_rows'] == 1 and root['is_root_span'],
        'rootHttpFailure': root['stage'] == 'GET /api/trace-benchmark' and root['route'] == '/api/trace-benchmark' and root['method'] == 'GET' and root['http_status'] == 500 and root['status_code'] == 2,
        'ordinaryRoot': root['critical_raw'] is False,
        'safeRootCodeDetailCause': root['error_code'] == 'trace_acceptance_failed' and root['error_detail'] == 'controlled_database_failure' and '22012' in (root['error_causes'] or ''),
        'allSpansEffectiveRateOne': all(row['sample_rate'] == 1 and row['retention'] == 'error_or_slow' for row in ss),
        'exactPgChildren': len(pg) == len(item['pgSpanIds']) == 3 and {row['span_id_hex'] for row in pg} == set(item['pgSpanIds']) and all(row['parent_span_id_hex'] == item['rootSpanId'] for row in pg),
        'onePgError': sum(row['status_code'] == 2 for row in pg) == 1,
        'exactErrorSpanSet': actual_error_ids == set(item['errorSpanIds']) and len(actual_error_ids) == sc['error_span_rows'] == 2,
        'logPhysicalAndUniqueCounts': len(ll) == lc['log_rows'] == lc['log_uuids'] == lc['log_span_ids'] == len({row['log_uuid'] for row in ll}) == 2,
        'exactErrorLogSpanSet': {row['span_id_hex'] for row in ll} == actual_error_ids,
        'allLogsErrorAndSafe': all(row['severity_text'].lower() == 'error' and row['body_code'] == 'failed' and row['safe_body_shape'] for row in ll) and lc['error_log_rows'] == 2 and lc['unexpected_body_rows'] == 0,
        'allLogsEffectiveRateOne': all(row['sample_rate'] == 1 and row['retention'] == 'error_or_slow' for row in ll),
        'rootErrorLogLinked': len(root_logs) == 1 and root_logs[0]['error_code'] == root['error_code'] and root_logs[0]['error_detail'] == root['error_detail'] and root_logs[0]['error_causes'] == root['error_causes'],
        'exactServiceEnvironmentVersion': all(row['service'] == 'mikka-web' and row['environment'] == 'dev' and row['service_version'] == REVISION for row in [*ss, *ll]),
    }
    per_trace.append({'traceId': trace_id, 'rootSpanId': item['rootSpanId'], 'pgSpanIds': sorted(item['pgSpanIds']),
        'errorSpanIds': sorted(actual_error_ids), 'spanRowUuids': sorted(row['span_row_uuid'] for row in ss),
        'errorLogUuids': sorted(row['log_uuid'] for row in ll), 'root': root,
        'pgErrorMetadata': [{'spanId': row['span_id_hex'], 'errorCode': row['error_code'], 'errorType': row['error_type']} for row in pg if row['status_code'] == 2],
        'checks': checks, 'complete': all(checks.values())})

physical = {'spanRows': len(spans), 'spanUuids': len({row['span_row_uuid'] for row in spans}),
    'logicalTraceSpanPairs': len({(row['trace_id_hex'], row['span_id_hex']) for row in spans}),
    'logRows': len(logs), 'logUuids': len({row['log_uuid'] for row in logs}),
    'errorLogTraceSpanPairs': len({(row['trace_id_hex'], row['span_id_hex']) for row in logs})}
assert physical['spanRows'] == physical['spanUuids'] == physical['logicalTraceSpanPairs'] == receipt['localExportedSpans']
assert physical['logRows'] == physical['logUuids'] == physical['errorLogTraceSpanPairs'] == receipt['localExportedLogs']
assert all(item['complete'] for item in per_trace)
for kind in ('spans', 'logs'):
    transport = receipt['transport'][kind]
    assert transport['enabled'] is True and transport['batchesAttempted'] == transport['batchesSucceeded'] == 1
    assert all(transport[key] == 0 for key in ('batchesFailed', 'recordsFailed', 'exportThrows', 'flushFailures', 'shutdownFailures', 'batchesPending', 'recordsPending'))
    assert transport['recordsAttempted'] == transport['recordsSucceeded'] == physical['spanRows' if kind == 'spans' else 'logRows']

assert overhead['environment']['requests_per_condition'] == 600
assert overhead['environment']['queries_per_request'] == 3
for boundary in ('handler', 'round_trip'):
    for mode in ('off', 'on'):
        assert overhead[boundary][mode]['n'] == 600
        assert all(math.isfinite(overhead[boundary][mode][key]) and overhead[boundary][mode][key] >= 0 for key in ('mean_ms', 'p50_ms', 'p95_ms', 'p99_ms'))
for key in ('mean', 'p95'):
    actual = overhead['handler']['on'][key + '_ms'] - overhead['handler']['off'][key + '_ms']
    assert math.isclose(actual, overhead['handler']['delta_' + key + '_ms'], abs_tol=1e-12)
runner_source = (SOURCE / 'scripts/ops/run-trace-benchmark.ts').read_text()
assert "for (let i = 0; i < 100; i++) { await request('off', false); await request('on', false) }" in runner_source
assert 'const block = 20' in runner_source
assert "batch % 2 ? ['on', 'off'] as const : ['off', 'on'] as const" in runner_source
overhead_proof = {'sourceRevision': REVISION, 'receipt': signature(overhead_path), 'environment': overhead['environment'],
    'warmupPerCondition': 100, 'measuredPerCondition': 600, 'totalMeasuredRequests': 1200, 'queriesPerRequest': 3,
    'design': 'Sequential conditions in alternating 20-request blocks with alternating order; not a per-request randomized paired-statistics experiment.',
    'handler': overhead['handler'], 'roundTrip': {**overhead['round_trip'],
        'delta_mean_ms': overhead['round_trip']['on']['mean_ms'] - overhead['round_trip']['off']['mean_ms'],
        'delta_p95_ms': overhead['round_trip']['on']['p95_ms'] - overhead['round_trip']['off']['p95_ms']},
    'retention': overhead['retention'],
    'limits': ['Actual loopback HTTP and pg driver on this GitHub runner; async batched memory exporters.',
        'Excludes remote PostHog collector delivery, model/provider work and cloud provisioning.',
        'The memory-only overhead process has its own 20 local failures; it is not the separately exported set of 20 trace IDs.',
        'Only distribution summaries were emitted. No per-request samples, confidence interval or independent rerun are claimed.',
        'Exact 1d126 baseline, before later flush, returned-refusal and SQL changes. This is not validation of those later changes.']}
save('overhead-verification.safe.json', overhead_proof)
save('backend-normalized-rows.safe.json', {'scope': verified_scope, 'snapshot': 's2', 'spanRows': spans, 'logRows': logs,
    'rawBooleanValuesPreserved': True, 'rawNullMarker': '(null)', 'nullsRemainNull': True})
result = {'schemaVersion': 1, 'kind': 'controlled_failure_posthog_readback', 'verifiedAtUTC': datetime.now(timezone.utc).isoformat(),
    'status': 'passed_for_exact_source_controlled_dev_case', 'backendObserved': True,
    'overallIssue1512Acceptance': False, 'finalFixSourceAcceptance': False, 'productionModelCasePerformed': False,
    'scope': verified_scope, 'preparedScopeReceipt': 'readback-scope.safe.json', 'sourceRevision': REVISION,
    'sourceBoundary': 'Actual exact-1d126 OTLP and overhead baseline. This source does not contain the subsequent flush, returned-refusal or SQL fixes. A later candidate requires its own source-bound evidence.',
    'runnerReceipt': {'path': 'controlled-failure.receipt.json', **signature(receipt_path), 'backendObserved': False,
        'localRetainedRoots': receipt['localRetainedRoots'], 'localExportedSpans': receipt['localExportedSpans'],
        'localExportedLogs': receipt['localExportedLogs'], 'initialUnsampled': receipt['initialUnsampled'],
        'configuredSampleRate': receipt['configuredSampleRate'], 'transport': receipt['transport'], 'cleanupComplete': True},
    'captures': captures, 'posthogQueryCount': 9, 'snapshotsStable': True,
    'snapshotComparison': {name: {'rawResultsIdentical': True, 'sha256': hashlib.sha256(snapshots['s2'][name][1].encode()).hexdigest()} for name in names},
    'backend': {**physical, 'observedTraceIds': sorted(expected), 'completeFailureTraceIds': [item['traceId'] for item in per_trace],
        'missingTraceIds': [], 'physicalDuplicateSpans': 0, 'physicalDuplicateLogs': 0},
    'perTrace': per_trace, 'mismatches': [],
    'checks': {'exact20InputIds': True, 'sourceAndDevScopeMatched': True, 'completePageEnumeration': True,
        'summaryAndRowsAgree': True, 'runnerAndBackendSpanSetsAgree': True, 'allRootsErrorAndSafeCause': True,
        'allSpanEffectiveRatesAndRetention': True, 'allPgChildrenPresent': True, 'allRootErrorLogsLinked': True,
        'allPgErrorLogsLinked': True, 'observedLogCountMatchesLocalReceipt': True, 'twoStableSnapshots': True},
    'normalizationCorrection': 'The original uppercase ERROR summary is preserved. Actual backend severity_text is error; only the summary expression was changed to lower(severity_text)=error. APM True/False and log 1 booleans are normalized with raw spelling retained.',
    'limitations': ['This is a finite dev controlled-failure trace set in the authorized project, not a production coding/model run or complete issue acceptance.',
        'PG ERROR span code/type fields are null; PostgreSQL 22012 is preserved in each root and same-span root ERROR log cause chain. No missing PG attribute was invented.',
        'The tool provides formatted pipe tables without an explicit server truncation flag. Completeness is established here by below-limit details, independent summaries, the actual finite local span-ID set and two identical snapshots.',
        'Raw OTLP callback counts are batches/items, not HTTP wire-attempt or billing counts.',
        'No additional run, model, configuration mutation or query retry was triggered.']}
save('controlled-failure-reconciliation.safe.json', result)
print(json.dumps({'backendObserved': result['backendObserved'], 'completeTraces': len(per_trace), 'counts': physical,
    'initialUnsampled': receipt['initialUnsampled'], 'effectiveRate': 1, 'stableSnapshots': True,
    'handlerDeltaMeanMs': overhead['handler']['delta_mean_ms'], 'handlerDeltaP95Ms': overhead['handler']['delta_p95_ms'],
    'sourceRevision': REVISION, 'finalFixSourceAcceptance': False}, indent=2))
