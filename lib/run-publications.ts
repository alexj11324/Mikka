import 'server-only'
import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { reachesReview, runReport, type RunReport, type RunCompleteRequest } from '@mikka/protocol/run'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { remoteKey } from '@mikka/protocol/repository'
import { db } from '@/lib/db'
import { agentRuns, devices, issues, issueVersions, runPublications, runTokens, type RunStatus } from '@/lib/db/schema'
import { readRepositorySettings } from '@/lib/device-repositories'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { issueForUser } from '@/lib/issue-access'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { publicationBranch, publicationGate, repositoryPushApproved } from '@/lib/run-publication-policy'
import { linkedGitHubAccountId, saveRepositoryInstallation } from '@/lib/github/repository-installation'
import { openRunPullRequest, PublicationError, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/github/run-pull-request'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Run = typeof agentRuns.$inferSelect
type Publication = typeof runPublications.$inferSelect
const LIVE = ['queued', 'preparing', 'running', 'waiting_input', 'finishing']
const TERMINAL_PUBLICATIONS = ['published', 'blocked', 'skipped']
const PUBLICATION_LEASE_MS = 120_000
const MAX_ATTEMPTS = 5

function reportOf(run: Run): RunReport | null {
  const parsed = runReport.safeParse(run.report)
  return parsed.success ? parsed.data : null
}

/** Pin the task's branch and explicit repository approval before claiming it. */
export async function prepareRunPublication(run: Pick<Run, 'id' | 'userId' | 'issueId' | 'baseBranch'>, remoteUrl: string) {
  if (!run.issueId) throw new PublicationError('issue_unavailable')
  const issueId = run.issueId
  const key = remoteKey(remoteUrl)
  const settings = await readRepositorySettings(run.userId, remoteUrl)
  const pushApproved = repositoryPushApproved(settings?.push, run.userId)
  const task = await issueForUser(run.userId, issueId)
  if (!task) throw new PublicationError('issue_unavailable')
  const row = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + issueId}, 0))`)
    const [existing] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, run.id), eq(runPublications.userId, run.userId)))
    if (existing) {
      if (existing.remoteKey !== key || existing.issueId !== issueId) throw new PublicationError('publication_mismatch')
      const [refreshed] = await tx.update(runPublications).set({ pushApproved, updatedAt: new Date() }).where(and(eq(runPublications.runId, run.id), eq(runPublications.status, 'assigned'))).returning()
      return refreshed ?? existing
    }
    const [previous] = await tx.select().from(runPublications)
      .where(and(eq(runPublications.issueId, issueId), eq(runPublications.remoteKey, key), sql`${runPublications.branch} is not null`))
      .orderBy(asc(runPublications.createdAt)).limit(1)
    const identifiers = await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number }], tx)
    const identifier = previous?.identifier ?? identifiers.get(issueId) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (branch) {
      // Personal identifiers are only unique per owner. Reserve the shared
      // repository branch across tasks before any daemon can fetch or push it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + key + ':' + branch}, 0))`)
      const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications)
        .where(and(eq(runPublications.remoteKey, key), eq(runPublications.branch, branch), ne(runPublications.issueId, issueId))).limit(1)
      if (collision) throw new PublicationError('pull_request_conflict')
    }
    const [saved] = await tx.insert(runPublications).values({ runId: run.id, userId: run.userId, issueId, remoteUrl, remoteKey: key, identifier, branch, baseBranch: run.baseBranch, pushApproved }).returning()
    return saved
  })
  const policy = defaultRunPolicy()
  // Repository approval is sent only in this assignment, never inherited from
  // a stale /repos snapshot. The remaining permissions keep their defaults.
  policy.permissions.git_push = row.branch && row.pushApproved ? 'allow' : 'ask'
  return { ...(row.branch ? { pushBranch: row.branch } : {}), policy }
}

