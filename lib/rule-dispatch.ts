import "server-only";
import type { Pool } from "pg";
import { pool } from "./db";
import { issueForUser } from "./issue-access";
import { readIssueMetadata } from "./issue-metadata";
import { resolveExecution, type ExecutionDevice, type ExecutionRule } from "./execution-rules";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { isDeviceOnline } from "@mikka/protocol/device";
import { ActionFailureError } from "./action-error";
import type { HarnessInfo } from "@mikka/protocol/harness";

type Query = Pick<Pool, "query">;
type DeviceRow = ExecutionDevice & { lastSeenAt: Date | null; deviceType?: string | null };
export type DeviceTarget = {
  place: string;
  harness: string;
  model?: string;
  agentId: string;
  pinnedDeviceId?: string;
  waitFor?: string;
};

/** Cloud means the workspace's own E2B key and this bot's cloud runtime (MVP: no Mikka-hosted sandboxes). */
export async function cloudReady(
  query: Query,
  scope: { ownerId: string; workspaceId: string; botId: string | null; harness: string },
) {
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== "1" || process.env.MIKKA_BYOS_ENABLED !== "1") return false;
  const { rowCount } = await query.query(
    `SELECT 1 FROM workspace_e2b_keys k JOIN bot_cloud_runtimes r ON r."workspaceId"=k."workspaceId"
      WHERE k."workspaceId"=$1 AND ($2::uuid IS NULL OR r."botId"=$2) AND r."ownerId"=$3 AND ($4='auto' OR r.harness=$4) LIMIT 1`,
    [scope.workspaceId, scope.botId, scope.ownerId, scope.harness],
  );
  return Boolean(rowCount);
}

/**
 * The person's own online device for a run the cloud cannot take
 * (orchestration.md § 4): a server first, then the default rule's device, else
 * the most recently seen one. The rule's harness wins when the device has it;
 * otherwise its first installed harness.
 */
export async function fallbackDevice(
  query: Query,
  ownerId: string,
  devices: readonly DeviceRow[],
  rules: readonly ExecutionRule[] | null,
  harness: string | null,
): Promise<DeviceTarget | null> {
  const preferred = rules?.find((r) => r.label === null)?.place;
  // Only devices with 允许调度 on (enabled); servers first, then the default rule's device, then the most recent.
  const online = devices
    .filter((d) => d.online && d.enabled)
    .sort((a, b) => Number(b.deviceType === "server") - Number(a.deviceType === "server") || Number(b.id === preferred) - Number(a.id === preferred));
  for (const device of online) {
    const installed = (device.harnesses ?? []).filter((h: HarnessInfo) => h.installed);
    const ordered = [...installed].sort((a, b) => Number(b.harness === harness) - Number(a.harness === harness));
    for (const info of ordered) {
      const agent = (
        await query.query(
          'SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1',
          [ownerId, device.id, info.harness],
        )
      ).rows[0];
      if (agent)
        return {
          place: device.id,
          harness: info.harness,
          model: info.defaultModelSlot ?? info.models?.[0],
          agentId: agent.id,
        };
    }
  }
  return null;
}

/**
 * Where an issue's run executes (decision 2026-10-31-2200-run-machine-fallback):
 * a matching rule on an online device runs there; otherwise the workspace's own
 * E2B cloud, then the person's online device, then the rule's offline device
 * (queued until it is back), else `needsMachine`, which never fails the request.
 */
export async function resolveIssueExecution(
  ownerId: string,
  botId: string | null,
  issueId: string,
) {
  const issue = await issueForUser(ownerId, issueId);
  if (!issue) throw new ActionFailureError("issueNotFound");
  const workspaceId = await executionWorkspace(ownerId, botId);
  const settings = new ExecutionSettings(pool);
  const fallbacks = await settings.fallbacks(ownerId);
  // No model and no device yet (a new person): nothing to run on, which is a wait, not an error.
  const rules = await settings.list({ ownerId, workspaceId }).catch((error: unknown) => {
    if (error instanceof ActionFailureError && error.code === "executionModelUnknown") return null;
    throw error;
  });
  const { rows } = await pool.query(
    `SELECT id,enabled,"lastSeenAt","deviceType",harnesses FROM devices WHERE "ownerId"=$1 AND kind='local' AND "removedAt" IS NULL ORDER BY "lastSeenAt" DESC NULLS LAST,id`,
    [ownerId],
  );
  const devices: DeviceRow[] = rows.map((row) => ({
    ...row,
    online: isDeviceOnline(row.lastSeenAt),
  }));
  const labels = readIssueMetadata(issue.content).labels.map(
    (label) => label.name,
  );
  const resolution = rules ? resolveExecution(labels, rules, devices, fallbacks) : null;
  // The rule's own device, queued while it is offline; the daemon claims it when it returns.
  const pinned = async (): Promise<DeviceTarget | null> => {
    if (!rules) return null;
    const waiting = resolveExecution(labels, rules, devices, { ...fallbacks, whenDeviceOffline: "wait" });
    if (!("waitFor" in waiting)) return null;
    const selected = resolveExecution(
      labels,
      rules,
      devices.map((d) => (d.id === waiting.waitFor ? { ...d, online: true, enabled: true } : d)),
      fallbacks,
    );
    if ("waitFor" in selected || selected.place === "cloud") return null;
    return { ...(await deviceTarget(ownerId, selected)), pinnedDeviceId: waiting.waitFor, waitFor: waiting.waitFor };
  };
  if (resolution && "waitFor" in resolution) {
    const target = await pinned();
    if (!target) throw new ActionFailureError("agentNoDevice");
    return { ...target, workspaceId, issue };
  }
  if (resolution && resolution.place !== "cloud") {
    const target = await deviceTarget(ownerId, resolution);
    return { ...target, workspaceId, issue, pinnedDeviceId: resolution.place };
  }
  // Cloud, by rule or because nothing else matched. A device is the fallback.
  const harness = resolution?.harness ?? null;
  const fallback = (await fallbackDevice(pool, ownerId, devices, rules, harness)) ?? (await pinned());
  if (resolution && (await cloudReady(pool, { ownerId, workspaceId, botId, harness: resolution.harness })))
    return { ...resolution, place: "cloud" as const, workspaceId, issue, ...(fallback ? { fallback } : {}) };
  if (fallback) return { ...fallback, workspaceId, issue };
  return { needsMachine: true as const, workspaceId, issue };
}

async function deviceTarget(ownerId: string, selected: { place: string; harness: string; model: string }): Promise<DeviceTarget> {
  const agent = (
    await pool.query(
      'SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1',
      [ownerId, selected.place, selected.harness],
    )
  ).rows[0];
  if (!agent) throw new ActionFailureError("agentHarnessMissing");
  return { place: selected.place, harness: selected.harness, model: selected.model, agentId: agent.id };
}
