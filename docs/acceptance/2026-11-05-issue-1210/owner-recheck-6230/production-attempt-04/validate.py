"""Recheck the captured, read-only observations. No network or database writes."""
import hashlib
import json
from pathlib import Path

here = Path(__file__).resolve().parent
data = json.loads((here / 'readonly-snapshot.json').read_text())['resultSets']
old = json.loads((here.parent / 'production-attempt-03/seven-reports-013910.json').read_text())['reports']
checks = []


def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})
    assert condition, name


task = data[2][0]
head = 'd05417e7848871e511141e10a282ffb7998b0a79'
base = '054e64ce6167427aecf937e6dc2410af677df32d'
target = 'mikka-question-recovery-cc-20261104-1237.txt'
expected = 'mikka-group-policy-v3\npath=claude-code\nstatus=ready\n'
sha = '05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6'
check('expected bytes and hash', len(expected.encode()) == 52 and hashlib.sha256(expected.encode()).hexdigest() == sha)
check('same candidate, epoch, baseline and delivery HEAD', task['candidateId'] == '2f338962-c690-4ba7-bc63-6c73a9de3acb' and task['sourceEventId'] == '4ad02e70-8015-5eac-87f4-a96fbd775d14' and task['deliverableHead'] == head and task['baselineHead'] == base)
check('approval pending, not Owner accepted', task['stage'] == 'approval' and task['status'] == 'pending' and task['revision'] == 29 and data[9][0]['acceptances'] == '0')
check('no active run or lease', data[9][0]['activeRuns'] == '0' and data[9][0]['activeLeases'] == '0')
check('sleeping parent preserved', data[8][0]['state'] == 'sleeping' and data[8][0]['sandboxId'] == 'ipa60du803guuiqnyzqan' and data[8][0]['lastActiveAt'] == '2026-11-05T14:48:42.215Z')
question = data[7][0]
check('old expired question and eight unconsumed fields preserved', question['status'] == 'expired' and question['revision'] == 3 and question['expiresAt'] == '2026-11-05T20:15:32.526Z' and all(question[k] is None for k in ['answerId', 'answerSource', 'answerSourceEventId', 'answerFingerprint', 'answeredAt', 'continuationRunId']) and question['answerNull'] and question['resultNull'])
current_reports = {r['runId']: r for r in data[4]}
for report in old:
    now = current_reports[report['runId']]
    check('unchanged historical report and fingerprint ' + report['runId'], report['report'] == now['report'] and report['reportFingerprint'] == now['reportFingerprint'])

for run in data[3][:2]:
    check('actual original native claim ' + run['stage'], run['attemptStatus'] == 'passed' and run['runStatus'] == 'succeeded' and run['stopReason'] == 'submitted' and run['harness'] == 'claude_code' and run['model'] == run['modelId'] == 'claude-haiku-5-5' and run['bindingId'] == '0e5edf2d-2653-475e-8693-b53ceafa7c11' and run['connectionId'] == '93b6ab23-900b-4e18-9ea0-baccf2d104ce' and run['connectionRevision'] == '2' and run['route'] == 'claude_code_cli' and run['apiClaim'] is False and run['observedModel'] is None and run['retryOf'] is None and run['continuesRunId'] is None and run['questionContinuation'] is None)
check('independent review and verify SID', data[3][0]['sessionId'] != data[3][1]['sessionId'])

for pair in data[5]:
    prefix = f"{pair['stage']} {pair['toolName']}"
    result = json.loads(pair['output'])
    check(prefix + ' paired output and fixed HEAD', pair['inputToolCallId'] == pair['outputToolCallId'] and pair['outputSeq'] > pair['inputSeq'] and pair['outputType'] == 'tool-output-available' and result['head'] == head)
    if pair['toolName'].endswith('inspect_artifact'):
        check(prefix + ' exact artifact bytes and committed content', pair['input'] == {'path': target, 'expectedUtf8': expected} and result['bytes'] == 52 and result['sha256'] == result['committedSha256'] == sha and result['contentMatchesGit'] is True and result['matchesExpectedUtf8'] is True and result['contentUtf8'] == expected and result['textUnavailable'] is None)
    else:
        check(prefix + ' only target file changed', result['comparison'] == {'baseCommit': base, 'head': head, 'changes': [{'status': 'A', 'path': target}], 'truncated': False} and result['status'] == {'dirty': False, 'porcelain': '', 'truncated': False})

