import type { PoolClient } from 'pg'
import type { Harness } from '@mikka/protocol/harness'
import type { CollaborativeRunAuthority } from '@/lib/execution-identity'

type Actor = { userId: string; workspaceId: string }
type Input = { botId: string; agentId: string; deviceRepoId: string }
type Target = { deviceId: string; instructions: string; harness: Harness; baseBranch: string }

/** A collaborator may resume only the already disclosed, dedicated task
 * machine. No parent Bot wake or current private Agent instructions enter this
 * path. The same proof is repeated inside admission before writing a run. */
export async function collaborativeCloudTaskTarget(tx: Pick<PoolClient, 'query'>, ownerId: string, input: {
  sourceRunId: string; botId: string; issueId: string; harness?: Harness; model: string; keyId: string;
}, authority: CollaborativeRunAuthority): Promise<(Target & {
  workspaceId: string; agentId: string; repoId: string; remoteUrl: string | null;
}) | null> {
  if (!authority.actorId || authority.actorId === ownerId || authority.threadOwnerId !== ownerId) return null
  const { rows: [target] } = await tx.query<Target & {
    workspaceId: string; agentId: string; repoId: string; remoteUrl: string | null; credentialOwnerId: string;
  }>(`SELECT source."workspaceId",source."agentId",repo.id AS "repoId",dev.id AS "deviceId",
      source."agentDefinition"->>'instructions' AS instructions,source."agentDefinition"->>'harness' AS harness,
      repo."baseBranch",repo."remoteUrl",credential."ownerId" AS "credentialOwnerId"
    FROM agent_runs source
    JOIN computer_run_bindings binding ON binding."runId"=source.id AND binding."ownerId"=source."userId" AND binding."workspaceId"=source."workspaceId"
    JOIN bots bot ON bot.id=binding."botId" AND bot."ownerId"=source."userId" AND bot."workspaceId"=source."workspaceId" AND bot."archivedAt" IS NULL
    JOIN agents agent ON agent.id=source."agentId" AND agent."userId"=source."userId"
    JOIN devices dev ON dev.id=source."deviceId" AND dev."ownerId"=source."userId" AND dev.kind='cloud' AND dev.enabled AND dev."removedAt" IS NULL
    JOIN device_repos repo ON repo.id=source."deviceRepoId" AND repo."deviceId"=dev.id AND repo."userId"=source."userId"
    JOIN thread_machines machine ON machine."deviceId"=dev.id AND machine."ownerId"=source."userId" AND machine."workspaceId"=source."workspaceId"
      AND machine."issueId"=source."issueId" AND machine."botId"=bot.id AND machine.state IN ('running','paused','error') AND machine."sandboxId" IS NOT NULL
    JOIN model_api_keys credential ON credential.id=$5 AND credential."revokedAt" IS NULL
    JOIN thread_execution_authorizations receipt ON receipt.id=$6 AND receipt."sourceRunId"=source.id
      AND receipt."ownerId"=source."userId" AND receipt."workspaceId"=source."workspaceId" AND receipt."actorId"=$7
    WHERE source.id=$1 AND source."userId"=$2 AND bot.id=$3 AND source."issueId"=$4
      AND source.status IN ('succeeded','failed','stopped','cancelled')
      AND source."agentDefinition"->>'harness' IN ('claude_code','codex')
      AND ($8::text IS NULL OR source."agentDefinition"->>'harness'=$8)
      AND NOT EXISTS(SELECT 1 FROM agent_runs active WHERE active."deviceId"=dev.id
        AND active.status IN ('queued','preparing','running','waiting_input','paused','finishing')
        AND active.id IS DISTINCT FROM receipt."runId")
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS(SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=source."workspaceId" AND p.permission='deny'))
    FOR SHARE OF source,binding,bot,agent,dev,repo,machine,credential,receipt`,
  [input.sourceRunId, ownerId, input.botId, input.issueId, input.keyId, authority.collaborationAuthorizationId, authority.actorId, input.harness ?? null])
  if (!target || typeof target.instructions !== 'string') return null
  const valid = await (await import('@/lib/collaboration-run-authority')).validateCollaborationRunAuthority(tx, {
    authorizationId: authority.collaborationAuthorizationId, actorId: authority.actorId, executionOwnerId: ownerId,
    threadOwnerId: authority.threadOwnerId, workspaceId: target.workspaceId, deviceId: target.deviceId,
    credentialKind: 'api_key', credentialOwnerId: target.credentialOwnerId, credentialId: input.keyId, model: input.model, harness: target.harness,
  })
  if (!valid) return null
  const { credentialOwnerId: _credentialOwnerId, ...result } = target
  return result
}

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
