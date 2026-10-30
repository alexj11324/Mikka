import 'server-only'
import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { reachesReview, runReport, type RunReport, type RunCompleteRequest } from '@mikka/protocol/run'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { remoteKey } from '@mikka/protocol/repository'
import { db, pool, withDatabaseClient, withDatabaseTransaction } from '@/lib/db'
import { agentRuns, devices, issues, issueVersions, repositorySettings, runPublications, runTokens, type RunStatus } from '@/lib/db/schema'
import { readRepositorySettings } from '@/lib/device-repositories'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { systemActor } from '@/lib/activity-actor'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { publicationBranch, publicationGate, repositoryPushApproved } from '@/lib/run-publication-policy'
import { linkedGitHubAccountId, saveRepositoryInstallation } from '@/lib/github/repository-installation'
import { openRunPullRequest, PublicationError, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/github/run-pull-request'
import { matchesRepositoryAdmission } from './repository-admission'
import { mayCompleteIssue } from './run-completion'
import { lockFactoryCompletionTasks, lockCompletionSkillScopes, prepareRunCompletionEffects, settleRunCompletionEffects } from './run-completion-effects'

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
export async function prepareRunPublication(run: Pick<Run, 'id' | 'userId' | 'issueId' | 'baseBranch'> & Partial<Pick<Run, 'agentDefinition' | 'deviceId' | 'agentId' | 'botId'>>, remoteUrl: string) {
  if (!run.issueId) throw new PublicationError('issue_unavailable')
  const issueId = run.issueId
  const key = remoteKey(remoteUrl)
  const settings = await readRepositorySettings(run.userId, remoteUrl)
  const admission = run.agentDefinition?.repositoryAdmission
  const accepted = admission && run.deviceId && run.agentId && matchesRepositoryAdmission(admission, {
    userId: run.userId, issueId, deviceId: run.deviceId, agentId: run.agentId, remoteKey: key, remoteUrl, targetBranch: admission.targetBranch,
    workspaceId: admission.workspaceId, workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
  }) && await (await import('./run-admission-store')).acceptedEventStillMatches(admission, run.botId ?? null)
  if (admission && !accepted) throw new PublicationError('publication_mismatch')
  const pushApproved = Boolean(accepted) || repositoryPushApproved(settings?.push, run.userId)
  const row = await db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
    if (!task || !await mayCompleteIssue(task, run.userId)) throw new PublicationError('issue_unavailable')
    const [currentRun] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, run.id), eq(agentRuns.userId, run.userId), eq(agentRuns.issueId, issueId))).for('update')
    if (!currentRun) throw new PublicationError('issue_unavailable')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + issueId}, 0))`)
    const [existing] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, run.id), eq(runPublications.userId, run.userId)))
    if (existing) {
      if (existing.remoteKey !== key || existing.issueId !== issueId) throw new PublicationError('publication_mismatch')
      if (existing.scopeVersion === null || existing.issueTitle === null || (task.userId !== run.userId && existing.scopeVersion !== task.scopeVersion)) throw new PublicationError('issue_unavailable')
      if (admission && (existing.branch !== admission.targetBranch || !existing.pushApproved)) throw new PublicationError('publication_mismatch')
      if (accepted) return existing
      const [refreshed] = await tx.update(runPublications).set({ pushApproved, updatedAt: new Date() }).where(and(eq(runPublications.runId, run.id), eq(runPublications.status, 'assigned'))).returning()
      return refreshed ?? existing
    }
    const [previous] = await tx.select().from(runPublications)
      .where(and(eq(runPublications.issueId, issueId), eq(runPublications.remoteKey, key), sql`${runPublications.branch} is not null`))
      .orderBy(asc(runPublications.createdAt)).limit(1)
    const identifiers = await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number }], tx)
    const identifier = previous?.identifier ?? identifiers.get(issueId) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (admission && branch !== admission.targetBranch) throw new PublicationError('publication_mismatch')
    if (branch) {
      // Personal identifiers are only unique per owner. Reserve the shared
      // repository branch across tasks before any daemon can fetch or push it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + key + ':' + branch}, 0))`)
      const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications)
        .where(and(eq(runPublications.remoteKey, key), eq(runPublications.branch, branch), ne(runPublications.issueId, issueId))).limit(1)
      if (collision) throw new PublicationError('pull_request_conflict')
    }
    const [saved] = await tx.insert(runPublications).values({ runId: run.id, userId: run.userId, issueId, scopeVersion: task.scopeVersion, issueTitle: task.title, remoteUrl, remoteKey: key, identifier, branch, baseBranch: run.baseBranch, pushApproved }).returning()
    return saved
  })
  const policy = defaultRunPolicy()
  // Repository approval is sent only in this assignment, never inherited from
  // a stale /repos snapshot. The remaining permissions keep their defaults.
  policy.permissions.git_push = row.branch && row.pushApproved ? 'allow' : 'ask'
  return { ...(row.branch ? { pushBranch: row.branch } : {}), policy }
}