prior = None
for prompt in data[6]:
    objects = [json.loads(line) for line in prompt['hostEvidencePrompt'].splitlines() if line.startswith('{')]
    lifecycle = next(o for o in objects if o.get('schemaVersion') == 2)
    native = lifecycle['question']['nativeQuestion']
    check(f"stage {prompt['position']} complete original summary and lifecycle", lifecycle['candidateId'] == task['candidateId'] and lifecycle['candidateSha'] == head and lifecycle['requestEpoch'] == task['sourceEventId'] and native['summaryStatus'] == 'complete' and len(native['summary']) == 560 and native['question'] == '是否把当前已检查的 52 字节文件作为本次交付，提交独立审阅？' and lifecycle['lifecycleComplete'] is True and lifecycle['lifecycleIncompleteReasons'] == [] and lifecycle['sourceToolActivity']['status'] == 'stopped' and lifecycle['sourceToolActivity']['stopReason'] == 'asked_human')
    check(f"stage {prompt['position']} continuation contains only ToolSearch and submit", lifecycle['producerToolActivity']['enumerationComplete'] is True and lifecycle['producerToolActivity']['incompleteReasons'] == [] and lifecycle['producerToolActivity']['unclassifiedTools'] == [] and [t['toolName'] for t in lifecycle['producerToolActivity']['tools']] == ['ToolSearch', 'mcp__mikka__submit'])
    inherited = next(o for o in objects if 'inheritedRecords' in o)
    check(f"stage {prompt['position']} receipt-bound three pre-question Bash records", inherited['inheritedRecordsOmitted'] is False and len(inherited['inheritedRecords']) == 3 and all(r['sourceRunId'] == lifecycle['resume']['sourceRunId'] and r['recoveryEventId'] == lifecycle['resume']['eventId'] and r['questionId'] == lifecycle['question']['id'] and r['answerId'] == lifecycle['answer']['id'] and r['requestEpoch'] == task['sourceEventId'] and r['candidateSha'] == head and r['sourceStatus'] == 'stopped' and r['sourceStopReason'] == 'asked_human' and r['seq'] < native['inputSeq'] and r['toolName'] == 'Bash' for r in inherited['inheritedRecords']))
    if prompt['position'] == 9:
        prior = next(o for o in objects if 'review' in o)
check('verify received complete same-candidate preceding review observations', prior['complete'] is True and prior['incompleteReasons'] == [] and prior['candidateId'] == task['candidateId'] and prior['candidateSha'] == head and prior['requestEpoch'] == task['sourceEventId'] and prior['review']['runId'] == data[3][0]['runId'] and prior['review']['sessionId'] == data[3][0]['sessionId'] and prior['review']['continuesRunId'] is None)
for record in prior['records']:
    actual = next(p for p in data[5] if p['outputChunkId'] == record['outputChunkId'])
    check('verify prior review IO equals persisted pair ' + record['outputChunkId'], record['input'] == actual['input'] and record['output'] == actual['output'] and record['inputChunkId'] == actual['inputChunkId'])
for run in data[3][:2]:
    report = current_reports[run['runId']]['report']
    check('six criteria passed in actual report ' + run['stage'], len(report['criteria']) == 6 and all(c['passed'] is True for c in report['criteria']) and report['reviewVerdict'] == 'passed')

result = {'source': 'Validation of the captured 10:42 UTC read-only transaction, not a new production execution.', 'checksPassed': len(checks), 'checks': checks, 'ownerAccepted': False, 'runtimeVmSamplingBoundary': 'This collection is after the two runs finished. It cannot establish verify VM state at a running instant.'}
(here / 'validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'checksPassed': len(checks), 'ownerAccepted': False}))
