import 'server-only'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { archiveLinearIssue, linearIssueArchiveState } from './client'
import { LinearApiError } from './graphql'
import { linearAccessToken } from './tokens'
import { withPublicationWriter } from './publication'

const targetSchema = z.object({
  ownerId: z.string().min(1), linearIssueId: z.string().min(1),
  teamSyncId: z.uuid().nullable(), linearTeamId: z.string().min(1).nullable(),
  sourceLinkId: z.uuid().nullable(), publicationId: z.uuid().nullable(),
  organizationId: z.string().min(1).nullable(), targetVerified: z.boolean(),
}).strict()
type ArchiveTarget = z.infer<typeof targetSchema>
export interface LinearArchiveJob { id: string; issueId: string; scopeVersion: number; claimToken: string; archiveTarget: unknown }
const unavailable = () => new LinearApiError('Linear archive authorization or frozen target is unavailable', false)
const unconfirmed = () => new LinearApiError('Linear archive outcome is unconfirmed; readback required', true)

/** Same issue -> claim lock order as scope retirement. No provider IO is made
 * while holding these short database locks. Frozen targets are immutable. */
async function withArchiveFence<T>(job: LinearArchiveJob, work: (client: PoolClient, target: ArchiveTarget) => Promise<T>): Promise<T> {
  const target = targetSchema.parse(job.archiveTarget)
  if (!target.targetVerified || !target.teamSyncId || !target.linearTeamId || !target.sourceLinkId) throw unavailable()
  const client = await pool.connect()
  try {
    await client.query('begin')
    const issue = (await client.query('select "userId","scopeVersion" from issues where id=$1 for share', [job.issueId])).rows[0]
    const claimed = (await client.query('select operation,status,"claimToken","scopeVersion","archiveTarget" from linear_sync_outbox where id=$1 and "issueId"=$2 for share', [job.id, job.issueId])).rows[0]
    if (!issue || issue.userId !== target.ownerId || issue.scopeVersion <= job.scopeVersion || !claimed || claimed.operation !== 'archive' || claimed.status !== 'processing' || claimed.claimToken !== job.claimToken || claimed.scopeVersion !== job.scopeVersion || JSON.stringify(targetSchema.parse(claimed.archiveTarget)) !== JSON.stringify(target)) throw unavailable()
    const proof = (await client.query(`select d."archivedAt",t."ownerId",t."linearTeamId",c."organizationId",c."revokedAt",
      p."scopeVersion" as "publicationScopeVersion",p."retiredAt"
      from linear_issue_detachments d join linear_team_syncs t on t.id=d."teamSyncId"
      join linear_connections c on c."userId"=d."ownerId"
      left join linear_issue_publications p on p.id=d."publicationId"
      where d."linearIssueId"=$1 and d."issueId"=$2 and d."ownerId"=$3 and d."teamSyncId"=$4
        and d."sourceLinkId"=$5 and d."publicationId" is not distinct from $6::uuid and d."externalTargetVerified"
        and not exists(select 1 from linear_issue_links l where l."linearIssueId"=d."linearIssueId")`,
    [target.linearIssueId, job.issueId, target.ownerId, target.teamSyncId, target.sourceLinkId, target.publicationId])).rows[0]
    if (!proof || proof.ownerId !== target.ownerId || proof.linearTeamId !== target.linearTeamId || proof.revokedAt || target.organizationId && proof.organizationId !== target.organizationId || target.publicationId && (proof.publicationScopeVersion !== job.scopeVersion || !proof.retiredAt)) throw unavailable()
    const result = await work(client, target)
    await client.query('commit')
    return result
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
}

/** An archive is an explicit owner cleanup request, independent of whether
 * ordinary bidirectional sync is enabled. It never creates or deletes issues. */
export async function processLinearArchiveJob(job: LinearArchiveJob) {
  const target = targetSchema.parse(job.archiveTarget)
  await withArchiveFence(job, async () => {})
  return withPublicationWriter(target.publicationId ?? target.linearIssueId, async () => {
    const token = await linearAccessToken(target.ownerId)
    const current = () => withArchiveFence(job, async () => {})
    await current()
    let observed = await linearIssueArchiveState(token, target.linearIssueId)
    if (!observed || observed.id !== target.linearIssueId || observed.team?.id !== target.linearTeamId) throw unconfirmed()
    if (observed.archivedAt === null) {
      await archiveLinearIssue(token, target.linearIssueId, current)
      observed = await linearIssueArchiveState(token, target.linearIssueId)
    }
    if (!observed || observed.id !== target.linearIssueId || observed.team?.id !== target.linearTeamId || typeof observed.archivedAt !== 'string' || !Number.isFinite(Date.parse(observed.archivedAt))) throw unconfirmed()
    const archivedAt = new Date(observed.archivedAt)
    await withArchiveFence(job, async client => {
      await client.query('update linear_issue_detachments set "archivedAt"=coalesce("archivedAt",$2) where "linearIssueId"=$1', [target.linearIssueId, archivedAt])
      await client.query(`update linear_sync_outbox set status='done',"claimToken"=null,"lastError"=null,"updatedAt"=now() where id=$1`, [job.id])
    })
  })
}
