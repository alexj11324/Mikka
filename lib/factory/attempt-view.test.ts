import assert from 'node:assert/strict';
import test from 'node:test';
import { factoryAttemptTitle, projectFactoryAttempts, type FactoryAttemptViewSource } from './attempt-view';

const attempt = (id: string, position: number, stage: FactoryAttemptViewSource['stage'] = 'execute', extra: Partial<FactoryAttemptViewSource> = {}): FactoryAttemptViewSource =>
  ({ id, position, stage, runId: `run-${id}`, reason: 'Fallback', requestEpoch: 'request-one', ...extra });

test('attempt titles prefer the first nonempty completion line and mask before truncation', () => {
  assert.equal(factoryAttemptTitle('\n\n# Updated the parser\nFull report follows', 'other'), 'Updated the parser');
  assert.equal(factoryAttemptTitle(null, 'Reviewed the exact diff\nRemaining findings'), 'Reviewed the exact diff');
  assert.equal(factoryAttemptTitle(' \n ', undefined, 'Waiting for the machine'), 'Waiting for the machine');
  assert.equal(factoryAttemptTitle(null, '', undefined), null);
  const line = factoryAttemptTitle(`Added API_TOKEN=${'s'.repeat(300)}\nsecond line`)!;
  assert.equal(line, 'Added API_TOKEN=[REDACTED]');
  assert.doesNotMatch(line, /ssss/);
  assert.equal([...factoryAttemptTitle('界'.repeat(300))!].length, 200);
  assert.equal(factoryAttemptTitle('A\u0000\tB'), 'A B');
});

test('one canonical stage projection keeps spec and real review roles distinct', () => {
  const views = projectFactoryAttempts([
    attempt('planner', 1, 'spec'), attempt('implementation', 2), attempt('reviewer', 3, 'review'),
    attempt('verifier', 4, 'verify'), attempt('handoff', 5, 'approval', { runId: null }),
  ]);
  assert.deepEqual([...views].map(([id, view]) => [id, view.stage, view.role]), [
    ['planner', 'spec', 'plan'], ['implementation', 'implement', 'implement'], ['reviewer', 'review', 'review'],
    ['verifier', 'implement', 'review'], ['handoff', 'handoff', null],
  ]);
});

test('repair receipts distinguish fixes, provider retries and a new owner epoch', () => {
  const attempts = [attempt('first', 1), attempt('infra', 2), attempt('review', 3, 'review'),
    attempt('fix', 4), attempt('fix-infra', 5), attempt('new-request', 6, 'execute', { requestEpoch: 'request-two' }),
    attempt('missing-receipt', 7, 'execute', { requestEpoch: 'request-two' })];
  const views = projectFactoryAttempts(attempts.reverse(), [
    { attemptId: 'infra', action: 'adopt_retry' }, { attemptId: 'review', action: 'advance' },
    { attemptId: 'fix', action: 'repair' }, { attemptId: 'fix-infra', action: 'adopt_retry' },
    { attemptId: 'new-request', kind: 'request_epoch' },
    { attemptId: 'missing-receipt', action: 'finish' },
  ]);
  assert.equal(views.get('infra')?.role, 'implement');
  assert.equal(views.get('infra')?.revisionOf, null);
  assert.equal(views.get('fix')?.role, 'fix');
  assert.equal(views.get('fix')?.revisionOf, 'infra');
  assert.equal(views.get('fix-infra')?.role, 'fix');
  assert.equal(views.get('fix-infra')?.revisionOf, 'infra');
  assert.equal(views.get('new-request')?.role, 'implement');
  assert.equal(views.get('new-request')?.revisionOf, null);
  assert.equal(views.get('missing-receipt')?.role, 'implement', 'ordinal/history alone never claims a fix');
});

test('failed-execution repairs and ordinary retries keep their actual ancestry', () => {
  const views = projectFactoryAttempts([
    attempt('failed', 1, 'execute', { reasonCode: 'run_failed' }), attempt('repair', 2),
    attempt('retry', 3), attempt('new', 4, 'execute', { requestEpoch: 'next' }),
  ], [{ attemptId: 'repair', action: 'retry' }, { attemptId: 'retry', action: 'retry' },
    { attemptId: 'new', action: 'repair' }]);
  assert.equal(views.get('repair')?.role, 'fix');
  assert.equal(views.get('repair')?.revisionOf, 'failed');
  assert.equal(views.get('retry')?.role, 'fix');
  assert.equal(views.get('retry')?.revisionOf, 'failed');
  assert.equal(views.get('new')?.role, 'implement', 'a receipt never crosses request epochs');
  const truncated = projectFactoryAttempts([attempt('later', 5)], [{ attemptId: 'later', action: 'repair', previousAttemptId: 'not-read' }]);
  assert.equal(truncated.get('later')?.role, 'implement', 'missing predecessors are not invented');
});