/** Preserve concurrent task edits; result, history and inbox commit together. */
async function finishResult(tx: Transaction, run: Run, publication?: { pullRequest?: PublishedPullRequest | null; errorCode?: PublicationErrorCode | null; branch?: string | null }, attachPullRequest = true) {
  const report = reportOf(run)
  if (run.issueId) {
    const [task] = await tx.select().from(issues).where(eq(issues.id, run.issueId)).for('update')
    const accessible = task && (task.userId === run.userId || await issueForUser(run.userId, task.id))
    if (task && accessible && !readIssueMetadata(task.content).deletedAt) {
      const metadata = readIssueMetadata(task.content)
      const pr = attachPullRequest ? publication?.pullRequest : null
      let content = task.content
      if (pr) {
        const found = metadata.pullRequests.some(existing => existing.url.replace(/\/$/, '') === pr.url)
        if (!found && metadata.pullRequests.length >= 10) throw new PublicationError('pull_request_limit')
        const pullRequests = found ? metadata.pullRequests.map(existing => existing.url.replace(/\/$/, '') === pr.url ? pr : existing) : [...metadata.pullRequests, pr]
        content = withIssueMetadata(task.content, { ...metadata, pullRequests })
      }
      const status = run.stopReason === 'submitted' && reachesReview('submitted', report ?? undefined) && !['done', 'cancelled', 'canceled'].includes(task.status) ? 'review' : task.status
      if (status !== task.status || JSON.stringify(content) !== JSON.stringify(task.content)) {
        const [saved] = await tx.update(issues).set({ content, status, revision: task.revision + 1, updatedAt: new Date() }).where(eq(issues.id, task.id)).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, actorType: 'system', actorId: 'run-result' })
      }
    } else if (attachPullRequest && publication?.pullRequest) throw new PublicationError('issue_unavailable')
  }
  await recordCoordinatorEvent(tx, runFinishedEvent({ ...run, stopReason: run.stopReason ?? 'error', report, publication }))
}

/**
 * Accept the first report and revoke worker credentials atomically. A replay
 * uses that frozen report even if a daemon sends different data afterward.
 */
export async function persistRunCompletion(userId: string, runId: string, completion: RunCompleteRequest, scopeDeviceId?: string | null) {
  return db.transaction(async tx => {
    const [owned] = await tx.select({ run: agentRuns }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId), eq(devices.ownerId, userId), ...(scopeDeviceId ? [eq(devices.id, scopeDeviceId)] : []))).for('update', { of: agentRuns })
    if (!owned) return null
    let run = owned.run
    const firstCompletion = LIVE.includes(run.status)
    const [publication] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, runId), eq(runPublications.userId, userId))).for('update')
    if (firstCompletion) {
      let status: RunStatus = runStateForStop(completion.stopReason)
      if (completion.stopReason === 'submitted' && completion.report?.verify.status === 'failed' && run.kind !== 'plan') status = 'failed'
      ;[run] = await tx.update(agentRuns).set({ status, stopReason: completion.stopReason, report: completion.report ?? null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentRuns.id, runId)).returning()
      await tx.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.runId, runId), isNull(runTokens.revokedAt)))
    }
    // A lease-expired/explicitly stopped run cannot be resurrected by a late completion.
    if (!publication) {
      if (firstCompletion) await finishResult(tx, run)
      return { userId, issueId: run.issueId, publicationPending: false }
    }
    if (publication.status === 'assigned') {
      const gate = publicationGate({ stopReason: run.stopReason, kind: run.kind, report: reportOf(run), assignment: publication })
      await tx.update(runPublications).set({ status: gate.state, errorCode: gate.state === 'blocked' ? gate.error : null, updatedAt: new Date() }).where(eq(runPublications.runId, runId))
      if (gate.state !== 'pending') await finishResult(tx, run, { errorCode: gate.state === 'blocked' ? gate.error : null, branch: publication.branch })
      return { userId, issueId: run.issueId, publicationPending: gate.state === 'pending' }
    }
    return { userId, issueId: run.issueId, publicationPending: !TERMINAL_PUBLICATIONS.includes(publication.status) }
  })
}

async function claimPublication(runId: string) {
  const now = new Date()
  const [claimed] = await db.update(runPublications).set({ status: 'processing', leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(now.getTime() + PUBLICATION_LEASE_MS), attempts: sql`${runPublications.attempts} + 1`, updatedAt: now })
    .where(and(eq(runPublications.runId, runId), or(eq(runPublications.status, 'pending'), and(eq(runPublications.status, 'processing'), lte(runPublications.leaseExpiresAt, now)))))
    .returning()
  return claimed ?? null
}

