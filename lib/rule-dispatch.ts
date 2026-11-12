import "server-only";
import { cloudComputerRunsEnabled } from "./cloud-computer-flag";
import type { Pool } from "pg";
import { defaultAgentCopy } from "./agent-copy";
import { ownE2BKeySql } from "./secrets/e2b-owner-sql";

type Query = Pick<Pool, "query">;
/**
 * Cloud means the person's own E2B key (keys are personal) on the dispatching bot's own cloud
 * runtime (MVP: no Mikka-hosted sandboxes). The key is enough: a bot with no
 * runtime yet gets one when the run is dispatched (`ensureBotCloudRuntime`).
 * The kill switch turns it off. The workspace's 「电脑」 policy does not: every
 * run dispatched here names a repository with a remote (a repository task), and
 * `queueCloudRun` still refuses a computer task under deny. A run with no bot (the Coordinator) uses the owner's hidden Coordinator bot
 * (`ensureCoordinatorBot`) and never borrows another bot's runtime.
 * A key E2B already refused (lastErrorCode invalid, cleared when the key is
 * saved again) is not tried: 云端 goes straight to a server or a computer.
 */
export async function cloudReady(
  query: Query,
  scope: { ownerId: string; workspaceId: string; botId: string | null; harness: string },
  purpose?: import('./cloud-template-models').CloudModelPurpose,
) {
  if (!cloudComputerRunsEnabled()) return false;
  if (purpose === 'cloudflare_task') {
    const { hostedTaskEnabled } = await import('./cloud-computer/sponsored-task')
    return hostedTaskEnabled(scope.workspaceId)
  }
  const { rowCount } = await query.query(
    `SELECT 1 WHERE ${ownE2BKeySql('$3::text')}
        AND NOT EXISTS (SELECT 1 FROM user_e2b_keys uk WHERE uk."userId"=$3::text AND uk."lastErrorCode"='invalid')
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$2 AND b."workspaceId"=$1::uuid AND b."ownerId"=$3 AND b."archivedAt" IS NULL))`,
    [scope.workspaceId, scope.botId, scope.ownerId],
  );
  return Boolean(rowCount);
}

/**
 * 没有可用的电脑 (Alex, 2026-11-01): what the person can do when no machine can
 * take a new run, as two rows: 连接电脑 opens Settings › 电脑, where a computer
 * is connected or switched on (and picked automatically); 填入 E2B Key opens
 * where the person's own E2B key is set, the only way to run in the cloud. No
 * row offers Mikka's own cloud.
 */
export function machineUnavailableCard() {
  const copy = defaultAgentCopy;
  return {
    title: copy.needsMachineTitle,
    description: copy.needsMachineDescription,
    options: [
      { value: "computer", label: copy.needsMachineConnect, action: "connectServer" },
      { value: "e2b", label: copy.needsMachineE2B, action: "e2bKey" },
    ],
  };
}
