import "server-only";
import type { Pool } from "pg";

import type { RunInfo } from "./run-info-view";

/**
 * 运行信息: read only from what was frozen when the thread was dispatched
 * (agent_runs, its worker definition) and from the run_retried event when it
 * moved. Nothing frozen, nothing shown.
 */
type Row = {
  id: string;
  deviceKind: string | null;
  deviceName: string | null;
  harness: string | null;
  model: string | null;
  provider: string | null;
  plan: string | null;
  ownerName: string | null;
};

const machineOf = (kind: string | null, name: string | null): RunInfo["machine"] =>
  kind === "cloud" ? { kind: "cloud" } : name ? { kind: "device", name } : null;

/** The viewer's own runs only: a teammate's machine and payer stay with them. */
export async function runInfo(
  pool: Pick<Pool, "query">,
  userId: string,
  runIds: readonly string[],
): Promise<Map<string, RunInfo>> {
  const result = new Map<string, RunInfo>();
  if (!runIds.length) return result;
  const { rows } = await pool.query<Row>(
    `SELECT r.id::text AS id, d.kind AS "deviceKind", d.name AS "deviceName",
       coalesce(r."agentDefinition"->>'harness', a.harness) AS harness,
       coalesce(r."agentDefinition"->'subscription'->>'modelId', r."agentDefinition"->>'model') AS model,
       c.provider, c.quota->>'plan' AS plan, u.name AS "ownerName"
     FROM agent_runs r
     JOIN agents a ON a.id = r."agentId"
     LEFT JOIN devices d ON d.id = r."deviceId"
     LEFT JOIN byos_bindings b ON b.id::text = r."agentDefinition"->'subscription'->>'bindingId'
     LEFT JOIN byos_connections c ON c.id = b."connectionId"
     LEFT JOIN "user" u ON u.id = b."ownerId"
     WHERE r.id::text = ANY($1::text[]) AND r."userId" = $2`,
    [[...runIds], userId],
  );
  for (const row of rows)
    result.set(row.id, {
      machine: machineOf(row.deviceKind, row.deviceName),
      harness: row.harness,
      model: row.model,
      payer: row.provider ? { provider: row.provider, plan: row.plan, ownerName: row.ownerName } : null,
      movedTo: null,
    });
  if (!result.size) return result;
  const moved = await pool.query<{ runId: string; kind: string | null; name: string | null }>(
    `SELECT e."runId"::text AS "runId", d.kind, d.name
     FROM coordinator_events e
     JOIN devices d ON d.id::text = e.payload->>'movedToDeviceId'
     WHERE e.kind = 'run_retried' AND e."userId" = $2 AND e."runId"::text = ANY($1::text[])`,
    [[...result.keys()], userId],
  );
  for (const row of moved.rows) {
    const info = result.get(row.runId);
    if (info) info.movedTo = machineOf(row.kind, row.name);
  }
  return result;
}
