import type { Pool, PoolClient } from 'pg'
import type { Binding, Principal } from './contracts'
import type { CredentialAuthority } from './broker'
import { readIssueMetadata } from '../issue-metadata'

/** Both databases are checked on every admission. Never trust the active-workspace cookie. */
export class PostgresCredentialAuthority implements CredentialAuthority {
  constructor(private readonly app: Pool, private readonly workspace: Pool) {}
  async resolve(principal: Principal, workspaceId: string, runId: string, client?: PoolClient): Promise<Binding | null> {
    const { rows } = await (client ?? this.app).query(`SELECT r."issueId", r."sessionId", i.content FROM agent_runs r
      JOIN issues i ON i.id=r."issueId" JOIN devices d ON d.id=r."deviceId"
      JOIN "user" u ON u.id=r."userId"
      JOIN "session" s ON s.id=$3 AND s."userId"=r."userId" AND s."expiresAt">now()
      WHERE r.id=$1 AND r."userId"=$2 AND i."userId"=$2 AND d."ownerId"=$2 AND d.enabled
      AND d."lastSeenAt">now()-interval '60 seconds'
      AND r.status IN ('running','waiting_input') AND r."stopRequestedAt" IS NULL
      AND r."leaseExpiresAt">now() AND r."sessionId" IS NOT NULL AND r."sessionId"<>''`,
    [runId, principal.ownerId, principal.authSessionId])
    const run = rows[0]
    if (!run || readIssueMetadata(run.content).deletedAt) return null
    const membership = await this.workspace.query(`SELECT m."userId" FROM mikka_workspace_members m
      JOIN mikka_workspaces w ON w.id=m."workspaceId"
      JOIN orvilo_team_issues t ON t."workspaceId"=m."workspaceId" AND t."issueId"=$3
      WHERE m."workspaceId"=$1 AND m."userId"=$2 AND m.status='active'`, [workspaceId, principal.ownerId, run.issueId])
    if (!membership.rowCount) return null
    return { ...principal, workspaceId, runId, taskId: run.issueId, executionSession: run.sessionId }
  }
}
