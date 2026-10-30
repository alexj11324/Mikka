import type { Pool, PoolClient } from 'pg';
import { isDeviceOnline } from '@mikka/protocol/device';

/** Why a Factory run cannot start on its assigned device. Frontend (#453) keys copy on these codes. */
export const FACTORY_DISPATCH_FAILURE_REASONS = ['deviceOffline', 'deviceDisabled', 'harnessUnavailable', 'e2bKeyNotConfigured'] as const;
export type FactoryDispatchFailureReason = (typeof FACTORY_DISPATCH_FAILURE_REASONS)[number];

export interface FactoryDispatchDevice { id: string; name: string; enabled: boolean; lastSeenAt: Date | null; harnesses: unknown }

/** Same rule as lib/mcp/actions.ts deviceOnline: enabled and seen within DEVICE_ONLINE_WINDOW_MS. */
export function factoryDeviceOnline(device: Pick<FactoryDispatchDevice, 'enabled' | 'lastSeenAt'>, now = Date.now()) {
  return device.enabled && isDeviceOnline(device.lastSeenAt, now);
}

function harnessInstalled(harnesses: unknown, harness: string) {
  return Array.isArray(harnesses) && harnesses.some(info => info && typeof info === 'object' && (info as { harness?: unknown }).harness === harness && (info as { installed?: unknown }).installed === true);
}

/** Null when the device can take the run now. Order: disabled, offline, harness. */
export function factoryDispatchFailureReason(device: FactoryDispatchDevice, harness: string | null, now = Date.now()): FactoryDispatchFailureReason | null {
  if (!device.enabled) return 'deviceDisabled';
  if (!factoryDeviceOnline(device, now)) return 'deviceOffline';
  if (harness && !harnessInstalled(device.harnesses, harness)) return 'harnessUnavailable';
  return null;
}

/** #453 BeQuestions option: value 1-80, label 1-200, description <=300, action only for the cloud key link. */
export interface FactoryClarificationOption { value: 'wait' | 'cloud'; label: string; description: string; action?: 'cloudKeySettings' }
export interface FactoryClarification { id: string; title: string; options: FactoryClarificationOption[]; multiple: false; allowCustom: false; task: string }

/** Structured "wait or cloud" choice for a dispatch failure, in #453's question format. */
export function factoryDispatchClarification(taskId: string, runId: string, reason: FactoryDispatchFailureReason, cloudKeyConfigured: boolean): FactoryClarification {
  return {
    id: `dispatch:${runId}`,
    title: reason === 'e2bKeyNotConfigured' ? 'Cloud computer needs an E2B key' : 'The assigned device cannot start this task',
    options: [
      { value: 'wait', label: 'Wait for the device', description: 'Start automatically when the device comes back online.' },
      cloudKeyConfigured
        ? { value: 'cloud', label: 'Switch to cloud computer', description: 'Run on a cloud computer with your E2B key.' }
        : { value: 'cloud', label: 'Switch to cloud computer', description: 'Add your E2B key in Settings first.', action: 'cloudKeySettings' },
    ],
    multiple: false, allowCustom: false, task: taskId,
  };
}

export interface FactoryDispatchStatus {
  taskId: string; runId: string | null; runStatus: string | null;
  device: { id: string; name: string; online: boolean; lastSeenAt: string | null } | null;
  failure: { reasonCode: FactoryDispatchFailureReason } | null;
  clarification: FactoryClarification | null;
}

/** The person's BYO E2B key presence. Never reads the platform key or the key value. */
export type CloudKeyConfigured = (tx: PoolClient, userId: string) => Promise<boolean>;
/** main has no BYO key store yet (#436/#438 unmerged), so nothing is configured. */
export const noByoCloudKey: CloudKeyConfigured = async () => false;

const taskRunSql = `SELECT t.id AS "taskId", t."botId", t."issueId", a."runId", r.status AS "runStatus", r."deviceId", ag.harness,
    d.id AS "dId", d.name, d.enabled, d."lastSeenAt", d.harnesses
  FROM factory_tasks t
  JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
  LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId"
  LEFT JOIN agents ag ON ag.id=r."agentId" AND ag."userId"=r."userId"
  LEFT JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
  WHERE t.id=$1 AND t."userId"=$2`;

async function insertEvent(tx: PoolClient, row: { userId: string; botId: string | null; kind: string; dedupeKey: string; issueId: string | null; runId: string; payload: Record<string, unknown> }) {
  const { rowCount } = await tx.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId","runId",payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("dedupeKey") DO NOTHING`,
  [crypto.randomUUID(), row.userId, row.botId, row.kind, row.dedupeKey, row.issueId, row.runId, JSON.stringify(row.payload)]);
  return rowCount === 1;
}