async function settlePublication(claim: Publication, result: { pullRequest?: PublishedPullRequest; errorCode?: PublicationErrorCode }) {
  return db.transaction(async tx => {
    const [current] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, claim.runId), eq(runPublications.leaseToken, claim.leaseToken!))).for('update')
    if (!current) return false
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId)))
    if (!run) return false
    try {
      await finishResult(tx, run, { ...result, branch: claim.branch })
    } catch (error) {
      if (!(error instanceof PublicationError) || !result.pullRequest) throw error
      // GitHub has already created it. Keep the link in both receipt and chat
      // even if the task was deleted or filled its metadata capacity meanwhile.
      result = { ...result, errorCode: error.code }
      await finishResult(tx, run, { ...result, branch: claim.branch }, false)
    }
    await tx.update(runPublications).set({ status: result.pullRequest ? 'published' : 'blocked', pullRequest: result.pullRequest ?? null, errorCode: result.errorCode ?? null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(runPublications.runId, claim.runId))
    return true
  })
}

/** A Workflow step calls this; the DB lease also protects duplicate workflows. */
export async function publishRunResult(runId: string, openPullRequest = openRunPullRequest): Promise<{ done: boolean }> {
  const claim = await claimPublication(runId)
  if (!claim) {
    const [row] = await db.select({ status: runPublications.status }).from(runPublications).where(eq(runPublications.runId, runId))
    return { done: !row || TERMINAL_PUBLICATIONS.includes(row.status) }
  }
  try {
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, claim.userId)))
    const report = run ? reportOf(run) : null
    if (!run || !report?.publish?.commit || !claim.branch || !claim.identifier) throw new PublicationError('publication_mismatch')
    if (!await issueForUser(claim.userId, claim.issueId)) throw new PublicationError('issue_unavailable')
    const settings = await readRepositorySettings(claim.userId, claim.remoteUrl)
    if (!claim.pushApproved || !repositoryPushApproved(settings?.push, claim.userId)) throw new PublicationError('push_not_approved')
    const [task] = await db.select({ title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, claim.issueId))
    if (!task) throw new PublicationError('issue_unavailable')
    const pullRequest = await openPullRequest({ remoteKey: claim.remoteKey, githubAccountId: await linkedGitHubAccountId(claim.userId), issueId: claim.issueId, identifier: claim.identifier, title: task.title, summary: report.summary, branch: claim.branch, commit: report.publish.commit, baseBranch: claim.baseBranch, draft: report.verify.status === 'not_run', allowCreate: readIssueMetadata(task.content).pullRequests.length < 10, onVerified: binding => saveRepositoryInstallation(claim.userId, claim.remoteKey, binding) })
    return { done: await settlePublication(claim, { pullRequest }) }
  } catch (error) {
    if (!(error instanceof PublicationError)) throw error
    if (error.retryable && claim.attempts < MAX_ATTEMPTS) {
      await db.update(runPublications).set({ status: 'pending', errorCode: error.code, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(runPublications.runId, runId), eq(runPublications.leaseToken, claim.leaseToken!)))
      return { done: false }
    }
    return { done: await settlePublication(claim, { errorCode: error.code }) }
  }
}

/** The durable workflow's exhausted-error path still produces a chat result. */
export async function failRunPublication(runId: string): Promise<{ done: boolean }> {
  const claim = await claimPublication(runId)
  if (claim) return { done: await settlePublication(claim, { errorCode: 'github_unavailable' }) }
  const row = await publicationDelivery(runId)
  return { done: !row || TERMINAL_PUBLICATIONS.includes(row.status) }
}

/** Lookup for Workflow launch/delivery. Never returns credentials or daemon report prose. */
export async function publicationDelivery(runId: string) {
  const [row] = await db.select({ userId: runPublications.userId, issueId: runPublications.issueId, status: runPublications.status, workflowRunId: runPublications.workflowRunId }).from(runPublications).where(eq(runPublications.runId, runId))
  return row ?? null
}

export async function rememberPublicationWorkflow(runId: string, workflowRunId: string) {
  await db.update(runPublications).set({ workflowRunId, updatedAt: new Date() }).where(and(eq(runPublications.runId, runId), isNull(runPublications.workflowRunId)))
}
