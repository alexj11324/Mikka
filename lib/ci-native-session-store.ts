import 'server-only'
import type { Pool } from 'pg'
import { openCiSession, sealCiSession, type CiSessionScope } from './ci-session-envelope'
import { acquireCiMembership, ciIssueAuthorized } from './github/ci/authority'
import { readIssueMetadata } from './issue-metadata'
import { lockSubscriptionBinding } from './subscription-binding-lock'

type Context = { ownerId: string; deviceId: string; runId: string; accountId: string; revision: number; route: string; modelId: string }
const unavailable = (): never => { throw new Error('CI session snapshot unavailable') }

/** A snapshot is written only by a live hosted run and read only by its
 * server-bound CI child. Both paths hold the connection row through commit so
 * disconnect/reconnect cannot race the release of session material. */
export async function nativeSessionSnapshot(pool: Pool, context: Context, operation: { kind: 'save'; sessionId: string; data: Buffer } | { kind: 'restore' }, secret: string): Promise<Buffer | null> {
  const {rows:[hint]} = await pool.query(`SELECT i.id,i."userId",r."agentId" FROM agent_runs r JOIN issues i ON i.id=r."issueId" WHERE r.id=$1 AND r."userId"=$2`,[context.runId,context.ownerId])
  if (!hint) unavailable()
  const membership = await acquireCiMembership(hint.id, context.ownerId, hint.userId)
  const tx = await pool.connect().catch(async error => { await membership.close(); throw error })
  try {
    await tx.query('BEGIN')
    const {rows:[issue]} = await tx.query(`SELECT id,"userId",scope,"scopeVersion",content FROM issues WHERE id=$1 FOR UPDATE`,[hint.id])
    await lockSubscriptionBinding(tx, context.ownerId, hint.agentId, context.route)
    const { rows: [r] } = await tx.query(`SELECT r.id,r."issueId",r."sessionId",r."ciContinuation",r."agentId",r."agentDefinition",b.id AS "bindingId",b."ownerId",b."workspaceId",b."consumerId",b.route,b."modelId",b."connectionRevision",c.epoch,c.state
      FROM agent_runs r JOIN byos_native_runs n ON n."runId"=r.id
      JOIN byos_bindings b ON b.id=n."bindingId" JOIN byos_connections c ON c.id=b."connectionId"
      WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND r.status IN ('preparing','running','waiting_input') AND r."leaseExpiresAt">now() AND r."stopRequestedAt" IS NULL
      AND b."ownerId"=$2 AND b."consumerId"=r."agentId"::text AND c."ownerId"=b."ownerId" AND c."workspaceId"=b."workspaceId"
      AND b.id=(SELECT latest.id FROM byos_bindings latest WHERE latest."ownerId"=b."ownerId" AND latest."consumerId"=b."consumerId" AND latest.route=b.route ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1)
      FOR UPDATE OF r FOR SHARE OF b,c`, [context.runId, context.ownerId, context.deviceId])
    if (!r || r.state !== 'connected' || Number(r.epoch) !== context.revision || Number(r.connectionRevision) !== context.revision || r.route !== context.route || r.modelId !== context.modelId) unavailable()
    const scopeVersion = operation.kind === 'restore' ? r.ciContinuation?.scopeVersion : issue?.scopeVersion
    if (!ciIssueAuthorized(issue,context.ownerId,scopeVersion,membership.held,value => Boolean(readIssueMetadata(value as never).deletedAt))) unavailable()
    const current = { ownerId: r.ownerId, workspaceId: r.workspaceId, consumerId: r.consumerId, bindingId: r.bindingId, accountId: context.accountId, route: r.route, revision: context.revision, modelId: r.modelId }
    let result: Buffer | null = null
    if (operation.kind === 'save') {
      // The daemon's session-id status patch may still be in its outbox. A
      // conflicting persisted ID is refused; restore always requires the
      // origin's subsequently persisted ID to match the encrypted scope.
      if (r.sessionId && r.sessionId !== operation.sessionId) unavailable()
      const scope: CiSessionScope = { ...current, runId: context.runId, sessionId: operation.sessionId }
      const ciphertext = sealCiSession(scope, operation.data, secret)
      await tx.query(`INSERT INTO ci_native_sessions ("runId",ciphertext) VALUES ($1,$2) ON CONFLICT ("runId") DO UPDATE SET ciphertext=EXCLUDED.ciphertext,"createdAt"=now()`, [context.runId, ciphertext])
    } else {
      const c = r.ciContinuation
      if (!c || c.requireSessionResume !== true || typeof c.originRunId !== 'string' || typeof c.originSessionId !== 'string') unavailable()
      const { rows: [origin] } = await tx.query(`SELECT r."sessionId",r."agentId",r."deviceId",r."issueId",r."agentDefinition",n."bindingId",s.ciphertext FROM agent_runs r JOIN byos_native_runs n ON n."runId"=r.id JOIN ci_native_sessions s ON s."runId"=r.id WHERE r.id=$1 AND r."userId"=$2 AND r."stopRequestedAt" IS NULL FOR SHARE OF r`, [c.originRunId, context.ownerId])
      if (!origin || origin.sessionId !== c.originSessionId || origin.agentId !== r.agentId || origin.issueId !== r.issueId || origin.deviceId !== context.deviceId || origin.bindingId !== r.bindingId || !r.agentDefinition?.definitionDigest || origin.agentDefinition?.definitionDigest !== r.agentDefinition.definitionDigest) unavailable()
      result = openCiSession({ ...current, runId: c.originRunId, sessionId: c.originSessionId }, origin.ciphertext, secret)
    }
    await membership.check()
    await tx.query('COMMIT')
    await membership.check()
    return result
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release(); await membership.close() }
}
