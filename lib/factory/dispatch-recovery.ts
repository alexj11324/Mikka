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

/**
 * Cloud (E2B) dispatch capability. Hardcoded off until #438 wires the BYO E2B key store and cloud
 * placement; deliberately a code constant, not an env var, so no environment can turn it on.
 * While false, GET .../dispatch reports cloudDispatchAvailable:false and POST .../dispatch/cloud
 * refuses with 409 cloudDispatchUnavailable (also when called directly).
 */
export const FACTORY_CLOUD_DISPATCH_AVAILABLE: boolean = false;

export interface FactoryDispatchStatus {
  /** Frontend hides/disables "Switch to cloud computer" when false. */
  cloudDispatchAvailable: boolean;
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

/**
 * Write path: called in the transaction that queues a Factory run. When the target device cannot
 * take it right now, records one `run_dispatch_failed:<runId>:<reasonCode>`. Returns the reason or null.
 */
export async function recordFactoryDispatchFailure(tx: PoolClient, userId: string, runId: string, attemptId: string | null = null, at = Date.now()): Promise<FactoryDispatchFailureReason | null> {
  const { rows: [row] } = await tx.query(`SELECT r.status, r."issueId", r."botId", ag.harness, d.id AS "dId", d.name, d.enabled, d."lastSeenAt", d.harnesses,
      (SELECT a."taskId" FROM factory_attempts a WHERE a.id=$3) AS "taskId"
    FROM agent_runs r
    LEFT JOIN agents ag ON ag.id=r."agentId" AND ag."userId"=r."userId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2`, [runId, userId, attemptId]);
  if (!row || row.status !== 'queued') return null;
  const reason = factoryDispatchFailureReason({ id: row.dId, name: row.name, enabled: row.enabled, lastSeenAt: row.lastSeenAt, harnesses: row.harnesses }, row.harness, at);
  if (reason) await insertEvent(tx, { userId, botId: row.botId, kind: 'run_dispatch_failed', dedupeKey: `run_dispatch_failed:${runId}:${reason}`, issueId: row.issueId, runId,
    payload: { taskId: row.taskId ?? null, deviceId: row.dId, reasonCode: reason } });
  return reason;
}

export function createFactoryDispatchRecovery(pool: Pool, cloudKeyConfigured: CloudKeyConfigured = noByoCloudKey, now: () => number = Date.now) {
  /** Strictly read-only (BE-16): failure.reasonCode is computed from the device state right now; nothing is written. */
  async function status(userId: string, taskId: string): Promise<FactoryDispatchStatus | null> {
    const { rows: [row] } = await pool.query(taskRunSql, [taskId, userId]);
    if (!row) return null;
    const device = row.dId ? { id: row.dId, name: row.name, enabled: row.enabled, lastSeenAt: row.lastSeenAt, harnesses: row.harnesses } as FactoryDispatchDevice : null;
    const at = now();
    const reason = device && row.runStatus === 'queued' ? factoryDispatchFailureReason(device, row.harness, at) : null;
    const client = reason ? await pool.connect() : null;
    try {
      return {
        cloudDispatchAvailable: FACTORY_CLOUD_DISPATCH_AVAILABLE,
        taskId, runId: row.runId ?? null, runStatus: row.runStatus ?? null,
        device: device ? { id: device.id, name: device.name, online: factoryDeviceOnline(device, at), lastSeenAt: device.lastSeenAt?.toISOString() ?? null } : null,
        failure: reason ? { reasonCode: reason } : null,
        clarification: reason && client ? factoryDispatchClarification(taskId, row.runId, reason, await cloudKeyConfigured(client, userId)) : null,
      };
    } finally { client?.release(); }
  }

  /**
   * The device is online again: every still-queued Factory run on it that could not be dispatched
   * just before this heartbeat (`wasUnavailable`) or that recorded `run_dispatch_failed` gets exactly
   * one `run_redispatched` event (dedupe key per run).
   * The run row stays queued, so the daemon's next claim starts it; nothing is queued twice.
   *
   * Single-dispatch guarantee: `ON CONFLICT ("dedupeKey") DO NOTHING` in insertEvent, and only a
   * caller whose insert actually wrote a row (rowCount 1) counts the run as resumed. `FOR UPDATE OF r`
   * and `SKIP LOCKED` only reduce contention between concurrent heartbeats.
   */
  async function deviceOnline(userId: string, deviceId: string, wasUnavailable = false): Promise<string[]> {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const { rows: [device] } = await tx.query('SELECT id,name,enabled,"lastSeenAt",harnesses FROM devices WHERE id=$1 AND "ownerId"=$2', [deviceId, userId]);
      if (!device || !factoryDeviceOnline(device, now())) { await tx.query('COMMIT'); return []; }
      const { rows } = await tx.query(`SELECT r.id AS "runId", r."issueId", r."botId", t.id AS "taskId"
        FROM agent_runs r
        JOIN factory_attempts a ON a."runId"=r.id
        JOIN factory_tasks t ON t.id=a."taskId" AND t."attemptId"=a.id AND t."userId"=r."userId"
        WHERE r."userId"=$1 AND r."deviceId"=$2 AND r.status='queued' AND t.status NOT IN ('cancelled','revoked')
          AND ($3::boolean OR EXISTS (SELECT 1 FROM coordinator_events e WHERE e."runId"=r.id AND e."userId"=r."userId" AND e.kind='run_dispatch_failed'))
        ORDER BY r."createdAt", r.id FOR UPDATE OF r SKIP LOCKED`, [userId, deviceId, wasUnavailable]);
      const resumed: string[] = [];
      for (const run of rows) {
        if (await insertEvent(tx, { userId, botId: run.botId, kind: 'run_redispatched', dedupeKey: `run_redispatched:${run.runId}`, issueId: run.issueId, runId: run.runId, payload: { taskId: run.taskId, deviceId } }))
          resumed.push(run.runId);
      }
      await tx.query('COMMIT');
      return resumed;
    } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error; } finally { tx.release(); }
  }

  /**
   * "Switch to cloud computer". 404 for a missing/foreign task; 409 cloudDispatchUnavailable while
   * FACTORY_CLOUD_DISPATCH_AVAILABLE is false (even with a key); then 409 e2bKeyNotConfigured without a BYO key.
   */
  async function switchToCloud(userId: string, taskId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const tx = await pool.connect();
    try {
      const { rows: [task] } = await tx.query('SELECT id FROM factory_tasks WHERE id=$1 AND "userId"=$2', [taskId, userId]);
      if (!task) return { status: 404, body: { error: 'factoryNotFound' } };
      if (!FACTORY_CLOUD_DISPATCH_AVAILABLE) return { status: 409, body: { error: 'cloudDispatchUnavailable' } };
      if (!await cloudKeyConfigured(tx, userId)) return { status: 409, body: { error: 'e2bKeyNotConfigured', action: 'cloudKeySettings', settingsUrl: '/settings?section=secrets' } };
      // The BYO key store and cloud placement land with #436/#438; nothing starts here until then.
      return { status: 409, body: { error: 'cloudDispatchUnavailable' } };
    } finally { tx.release(); }
  }

  return { status, deviceOnline, switchToCloud };
}
