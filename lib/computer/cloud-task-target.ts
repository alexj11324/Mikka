import 'server-only'
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
    JOIN device_repos repo ON repo.id=$5 AND repo."deviceId"=dev.id AND repo."userId"=b."ownerId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND b."archivedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM bot_cloud_runtimes r WHERE r."agentId"=a.id
        AND (r."botId"<>b.id OR r."ownerId"<>b."ownerId" OR r."workspaceId"<>b."workspaceId" OR r.harness<>a.harness))
      AND NOT EXISTS (SELECT 1 FROM bot_cloud_runtimes r WHERE r."repoId"=repo.id
        AND (r."botId"<>b.id OR r."ownerId"<>b."ownerId" OR r."workspaceId"<>b."workspaceId"))
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny'))
    FOR SHARE OF b,desktop,m,dev,a,repo`,
  [input.botId, actor.userId, actor.workspaceId, input.agentId, input.deviceRepoId])
  return target ?? null
}
