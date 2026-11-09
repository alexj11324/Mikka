#!/usr/bin/env python3
"""Read-only independent verification of projected query diagnostics and windows."""
import hashlib
import json
import pathlib
import re
from collections import Counter, defaultdict
from datetime import datetime

root = pathlib.Path(__file__).resolve().parent
life_path = root / 'native-ae1504-original/lifecycle.json'
life = json.loads(life_path.read_text())
labels = json.loads((root / 'query-labels.json').read_text())
counts = life['queryCounts']
diagnostics = counts['rpcActions']['queryDiagnostics']
scope_keys = list(dict.fromkeys(labels['operations'] + labels['sources']))
routes = {value for value in scope_keys if value.startswith(('/api/', '/v1/'))}
methods = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'}
actions = {'desktop.session', 'desktop.bootstrap', 'desktop.readBatch', 'workspace.switchWorkspace',
           'execution-settings.getBotModelMenu', 'preferences.getPreferences', 'agents.listDevices',
           'bots.pollBots', 'issues.syncIssueList', 'projects.listProjects', 'teams.listTeams',
           'team-relations.listProjectTeams', 'task-runs.pollTaskRuns', 'task-runs.syncThreadList',
           'coordinator.pollBotChatSummaries', 'coordinator.syncCoordinatorChat'}
commands = {'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK'}
uuid = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
reason_keys = {'registry_unavailable', 'registry_invalid', 'context_ambiguous', 'context_invalid',
               'context_read_failed', 'context_missing', 'context_limit', 'statement_limit',
               'statement_missing', 'statement_size', 'statement_syntax', 'statement_proxy',
               'statement_read_failed', 'diagnostic_failed'}


def integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def valid_context(value):
    assert value['status'] == 'known'
    assert all(type(value[field]) is str and uuid.fullmatch(value[field]) for field in ('httpInvocationId', 'invocationId'))
    assert value['route'] in routes and value['method'] in methods
    assert value['rpcAction'] is None or value['rpcAction'] in actions
    assert value['invocationId'] == value['httpInvocationId'] or value['rpcAction'] is not None


def timestamp(value):
    assert type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value)
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


assert diagnostics['version'] == 1
assert diagnostics['columns'] == ['queryCalls', 'context', 'statement', 'scope']
assert diagnostics['scopeKeys'] == scope_keys
contexts, statements = diagnostics['contexts'], diagnostics['statements']
assert 1 <= len(contexts) <= 2048 and 1 <= len(statements) <= 512
assert contexts[0] == statements[0] == {'status': 'unknown'}
for value in contexts[1:]:
    assert set(value) == {'status', 'httpInvocationId', 'invocationId', 'route', 'method', 'rpcAction'}
    valid_context(value)
for value in statements[1:]:
    assert set(value) == {'status', 'normalizedStructureId', 'command', 'parameterCount'}
    assert value['status'] == 'known' and type(value['normalizedStructureId']) is str
    assert re.fullmatch(r'[a-f0-9]{12}', value['normalizedStructureId'])
    assert value['command'] in commands and integer(value['parameterCount']) and value['parameterCount'] <= 65535

capture = diagnostics['capture']
assert all(integer(capture[field]) for field in ('fromQueryCalls', 'toQueryCalls', 'droppedQueries'))
assert capture['toQueryCalls'] >= capture['fromQueryCalls']
assert set(capture['reasons']) <= reason_keys and all(integer(value) for value in capture['reasons'].values())
assert type(capture['overflow']) is bool
assert capture['overflow'] == bool(capture['droppedQueries'] or capture['reasons'].get('context_limit') or capture['reasons'].get('statement_limit'))

receipt = diagnostics['receipts']
invocations = receipt['invocations']
assert len(invocations) <= 4096
by_id = {}
for value in invocations:
    assert set(value) <= {'status', 'httpInvocationId', 'invocationId', 'route', 'method', 'rpcAction',
                          'startedAt', 'completedAt', 'httpStatus', 'rpcItemCount', 'conflict'}
    valid_context(value)
    assert value['invocationId'] not in by_id
    by_id[value['invocationId']] = value
    assert timestamp(value['startedAt']) <= timestamp(value['completedAt'])
    assert type(value['httpStatus']) is int and 100 <= value['httpStatus'] <= 599
    assert not value.get('conflict')
    if 'rpcItemCount' in value:
        assert integer(value['rpcItemCount']) and value['rpcItemCount'] <= 16
for value in invocations:
    if value['invocationId'] != value['httpInvocationId']:
        parent = by_id[value['httpInvocationId']]
        assert parent['route'] == value['route'] and parent['method'] == value['method']
        assert parent['rpcAction'] == 'desktop.readBatch'
        assert parent['startedAt'] <= value['startedAt'] <= value['completedAt'] <= parent['completedAt']
    elif value['rpcAction'] == 'desktop.readBatch':
        assert value['rpcItemCount'] == sum(child['httpInvocationId'] == value['invocationId'] and child['invocationId'] != child['httpInvocationId'] for child in invocations)
assert receipt['status'] == 'complete' and receipt['reasons'] == []
assert receipt['unmatchedQueryContexts'] == receipt['unpairedInvocations'] == receipt['conflictingInvocations'] == 0

