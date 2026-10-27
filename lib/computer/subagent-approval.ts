import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

type Actor = { userId: string; workspaceId: string }
export type BrowserAction = { action: 'navigate'; url: string } | { action: 'snapshot' } | { action: 'click'; ref: number } | { action: 'type'; text: string }

/** One approval covers exactly one immutable browser action. A consumed or
 * uncertain action cannot be retried, including after a workflow replay. */
export class SubagentApprovals {
  constructor(private readonly pool: Pool) {}

  async request(actor: Actor, botId: string, subagentId: string, operationKey: string, action: BrowserAction) {
    if (!operationKey || operationKey.length > 256) throw new Error('Invalid browser action')
    const key = createHash('sha256').update(operationKey).digest('hex')
    const encoded = JSON.stringify(action), digest = createHash('sha256').update(encoded).digest('hex')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const active = await client.query(`SELECT 1 FROM bot_subagents s WHERE s.id=$1 AND s."botId"=$2 AND s."ownerId"=$3 AND s."workspaceId"=$4
        AND s.state IN ('running','needs_you') AND s."stopRequestedAt" IS NULL AND s."haltedAt" IS NULL AND NOT EXISTS
        (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=s."workspaceId" AND p.permission='deny') FOR UPDATE`, [subagentId, botId, actor.userId, actor.workspaceId])
      if (!active.rowCount) throw new Error('Web task unavailable')
      const result = await client.query(`INSERT INTO bot_subagent_approvals (id,"subagentId","workspaceId","ownerId","botId","operationKey",digest,request,"expiresAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes') ON CONFLICT ("subagentId","operationKey")
        DO UPDATE SET "operationKey"=EXCLUDED."operationKey" WHERE bot_subagent_approvals.digest=EXCLUDED.digest
        RETURNING id,digest,state,"expiresAt",result`, [randomUUID(), subagentId, actor.workspaceId, actor.userId, botId, key, digest, encoded])
      if (!result.rowCount) throw new Error('Browser action changed')
      if (result.rows[0].state === 'pending') await client.query(`UPDATE bot_subagents SET state='needs_you',needs=$2 WHERE id=$1`, [subagentId, `Approval required: ${action.action}`])
      await client.query('COMMIT')
      return result.rows[0] as { id: string; digest: string; state: string; expiresAt: Date; result: unknown }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async pending(actor: Actor, botId: string, subagentId: string) {
    const result = await this.pool.query(`SELECT a.id,a.digest,a.request,a."expiresAt" FROM bot_subagent_approvals a
      JOIN bot_subagents s ON s.id=a."subagentId" AND s."ownerId"=a."ownerId" AND s."workspaceId"=a."workspaceId" AND s."botId"=a."botId"
      WHERE a."subagentId"=$1 AND a."botId"=$2 AND a."ownerId"=$3 AND a."workspaceId"=$4 AND a.state='pending'
        AND a."expiresAt">now() AND s."stopRequestedAt" IS NULL AND s."haltedAt" IS NULL AND s.state='needs_you'
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=s."workspaceId" AND p.permission='deny')
      ORDER BY a."createdAt" LIMIT 1`, [subagentId, botId, actor.userId, actor.workspaceId])
    return result.rows[0] ?? null
  }

  async status(actor: Actor, botId: string, subagentId: string, approvalId: string, digest: string) {
    const result = await this.pool.query(`SELECT CASE WHEN s."stopRequestedAt" IS NOT NULL OR s."haltedAt" IS NOT NULL OR s.state NOT IN ('running','needs_you')
        OR EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=s."workspaceId" AND p.permission='deny') THEN 'denied'
        WHEN a."expiresAt"<=now() AND a.state IN ('pending','approved') THEN 'expired' ELSE a.state END AS state,a.result
      FROM bot_subagent_approvals a JOIN bot_subagents s ON s.id=a."subagentId" AND s."ownerId"=a."ownerId" AND s."workspaceId"=a."workspaceId" AND s."botId"=a."botId"
      WHERE a.id=$1 AND a.digest=$2 AND a."subagentId"=$3 AND a."botId"=$4 AND a."ownerId"=$5 AND a."workspaceId"=$6`,
    [approvalId, digest, subagentId, botId, actor.userId, actor.workspaceId])
    return result.rows[0] as { state: string; result: unknown } | undefined
  }

  async decide(actor: Actor, botId: string, subagentId: string, approvalId: string, digest: string, approve: boolean) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const result = await client.query(`UPDATE bot_subagent_approvals a SET state=$6,"decidedAt"=now() FROM bot_subagents s
        WHERE a.id=$1 AND a.digest=$2 AND a."subagentId"=$3 AND a."botId"=$4 AND a."ownerId"=$5 AND a."workspaceId"=$7
          AND a.state='pending' AND a."expiresAt">now() AND s.id=a."subagentId" AND s."ownerId"=a."ownerId"
          AND s."workspaceId"=a."workspaceId" AND s."botId"=a."botId" AND s.state='needs_you' AND s."stopRequestedAt" IS NULL AND s."haltedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=a."workspaceId" AND p.permission='deny')
        RETURNING a.id`, [approvalId, digest, subagentId, botId, actor.userId, approve ? 'approved' : 'denied', actor.workspaceId])
      if (result.rowCount) await client.query(`UPDATE bot_subagents SET state='running',needs=NULL WHERE id=$1 AND "ownerId"=$2`, [subagentId, actor.userId])
      await client.query('COMMIT')
      return result.rowCount === 1
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** Exactly one caller may transition approved → executing. An executing
   * action has an unknown outcome after a crash and must not be run again. */
  async consume(actor: Actor, botId: string, subagentId: string, approvalId: string, digest: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      const result = await client.query(`UPDATE bot_subagent_approvals a SET state='executing' FROM bot_subagents s
        WHERE a.id=$1 AND a.digest=$2 AND a."subagentId"=$3 AND a."botId"=$4 AND a."ownerId"=$5 AND a."workspaceId"=$6
          AND a.state='approved' AND a."expiresAt">now() AND s.id=a."subagentId" AND s."ownerId"=a."ownerId"
          AND s."workspaceId"=a."workspaceId" AND s."botId"=a."botId" AND s.state='running' AND s."stopRequestedAt" IS NULL AND s."haltedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=a."workspaceId" AND p.permission='deny') RETURNING a.request`,
      [approvalId, digest, subagentId, botId, actor.userId, actor.workspaceId])
      await client.query('COMMIT')
      return result.rows[0]?.request as BrowserAction | undefined
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async complete(actor: Actor, botId: string, subagentId: string, approvalId: string, digest: string, result: unknown, uncertain = false) {
    const updated = await this.pool.query(`UPDATE bot_subagent_approvals SET state=$7,result=$8
      WHERE id=$1 AND digest=$2 AND "subagentId"=$3 AND "botId"=$4 AND "ownerId"=$5 AND "workspaceId"=$6 AND state='executing'`,
    [approvalId, digest, subagentId, botId, actor.userId, actor.workspaceId, uncertain ? 'uncertain' : 'completed', JSON.stringify(result ?? null)])
    return updated.rowCount === 1
  }
}