/** Preserve concurrent task edits; result, history and inbox commit together. */
async function finishResult(tx: Transaction, run: Run, publication?: { pullRequest?: PublishedPullRequest | null; errorCode?: PublicationErrorCode | null; branch?: string | null }, attachPullRequest = true, expectedScopeVersion?: number | null) {
  const report = reportOf(run)
  let review: { id: string; scopeVersion: number } | null = null
  if (run.issueId) {
    const [task] = await tx.select().from(issues).where(eq(issues.id, run.issueId)).for('update')
    const accessible = task && (expectedScopeVersion === undefined || task.scopeVersion === expectedScopeVersion) && await mayCompleteIssue(task, run.userId)
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
      const status = run.status === 'succeeded' && run.stopReason === 'submitted' && reachesReview('submitted', report ?? undefined) && !['done', 'cancelled', 'canceled'].includes(task.status) ? 'review' : task.status
      if (status !== task.status || JSON.stringify(content) !== JSON.stringify(task.content)) {
        const [saved] = await tx.update(issues).set({ content, status, revision: task.revision + 1, updatedAt: new Date() }).where(eq(issues.id, task.id)).returning()
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...systemActor('run-result') })
        if (saved.status === 'review') review = { id: saved.id, scopeVersion: saved.scopeVersion }
      }
    } else if (attachPullRequest && publication?.pullRequest) throw new PublicationError('issue_unavailable')
  }
  await recordCoordinatorEvent(tx, runFinishedEvent({ ...run, stopReason: run.stopReason ?? 'error', report, publication }))
  return review
}

/**
 * Accept the first report and revoke worker credentials atomically. A replay
 * uses that frozen report even if a daemon sends different data afterward.
 */