windows = {}
all_ordinals = set()
used_contexts = set()
for name, window in diagnostics['windows'].items():
    original = counts['windows'][name]
    points = original['checkpoints']
    start, end = points[0]['snapshot']['queryCalls'], points[-1]['snapshot']['queryCalls']
    assert start == window['fromQueryCalls'] and end == window['toQueryCalls']
    assert capture['fromQueryCalls'] <= start <= end <= capture['toQueryCalls']
    for point in points:
        snap = point['snapshot']
        assert diagnostics['source'] == {key: snap[key] for key in ('pid', 'runtime', 'startedAt')}
    rows = window['queries']
    assert all(type(row) is list and len(row) == 4 and all(integer(n) for n in row) for row in rows)
    assert [row[0] for row in rows] == list(range(start + 1, end + 1))
    assert end - start == original['total']['queryCalls'] == window['expectedQueries'] == window['capturedQueries'] == len(rows)
    assert window['uncapturedQueries'] == 0
    operations = Counter({key: 0 for key in labels['operations']})
    sources = Counter({key: 0 for key in labels['sources']})
    unknown_context = Counter()
    unknown_statement = Counter()
    grouped = Counter()
    null_actions = late_actions = 0
    for ordinal, context, statement, scope in rows:
        assert ordinal not in all_ordinals
        all_ordinals.add(ordinal)
        assert context < len(contexts) and statement < len(statements) and scope < len(scope_keys)
        key = scope_keys[scope]
        assert key != 'unattributed'
        operation = key if key in labels['operations'] else 'unattributed'
        operations[operation] += 1
        if operation == 'unattributed': sources[key] += 1
        if not context:
            unknown_context[key] += 1
        else:
            used_contexts.add(context)
            c = contexts[context]
            r = by_id[c['invocationId']]
            assert all(r[field] == c[field] for field in ('httpInvocationId', 'invocationId', 'route', 'method'))
            assert c['rpcAction'] is None or c['rpcAction'] == r['rpcAction']
            if c['rpcAction'] is None:
                null_actions += 1
                if r['rpcAction'] is not None: late_actions += 1
        if not statement: unknown_statement[key] += 1
        grouped[(context, statement, scope)] += 1
    assert dict(operations) == original['total']['queryOperations']
    assert dict(sources) == original['total']['unattributedSources']
    assert sum(unknown_context.values()) == window['unknownContextQueries']
    assert sum(unknown_statement.values()) == window['unknownStatementQueries']
    reasons = (['query_context_unknown'] if unknown_context else []) + (['statement_structure_unknown'] if unknown_statement else [])
    assert window['reasons'] == reasons and window['status'] == ('incomplete' if reasons else 'complete')
    segments = []
    for i, segment in enumerate(window['segments']):
        left, right = points[i]['snapshot']['queryCalls'], points[i + 1]['snapshot']['queryCalls']
        assert segment == {'phase': points[i + 1]['phase'], 'fromQueryCalls': left, 'toQueryCalls': right}
        selected = [row for row in rows if left < row[0] <= right]
        assert len(selected) == right - left == original['segments'][i]['queryCalls']
        segments.append({**segment, 'queries': len(selected), 'unknownContextQueries': sum(row[1] == 0 for row in selected), 'unknownStatementQueries': sum(row[2] == 0 for row in selected)})
    windows[name] = {
        'capturedQueries': len(rows), 'uncapturedQueries': 0, 'operationAndSourceCountersReconciled': True,
        'reportedStatus': window['status'], 'reasons': reasons,
        'knownContextQueries': len(rows) - sum(unknown_context.values()),
        'unknownContextQueries': sum(unknown_context.values()), 'unknownContextByScope': dict(unknown_context),
        'unknownStatementQueries': sum(unknown_statement.values()), 'unknownStatementByScope': dict(unknown_statement),
        'capturedNullActionQueries': null_actions, 'nullActionQueriesWithLaterReceiptAction': late_actions,
        'segments': segments,
        'groups': [{'contextIndex': c, 'statementIndex': s, 'scope': scope_keys[k], 'queries': n} for (c, s, k), n in sorted(grouped.items())],
    }
assert len(all_ordinals) == sum(window['capturedQueries'] for window in windows.values())
assert diagnostics['status'] == ('complete' if not capture['overflow'] and all(w['reportedStatus'] == 'complete' for w in windows.values()) else 'incomplete')
report = {
    'schema': 'issue1512.native-query-diagnostics-independent.v1', 'revision': life['revision'],
    'sourceFile': str(life_path.relative_to(root)), 'sourceSha256': hashlib.sha256(life_path.read_bytes()).hexdigest(),
    'validation': 'passed_with_explicit_unknowns', 'reportedStatus': diagnostics['status'], 'source': diagnostics['source'],
    'capture': capture,
    'captureBoundary': 'Projected artifact contains all four measured-window query rows; outside-window query rows are not exported. Global capture range/reason counters are reported values, not independently reconstructed outside-window rows.',
    'contexts': len(contexts), 'statements': len(statements), 'measuredQueries': len(all_ordinals),
    'usedKnownContexts': len(used_contexts), 'receiptInvocations': len(invocations),
    'receiptStatus': 'complete', 'unpairedReceipts': 0, 'conflictingReceipts': 0, 'unmatchedUsedKnownContexts': 0,
    'allMeasuredOrdinalsPresentExactlyOnce': True, 'allFourOperationAndSourceCountersReconciled': True,
    'windows': windows,
    'interpretation': [
        'Unknown context and unknown SQL structure are independent dimensions; every query remains in the SQL budget.',
        'Captured null actions remain null; later receipt labels are never written back to query contexts.',
        'Only original SQL ordinals define windows. Invocation completion timestamps only validate receipt pairing, not SQL membership.',
        'Closed-source refinement includes background polling endpoints; it does not prove asynchronous execution. No scope label or unknown row is subtracted.',
        'Normalized structure equality proves neither equal parameters nor redundant work. Groups are diagnostics, not permission to remove reads.',
        'This result verifies recorded dimensions and their conservation; overall query diagnostics remain incomplete as reported.'
    ],
}
print(json.dumps(report, indent=2))
