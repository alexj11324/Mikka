import "server-only";
import { pool } from "./db";
import { issueForUser } from "./issue-access";
import { readIssueMetadata } from "./issue-metadata";
import { resolveExecution, type ExecutionDevice } from "./execution-rules";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { isDeviceOnline } from "@mikka/protocol/device";
import { ActionFailureError } from "./action-error";
import { personalResourceAllowed } from "./personal-policy";

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
  const rules = await settings.list({
    ownerId,
    workspaceId,
  });
  // A team admin can switch personal devices off for this workspace (decision 2026-10-31-2130).
  const { rows } = (await personalResourceAllowed(pool, workspaceId, "devices"))
    ? await pool.query(
        `SELECT id,enabled,"lastSeenAt",harnesses FROM devices WHERE "ownerId"=$1 AND kind='local' AND "removedAt" IS NULL ORDER BY "lastSeenAt" DESC NULLS LAST,id`,
        [ownerId],
      )
    : { rows: [] };
  const devices: ExecutionDevice[] = rows.map((row) => ({
    ...row,
    online: isDeviceOnline(row.lastSeenAt),
  }));
  const labels = readIssueMetadata(issue.content).labels.map(
    (label) => label.name,
  );
  const resolution = resolveExecution(labels, rules, devices, fallbacks);
  // Queue on the same device while offline; the normal daemon poll claims it
  // when it returns. Do not hand this run to a different device.
  const selected =
    "waitFor" in resolution
      ? resolveExecution(
          labels,
          rules,
          devices.map((d) =>
            d.id === resolution.waitFor
              ? { ...d, online: true, enabled: true }
              : d,
          ),
          fallbacks,
        )
      : resolution;
  if ("waitFor" in selected) throw new ActionFailureError("agentNoDevice");
  if (selected.place === "cloud") return { ...selected, workspaceId, issue };
  const agent = (
    await pool.query(
      'SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1',
      [ownerId, selected.place, selected.harness],
    )
  ).rows[0];
  if (!agent) throw new ActionFailureError("agentHarnessMissing");
  const matched =
    [...rules]
      .filter((r) => r.label !== null)
      .sort((a, b) => a.position - b.position)
      .find((r) => labels.includes(r.label!)) ??
    rules.find((r) => r.label === null);
  return {
    ...selected,
    agentId: agent.id,
    workspaceId,
    issue,
    ...(matched && selected.place !== "cloud"
      ? { pinnedDeviceId: matched.place }
      : {}),
    ...("waitFor" in resolution ? { waitFor: resolution.waitFor } : {}),
  };
}