export async function persistRunCompletion(userId: string, runId: string, completion: RunCompleteRequest, scopeDeviceId?: string | null) {
  for (let attempt = 0; ; attempt++) {
    try { return await completionTransaction(userId, runId, completion, scopeDeviceId) }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function completionTransaction(userId: string, runId: string, completion: RunCompleteRequest, scopeDeviceId?: string | null) {
  const client = await pool.connect()
  try { return await withDatabaseClient(client, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    // Factory writers take task -> issue -> skill scope -> run; retirement
    // takes issue -> run. Read hints choose locks only; recheck all bindings
    // and authorization after locking, including dedicated-device scope.
    const owner = and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId), eq(devices.ownerId, userId), ...(scopeDeviceId ? [eq(devices.id, scopeDeviceId)] : []))
    const [hint] = await tx.select({ issueId: agentRuns.issueId, deviceRepoId: agentRuns.deviceRepoId }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId)).where(owner).limit(1)
    if (!hint) return null
    const factoryBound = await lockFactoryCompletionTasks(client, userId, runId)
    const [issue] = hint.issueId ? await tx.select().from(issues).where(eq(issues.id, hint.issueId)).for('update') : []
    await lockCompletionSkillScopes(client, userId, runId, hint, factoryBound)
    const [owned] = await tx.select({ run: agentRuns }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(owner).for('update', { of: agentRuns })
    if (!owned || owned.run.issueId !== hint.issueId || owned.run.deviceRepoId !== hint.deviceRepoId) return null
    let run = owned.run
    const firstCompletion = LIVE.includes(run.status)
    if (run.issueId && (!issue || !await mayCompleteIssue(issue, run.userId))) {
      // Retirement already ended this run and revoked its credentials. Accept
      // the outbox replay without writing a result, event or publication.
      return firstCompletion ? null : { userId, issueId: null, publicationPending: false, review: null }
    }
    const [publication] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, runId), eq(runPublications.userId, userId))).for('update')
    if (firstCompletion) {
      const report = await prepareRunCompletionEffects(client, run, completion, factoryBound)
      let status: RunStatus = runStateForStop(completion.stopReason)
      if (completion.stopReason === 'submitted' && run.kind !== 'plan') {
        if (report?.verify.status === 'failed') status = 'failed'
        else if (report?.verify.status !== 'passed') {
          const gate = publicationGate({ stopReason: completion.stopReason, kind: run.kind, report: report ?? null, assignment: publication ?? null })
          if (gate.state !== 'pending') status = 'stopped'
        }
      }
      ;[run] = await tx.update(agentRuns).set({ status, stopReason: completion.stopReason, report: report ?? null, finishedAt: sql`clock_timestamp()`, updatedAt: new Date() }).where(eq(agentRuns.id, runId)).returning()
      await tx.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.runId, runId), isNull(runTokens.revokedAt)))
      await settleRunCompletionEffects(client, run, completion.stopReason, factoryBound)
    }
    // A lease-expired/explicitly stopped run cannot be resurrected by a late completion.
    if (!publication) {
      const review = firstCompletion ? await finishResult(tx, run) : null
      return { userId, issueId: run.issueId, publicationPending: false, review }
    }
    if (publication.status === 'assigned') {
      const gate = publicationGate({ stopReason: run.stopReason, kind: run.kind, report: reportOf(run), assignment: publication })
      await tx.update(runPublications).set({ status: gate.state, errorCode: gate.state === 'blocked' ? gate.error : null, updatedAt: new Date() }).where(eq(runPublications.runId, runId))
      const review = gate.state !== 'pending' ? await finishResult(tx, run, { errorCode: gate.state === 'blocked' ? gate.error : null, branch: publication.branch }, true, publication.scopeVersion) : null
      return { userId, issueId: run.issueId, publicationPending: gate.state === 'pending', review }
    }
    return { userId, issueId: run.issueId, publicationPending: !TERMINAL_PUBLICATIONS.includes(publication.status), review: null }
  }))) } finally { client.release() }
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
    await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, claim.issueId)).for('update')
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId))).for('update')
    if (!run || run.issueId !== claim.issueId) return false
    const [current] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, claim.runId), eq(runPublications.leaseToken, claim.leaseToken!))).for('update')
    if (!current) return false
    try {
      await finishResult(tx, run, { ...result, branch: claim.branch }, true, claim.scopeVersion)
    } catch (error) {
      if (!(error instanceof PublicationError) || !result.pullRequest) throw error
      // GitHub has already created it. Keep the link in both receipt and chat
      // even if the task was deleted or filled its metadata capacity meanwhile.
      result = { ...result, errorCode: error.code }
      await finishResult(tx, run, { ...result, branch: claim.branch }, false, claim.scopeVersion)
    }
    if (result.pullRequest && !result.errorCode) {
      const { registerCiPublication } = await import('@/lib/github/ci/register')
      await registerCiPublication(tx, { userId: claim.userId, issueId: claim.issueId, remoteKey: claim.remoteKey, runId: claim.runId, scopeVersion: claim.scopeVersion, url: result.pullRequest.url, state: result.pullRequest.state, ciOriginRunId: run.ciContinuation?.originRunId })
    }
    await tx.update(runPublications).set({ status: result.pullRequest ? 'published' : 'blocked', pullRequest: result.pullRequest ?? null, errorCode: result.errorCode ?? null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(runPublications.runId, claim.runId))
    return true
  })
}

