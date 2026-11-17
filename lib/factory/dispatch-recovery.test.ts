import assert from 'node:assert/strict';
import test from 'node:test';
import { FACTORY_CLOUD_DISPATCH_AVAILABLE, createFactoryDispatchRecovery, factoryDeviceOnline, factoryDispatchClarification, factoryDispatchFailureReason, recordFactoryDispatchFailure } from './dispatch-recovery';
import { handleFactoryDispatchRecovery } from './dispatch-recovery-http';

const now = Date.parse('2026-10-30T07:00:00Z');
type Device = { enabled: boolean; lastSeenAt: Date | null; sessionOpenedAt: Date | null; sessionClosedAt: Date | null; harnesses: unknown };
const device = (over: Partial<Device> = {}) =>
  ({ id: 'd', name: 'Mac', enabled: true, lastSeenAt: new Date(now - 1_000), sessionOpenedAt: new Date(now - 3_600_000), sessionClosedAt: null, harnesses: [{ harness: 'codex', installed: true }], ...over });
const closed = { sessionClosedAt: new Date(now - 1_000) };

test('online is an open device session and the enabled switch', () => {
  assert.equal(factoryDeviceOnline(device()), true);
  assert.equal(factoryDeviceOnline(device({ lastSeenAt: new Date(now - 3_600_000) })), true, 'no heartbeat window');
  assert.equal(factoryDeviceOnline(device(closed)), false);
  assert.equal(factoryDeviceOnline(device({ sessionOpenedAt: null })), false);
  assert.equal(factoryDeviceOnline(device({ enabled: false })), false);
});

test('reason codes: disabled before offline before harness', () => {
  assert.equal(factoryDispatchFailureReason(device(), 'codex'), null);
  assert.equal(factoryDispatchFailureReason(device({ enabled: false, sessionOpenedAt: null }), 'codex'), 'deviceDisabled');
  assert.equal(factoryDispatchFailureReason(device(closed), 'codex'), 'deviceOffline');
  assert.equal(factoryDispatchFailureReason(device(), 'claude_code'), 'harnessUnavailable');
  assert.equal(factoryDispatchFailureReason(device({ harnesses: [{ harness: 'codex', installed: false }] }), 'codex'), 'harnessUnavailable');
});

test('a device with an open session writes no dispatch failure', async () => {
  let queries = 0;
  const tx = { query: async (sql: string) => {
    queries++;
    assert.match(sql, /^SELECT /, 'an online device must not produce a failure write');
    return { rows: [{ ...device(), dId: 'd', status: 'queued', harness: 'codex' }] };
  } };
  assert.equal(await recordFactoryDispatchFailure(tx as never, 'owner', 'run'), null);
  assert.equal(queries, 1);
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
  assert.ok(queries.every((sql) => !/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b|FOR\s+(UPDATE|SHARE)/i.test(sql)), 'no writes or row locks');
  assert.equal(keyChecks, 0);
});