export function createFactoryDispatchRecovery(pool: Pool, cloudKeyConfigured: CloudKeyConfigured = noByoCloudKey, now: () => number = Date.now) {
  /** Reads where the task's current run stands; a queued run that cannot start records one `run_dispatch_failed` per (run, reason). */
  async function status(userId: string, taskId: string): Promise<FactoryDispatchStatus | null> {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const { rows: [row] } = await tx.query(taskRunSql, [taskId, userId]);
      if (!row) { await tx.query('ROLLBACK'); return null; }
      const device = row.dId ? { id: row.dId, name: row.name, enabled: row.enabled, lastSeenAt: row.lastSeenAt, harnesses: row.harnesses } as FactoryDispatchDevice : null;
      const reason = device && row.runStatus === 'queued' ? factoryDispatchFailureReason(device, row.harness, now()) : null;
      let clarification: FactoryClarification | null = null;
      if (reason && row.runId) {
        await insertEvent(tx, { userId, botId: row.botId, kind: 'run_dispatch_failed', dedupeKey: `run_dispatch_failed:${row.runId}:${reason}`, issueId: row.issueId, runId: row.runId,
          payload: { taskId, deviceId: device!.id, reasonCode: reason } });
        clarification = factoryDispatchClarification(taskId, row.runId, reason, await cloudKeyConfigured(tx, userId));
      }
      await tx.query('COMMIT');
      return {
        taskId, runId: row.runId ?? null, runStatus: row.runStatus ?? null,
        device: device ? { id: device.id, name: device.name, online: factoryDeviceOnline(device, now()), lastSeenAt: device.lastSeenAt?.toISOString() ?? null } : null,
        failure: reason ? { reasonCode: reason } : null, clarification,
      };
    } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error; } finally { tx.release(); }
  }

  /**
   * The device is online again: every still-queued run on it that recorded a dispatch failure
   * gets exactly one `run_redispatched` event (dedupe key per run) under a per-device lock.
   * The run row stays queued, so the daemon's next claim starts it; nothing is queued twice.
   */
  async function deviceOnline(userId: string, deviceId: string): Promise<string[]> {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['factory-redispatch', userId, deviceId])]);
      const { rows: [device] } = await tx.query('SELECT id,name,enabled,"lastSeenAt",harnesses FROM devices WHERE id=$1 AND "ownerId"=$2', [deviceId, userId]);
      if (!device || !factoryDeviceOnline(device, now())) { await tx.query('COMMIT'); return []; }
      const { rows } = await tx.query(`SELECT r.id AS "runId", r."issueId", r."botId", t.id AS "taskId"
        FROM agent_runs r
        JOIN factory_attempts a ON a."runId"=r.id
        JOIN factory_tasks t ON t.id=a."taskId" AND t."attemptId"=a.id AND t."userId"=r."userId"
        WHERE r."userId"=$1 AND r."deviceId"=$2 AND r.status='queued' AND t.status NOT IN ('cancelled','revoked')
          AND EXISTS (SELECT 1 FROM coordinator_events e WHERE e."runId"=r.id AND e."userId"=r."userId" AND e.kind='run_dispatch_failed')
        ORDER BY r."createdAt", r.id FOR UPDATE OF r SKIP LOCKED`, [userId, deviceId]);
      const resumed: string[] = [];
      for (const run of rows) {
        if (await insertEvent(tx, { userId, botId: run.botId, kind: 'run_redispatched', dedupeKey: `run_redispatched:${run.runId}`, issueId: run.issueId, runId: run.runId, payload: { taskId: run.taskId, deviceId } }))
          resumed.push(run.runId);
      }
      await tx.query('COMMIT');
      return resumed;
    } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error; } finally { tx.release(); }
  }

  /** "Switch to cloud computer": BYO E2B key path only; without a key the answer is e2bKeyNotConfigured. */
  async function switchToCloud(userId: string, taskId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const tx = await pool.connect();
    try {
      const { rows: [task] } = await tx.query('SELECT id FROM factory_tasks WHERE id=$1 AND "userId"=$2', [taskId, userId]);
      if (!task) return { status: 404, body: { error: 'factoryNotFound' } };
      if (!await cloudKeyConfigured(tx, userId)) return { status: 409, body: { error: 'e2bKeyNotConfigured', action: 'cloudKeySettings', settingsUrl: '/settings?section=integrations' } };
      // The BYO key store and cloud placement land with #436/#438; until then nothing starts here.
      return { status: 501, body: { error: 'cloudSwitchUnavailable' } };
    } finally { tx.release(); }
  }

  return { status, deviceOnline, switchToCloud };
}