/** Freeze authorized inputs and revalidate them immediately around each
 * external mutation. Workspace locks precede app locks, as team promotion
 * does; application locks always follow issue -> run -> publication. The
 * provider callback encloses only its existing eight-second HTTP write. */
async function withPublicationAuthority<T>(claim: Publication, work: (value: { publication: Publication; run: Run; report: RunReport; allowCreate: boolean }) => Promise<T>): Promise<T> {
  const [hint] = await db.select({ userId: issues.userId }).from(issues).where(eq(issues.id, claim.issueId)).limit(1)
  if (!hint) throw new PublicationError('issue_unavailable')
  const apply = (membershipHeld: boolean) => db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '8s'`)
    const [task] = await tx.select().from(issues).where(eq(issues.id, claim.issueId)).for('update')
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId))).for('update')
    const [publication] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, claim.runId), eq(runPublications.leaseToken, claim.leaseToken!))).for('update')
    if (!task || !run || run.issueId !== task.id || !publication || publication.status !== 'processing' || !publication.leaseExpiresAt || publication.leaseExpiresAt.getTime() <= Date.now()) throw new PublicationError('issue_unavailable')
    if (publication.scopeVersion === null || publication.issueTitle === null || readIssueMetadata(task.content).deletedAt) throw new PublicationError('issue_unavailable')
    // The owner keeps authority over their own task after a scope change.
    // A teammate's old grant cannot revive when the task is promoted again.
    if (task.userId !== claim.userId && (!membershipHeld || task.scope !== 'workspace' || task.scopeVersion !== publication.scopeVersion)) throw new PublicationError('issue_unavailable')
    const report = reportOf(run)
    if (publication.remoteKey !== remoteKey(publication.remoteUrl) || !report?.publish?.commit || !publication.branch || !publication.identifier || publicationGate({ stopReason: run.stopReason, kind: run.kind, report, assignment: publication }).state !== 'pending') throw new PublicationError('publication_mismatch')
    const admission = run.agentDefinition?.repositoryAdmission
    const accepted = admission && run.deviceId && matchesRepositoryAdmission(admission, {
      userId: run.userId, issueId: task.id, deviceId: run.deviceId, agentId: run.agentId, remoteKey: publication.remoteKey, remoteUrl: publication.remoteUrl, targetBranch: publication.branch,
      workspaceId: admission.workspaceId, workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
    }) && await (await import('./run-admission-store')).acceptedEventStillMatches(admission, run.botId, tx)
    if (admission && !accepted) throw new PublicationError('publication_mismatch')
    const [settings] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, claim.userId), eq(repositorySettings.remoteKey, publication.remoteKey))).for('share')
    if (!publication.pushApproved || (!accepted && !repositoryPushApproved(settings?.push, claim.userId))) throw new PublicationError('push_not_approved')
    return work({ publication, run, report, allowCreate: readIssueMetadata(task.content).pullRequests.length < 10 })
  })
  if (hint.userId === claim.userId) return apply(false)
  return workspaceDb.transaction(async workspace => {
    await workspace.execute(sql`set local lock_timeout = '8s'`)
    const [member] = await workspace.select({ userId: workspaceMembers.userId }).from(teamIssues)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, teamIssues.workspaceId))
      .where(and(eq(teamIssues.issueId, claim.issueId), eq(workspaceMembers.userId, claim.userId), eq(workspaceMembers.status, 'active'))).for('share')
    if (!member) throw new PublicationError('issue_unavailable')
    return apply(true)
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
    const snapshot = await withPublicationAuthority(claim, async ({ publication, report, allowCreate }) => ({
      remoteKey: publication.remoteKey, issueId: publication.issueId, identifier: publication.identifier!, title: publication.issueTitle!, summary: report.summary,
      branch: publication.branch!, commit: report.publish!.commit!, baseBranch: publication.baseBranch, draft: report.verify.status === 'not_run', allowCreate,
    }))
    const pullRequest = await openPullRequest({ ...snapshot, githubAccountId: await linkedGitHubAccountId(claim.userId), onVerified: binding => saveRepositoryInstallation(claim.userId, claim.remoteKey, binding), withWrite: write => withPublicationAuthority(claim, async () => write()) })
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
