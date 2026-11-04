import type { PoolClient } from 'pg'
import type { Harness } from '@mikka/protocol/harness'

type Actor = { userId: string; workspaceId: string }
type Input = { botId: string; agentId: string; deviceRepoId: string }
type Target = { deviceId: string; instructions: string; harness: Harness; baseBranch: string }

/** Task machines use official templates, so parent state and heartbeat are not
 * admission inputs. Only the owner's enabled runtime metadata and repository
 * policy are shared by ordinary tasks and independent Factory checks. */
export async function cloudTaskTarget(tx: Pick<PoolClient, 'query'>, actor: Actor, input: Input): Promise<Target | null> {
  const { rows: [target] } = await tx.query<Target>(`SELECT m."deviceId",a.instructions,a.harness,repo."baseBranch" FROM bots b
    JOIN bot_desktops desktop ON desktop."botId"=b.id AND desktop."ownerId"=b."ownerId" AND desktop."workspaceId"=b."workspaceId"
    JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
    JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
    JOIN agents a ON a.id=$4 AND a."userId"=b."ownerId" AND a."deviceId"=dev.id
    JOIN bot_cloud_runtimes runtime ON runtime."botId"=b.id AND runtime."ownerId"=b."ownerId" AND runtime."workspaceId"=b."workspaceId"
      AND runtime."agentId"=a.id AND runtime.harness=a.harness
    JOIN device_repos repo ON repo.id=$5 AND repo."deviceId"=dev.id AND repo."userId"=b."ownerId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND b."archivedAt" IS NULL
      AND (repo."remoteUrl" IS NOT NULL OR repo.id=runtime."repoId")
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny'))
    FOR SHARE OF b,desktop,m,dev,a,runtime,repo`,
  [input.botId, actor.userId, actor.workspaceId, input.agentId, input.deviceRepoId])
  return target ?? null
}

/** A continuation keeps the task VM already transferred to this exact run.
 * Its recorded custody is independent of the parent runtime's current state. */
export async function ownedCloudTaskTarget(tx: Pick<PoolClient, 'query'>, actor: Actor, input: Input & { runId: string; issueId: string }): Promise<Target | null> {
  const { rows: [target] } = await tx.query<Target>(`SELECT dev.id AS "deviceId",a.instructions,a.harness,repo."baseBranch"
    FROM agent_runs r
    JOIN computer_run_bindings binding ON binding."runId"=r.id AND binding."ownerId"=r."userId"
    JOIN bots b ON b.id=binding."botId" AND b."ownerId"=binding."ownerId" AND b."workspaceId"=binding."workspaceId" AND b."archivedAt" IS NULL
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b.id
      AND m."issueId"=r."issueId" AND m."deviceId"=r."deviceId" AND m."repoId"=r."deviceRepoId"
    JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=r."userId" AND dev.kind='cloud' AND dev.enabled=true
    JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId"
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."deviceId"=dev.id AND repo."userId"=r."userId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND a.id=$4 AND repo.id=$5 AND r.id=$6 AND r."issueId"=$7
      AND (r."botId" IS NULL OR r."botId"=b.id) AND r.status='queued' AND r."stopRequestedAt" IS NULL
      AND m.state IN ('running','paused','error') AND m."sandboxId" IS NOT NULL
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny'))
    FOR SHARE OF r,binding,b,m,dev,a,repo`,
  [input.botId, actor.userId, actor.workspaceId, input.agentId, input.deviceRepoId, input.runId, input.issueId])
  return target ?? null
}
