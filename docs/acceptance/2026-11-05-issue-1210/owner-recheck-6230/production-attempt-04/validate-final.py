"""Compare post-acceptance observations with the captured preflight; no I/O outside evidence files."""
import json
from pathlib import Path

p = Path(__file__).resolve().parent
before = json.loads((p/'readonly-snapshot.json').read_text())['resultSets']
after = json.loads((p/'final-readonly-snapshot.json').read_text())['resultSets']
checks = []


def check(name, condition):
    assert condition, name
    checks.append({'name': name, 'passed': True})


def no_time(record):
    return {k: v for k, v in record.items() if k != 'queriedAt'}


check('task approval/passed r30', after[2][0]['stage'] == 'approval' and after[2][0]['status'] == 'passed' and after[2][0]['revision'] == 30)
for key in ['id','issueId','sourceEventId','botId','candidateId','kind','sha','producerRunId','deliverableHead','baselineHead']:
    check('unchanged task '+key, before[2][0][key] == after[2][0][key])
for record in before[4]:
    other = next(r for r in after[4] if r['runId'] == record['runId'])
    check('unchanged full report/fingerprint '+record['runId'], no_time(record) == no_time(other))
check('old expired question unconsumed fields preserved', no_time(before[7][0]) == no_time(after[7][0]))
check('sleeping parent and lastActiveAt preserved', no_time(before[8][0]) == no_time(after[8][0]))
check('single acceptance; no active run/lease', after[9][0]['acceptances'] == '1' and after[9][0]['activeRuns'] == after[9][0]['activeLeases'] == '0')
response = json.loads((p/'owner-acceptance-response.json').read_text())
check('HTTP200 accepted', response['status'] == 200 and response['body']['status'] == 'accepted')
check('single original Owner receipt matches actual API response', len(after[10]) == 1 and after[10][0]['acceptanceId'] == response['body']['acceptanceId'] == '981bee43-e495-4131-9643-5dbecf3ebd46' and after[10][0]['eventId'] == response['request']['input']['eventId'] and after[10][0]['candidateId'] == before[2][0]['candidateId'] and after[10][0]['originalOwner'] is True and after[10][0]['sessionRecorded'] is True)
check('associated issue done', after[11][0]['status'] == 'done')
check('own session signed out', json.loads((p/'owner-session-cleanup.json').read_text())['signOutStatus'] == 200)
for position in [8,9]:
    prior = next(r for r in before[3] if r['position'] == position)
    current = next(r for r in after[3] if r['position'] == position)
    check('native claim unchanged '+str(position), all(prior[k] == current[k] for k in ['runId','runStatus','stopReason','sessionId','startedAt','finishedAt','retryOf','continuesRunId','questionContinuation','harness','model','bindingId','connectionId','connectionRevision','route','modelId','apiClaim','observedModel']))
result = {'checksPassed': len(checks), 'checks': checks, 'ownerAccepted': True, 'transport': 'Normal authenticated application API; no UI click claimed'}
(p/'final-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'checksPassed': len(checks), 'ownerAccepted': True}))
