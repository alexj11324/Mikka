import type { Pool, PoolClient } from 'pg'
import { groupDirectory } from './group-conversations-directory'
import type { Directory } from './group-conversations-store'
import { reject } from './group-review-access'

/** Dedicated device transport only. Hold workspace membership locks until all
 * application transactions finish. No generic MCP/credential capability is minted.
 * As with issue authority, this is not a distributed commit across databases. */
export async function withGroupWorkerAuthority<T>(workspacePool: Pool, caller: { userId: string; tokenId: string }, deviceId: string, fn: (directory: Directory) => Promise<T>): Promise<T> {
  const workspace = await workspacePool.connect()
  try {
    await workspace.query('BEGIN')
    await workspace.query("SET LOCAL lock_timeout = '5s'")
    await workspace.query("SET LOCAL statement_timeout = '10s'")
    const directory = groupDirectory({
      async activeUsers(workspaceId, ids) {
        return (await workspace.query(`SELECT "userId" FROM mikka_workspace_members
          WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'
          ORDER BY "userId" FOR SHARE`, [workspaceId, ids])).rows.map(row => row.userId)
      },
      async ownedAgents(userId, ids, client) {
        if (!client) return reject(403, 'transaction_required')
        return (await client.query(`SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [userId, ids])).rows.map(row => row.id)
      },
    })
    const guarded: Directory = async (workspaceId, userId, members, client) => {
      if (!client) return reject(403, 'transaction_required')
      // Recheck the authenticated device token on the SAME transaction as the
      // result, including stop/revoke races after initial HTTP authentication.
      const auth = await client.query(`SELECT t.id FROM device_tokens t JOIN devices d ON d."ownerId"=t."userId"
        WHERE t.id=$1 AND t."userId"=$2 AND t."revokedAt" IS NULL AND d.id=$3 AND d.enabled
        FOR SHARE OF t,d`, [caller.tokenId, caller.userId, deviceId])
      if (!auth.rowCount) return reject(403, 'device_authority_revoked')
      return directory(workspaceId, userId, members, client)
    }
    const result = await fn(guarded)
    await workspace.query('COMMIT')
    return result
  } catch (error) { await workspace.query('ROLLBACK'); throw error }
  finally { workspace.release() }
}

/** Full persisted assignment identity, never an issueId-null shortcut. Caller
 * holds conversation/work locks first. Agent/device/mailbox locks prevent drift
 * through result commit; running lease and epoch are checked by each operation. */
export async function lockedGroupRun(client: PoolClient, runId: string) {
  const row = (await client.query(`SELECT r.*,d.enabled,m.harness FROM agent_runs r
    JOIN conversation_work w ON w."runId"=r.id AND w.id=r.id AND w."agentId"=r."agentId"
    JOIN conversations c ON c.id=w."conversationId" AND c.kind='group'
    JOIN conversation_messages trigger ON trigger.id=w."triggerMessageId" AND trigger."conversationId"=c.id AND trigger."authorType"='user' AND trigger."authorId"=w."requestedBy"
    JOIN conversation_agent_grants g ON g.id=w."grantId" AND g."conversationId"=c.id AND g."agentId"=r."agentId" AND g."ownerId"=r."userId"
    JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId" AND a."deviceId"=r."deviceId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    JOIN session_mailboxes m ON m.id=r."mailboxId" AND m."userId"=r."userId" AND m."workspaceId"=c."workspaceId"::text
      AND m.kind='group' AND m."sessionKey"=w.id::text AND m."latestRunId"=r.id AND m.harness=a.harness AND NOT m.disabled
    WHERE r.id=$1 AND r.kind='group_review' AND r."issueId" IS NULL AND r."deviceRepoId" IS NULL
      AND r."sessionId" IS NULL AND r."worktreePath" IS NULL AND r."resumeSessionId" IS NULL AND r.prompt=''
    FOR UPDATE OF r FOR SHARE OF a,d,m,g,trigger`, [runId])).rows[0]
  if (!row) return reject(403, 'group_assignment_required')
  return row
}
