import assert from 'node:assert/strict';
import test from 'node:test';
import { FACTORY_CLOUD_DISPATCH_AVAILABLE, createFactoryDispatchRecovery, factoryDeviceOnline, factoryDispatchClarification, factoryDispatchFailureReason } from './dispatch-recovery';
import { handleFactoryDispatchRecovery } from './dispatch-recovery-http';

const now = Date.parse('2026-10-30T07:00:00Z');
const device = (over: Partial<{ enabled: boolean; lastSeenAt: Date | null; harnesses: unknown }> = {}) =>
  ({ id: 'd', name: 'Mac', enabled: true, lastSeenAt: new Date(now - 1_000), harnesses: [{ harness: 'codex', installed: true }], ...over });

test('online uses the 60s device window and the enabled switch', () => {
  assert.equal(factoryDeviceOnline(device(), now), true);
  assert.equal(factoryDeviceOnline(device({ lastSeenAt: new Date(now - 61_000) }), now), false);
  assert.equal(factoryDeviceOnline(device({ lastSeenAt: null }), now), false);
  assert.equal(factoryDeviceOnline(device({ enabled: false }), now), false);
});

test('reason codes: disabled before offline before harness', () => {
  assert.equal(factoryDispatchFailureReason(device(), 'codex', now), null);
  assert.equal(factoryDispatchFailureReason(device({ enabled: false, lastSeenAt: null }), 'codex', now), 'deviceDisabled');
  assert.equal(factoryDispatchFailureReason(device({ lastSeenAt: new Date(now - 120_000) }), 'codex', now), 'deviceOffline');
  assert.equal(factoryDispatchFailureReason(device(), 'claude_code', now), 'harnessUnavailable');
  assert.equal(factoryDispatchFailureReason(device({ harnesses: [{ harness: 'codex', installed: false }] }), 'codex', now), 'harnessUnavailable');
});

test('clarification follows #453 BeQuestions limits; cloud links to key settings only without a key', () => {
  const task = '11111111-1111-4111-8111-111111111111';
  const without = factoryDispatchClarification(task, 'r', 'deviceOffline', false);
  assert.deepEqual(without.options.map(o => o.value), ['wait', 'cloud']);
  assert.equal(without.options[1].action, 'cloudKeySettings');
  assert.equal(without.task, task);
  assert.equal(without.multiple, false);
  for (const o of without.options) { assert.ok(o.value.length <= 80 && o.label.length >= 1 && o.label.length <= 200 && o.description.length <= 300); }
  assert.equal('action' in factoryDispatchClarification(task, 'r', 'deviceOffline', true).options[1], false);
});

test('http: auth, uuid and e2bKeyNotConfigured', async () => {
  const calls: string[] = [];
  const recovery = {
    status: async () => null,
    deviceOnline: async () => [],
    switchToCloud: async (_u: string, t: string) => { calls.push(t); return { status: 409, body: { error: 'e2bKeyNotConfigured', action: 'cloudKeySettings' } }; },
  };
  assert.equal((await handleFactoryDispatchRecovery(recovery, { userId: null, taskId: 'x', action: 'status' })).status, 401);
  assert.equal((await handleFactoryDispatchRecovery(recovery, { userId: 'u', taskId: 'x', action: 'status' })).status, 422);
  assert.equal((await handleFactoryDispatchRecovery(recovery, { userId: 'u', taskId: '11111111-1111-4111-8111-111111111111', action: 'status' })).status, 404);
  const cloud = await handleFactoryDispatchRecovery(recovery, { userId: 'u', taskId: 'AAAAAAAA-1111-4111-8111-111111111111', action: 'cloud' });
  assert.equal(cloud.status, 409);
  assert.equal(cloud.body.error, 'e2bKeyNotConfigured');
  assert.deepEqual(calls, ['aaaaaaaa-1111-4111-8111-111111111111']);
});

test('cloud dispatch is off until #438: constant false, switchToCloud refuses with 409 even with a key', async () => {
  assert.equal(FACTORY_CLOUD_DISPATCH_AVAILABLE, false);
  const queries: string[] = [];
  const pool = { connect: async () => ({ query: async (sql: string) => { queries.push(sql); return { rows: [{ id: 't' }] }; }, release() {} }) };
  let keyChecks = 0;
  const recovery = createFactoryDispatchRecovery(pool as never, async () => { keyChecks++; return true; });
  assert.deepEqual(await recovery.switchToCloud('u', 't'), { status: 409, body: { error: 'cloudDispatchUnavailable' } });
  assert.equal(queries.length, 1, 'only the ownership read; nothing written');
  assert.ok(/^SELECT/i.test(queries[0]));
  assert.equal(keyChecks, 0);
});
