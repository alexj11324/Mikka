import { runChanged } from './live/panels'
import { completionFailureDetails } from './run-failure-details'
import 'server-only'
import { isCurrentFactoryDeliverable } from './factory/execution-kind'
import { issueListChanged, runListChanged } from './live/lists'
import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { reachesReview, runReport, type RunReport, type RunCompleteRequest } from '@mikka/protocol/run'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { remoteKey } from '@mikka/protocol/repository'
import { db, pool, withDatabaseClient, withDatabaseTransaction } from '@/lib/db'
import { agentRuns, devices, issues, issueVersions, runPublications, runTokens, type RunStatus } from '@/lib/db/schema'
import { taskIdentifiers, taskPrefixInput } from '@/lib/task-identifier-server'
import { readIssueMetadata, withIssueMetadata, pullRequestSchema } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { workspaceDb } from '@/lib/workspace-db'
import { systemActor } from '@/lib/activity-actor'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { publicationBranch, publicationGate } from '@/lib/run-publication-policy'
import { openRunPullRequest, PublicationError, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/github/run-pull-request'
import { matchesRepositoryAdmission } from './repository-admission'
import { mayCompleteIssue, withRunWorkspace } from './run-completion'
import type { QuotaPlan } from './run-quota'
import { lockFactoryCompletionTasks, lockCompletionSkillScopes, prepareRunCompletionEffects, reconcileFactoryAfterCompletion, settleRunCompletionEffects } from './run-completion-effects'
import { launchProviderContinuation, pendingProviderFallback, providerCompletion, recoverProviderFailure } from './run-provider-fallback'
import { lockResourceAccess } from './resource-access/store'
import { runPersonalResourcesAllowed } from './run-private-resources'
import { ActionFailureError } from './action-error'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Run = typeof agentRuns.$inferSelect
type Publication = typeof runPublications.$inferSelect
const LIVE = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
const TERMINAL_PUBLICATIONS = ['published', 'blocked', 'skipped']
/** Where a publication workflow stops. */
const WORKFLOW_DONE = [...TERMINAL_PUBLICATIONS]
const PUBLICATION_LEASE_MS = 120_000
const MAX_ATTEMPTS = 5

function reportOf(run: Run): RunReport | null {
  const parsed = runReport.safeParse(run.report)
  return parsed.success ? parsed.data : null
}

async function withPublicationWorkspace<T>(userId: string, workspaceId: string | null, work: () => Promise<T>): Promise<T> {
  const held = await workspaceDb.transaction(async workspace => {
    await workspace.execute(sql`set local lock_timeout = '8s'`)
    return withRunWorkspace(userId, workspaceId, async () => ({ value: await work() }))
  })
  if (!held) throw new PublicationError('issue_unavailable')
  return held.value
}

/** Pin the task's branch before claiming it. */
export async function prepareRunPublication(run: Pick<Run, 'id' | 'userId' | 'issueId' | 'baseBranch'> & Partial<Pick<Run, 'agentDefinition' | 'deviceId' | 'agentId' | 'botId'>>, remoteUrl: string) {
  if (!run.issueId) throw new PublicationError('issue_unavailable')
  const issueId = run.issueId
  const [stored] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.userId, run.userId), eq(agentRuns.issueId, issueId))).limit(1)
  if (!stored?.workspaceId) throw new PublicationError('issue_unavailable')
  const key = remoteKey(remoteUrl)
  const admission = run.agentDefinition?.repositoryAdmission
  const accepted = admission && (admission.workspaceId == null || admission.workspaceId === stored.workspaceId) && run.deviceId && run.agentId && matchesRepositoryAdmission(admission, {
    userId: run.userId, issueId, deviceId: run.deviceId, agentId: run.agentId, remoteKey: key, remoteUrl, targetBranch: admission.targetBranch,
    workspaceId: admission.workspaceId, workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
  }) && await (await import('./run-admission-store')).acceptedEventStillMatches(admission, run.botId ?? null)
  if (admission && !accepted) throw new PublicationError('publication_mismatch')
  // Kept for old readers only: pushing needs no approval (decision 2026-11-02-1600).
  const pushApproved = true
  const row = await withPublicationWorkspace(run.userId, stored.workspaceId, () => db.transaction(async tx => {
    const [task] = await tx.select({ id: issues.id, userId: issues.userId, scope: issues.scope, workspaceId: issues.workspaceId, ownershipState: issues.ownershipState, scopeVersion: issues.scopeVersion, title: issues.title, content: issueAttrsContent, prefixInput: taskPrefixInput(sql`issues."userId"`) }).from(issues).where(eq(issues.id, issueId)).for('update')
    if (!task || !await mayCompleteIssue(task, run.userId, stored.workspaceId)) throw new PublicationError('issue_unavailable')
    const [currentRun] = await tx.select({ id: agentRuns.id, workspaceId: agentRuns.workspaceId }).from(agentRuns).where(and(eq(agentRuns.id, run.id), eq(agentRuns.userId, run.userId), eq(agentRuns.issueId, issueId))).for('update')
    if (!currentRun || currentRun.workspaceId !== stored.workspaceId) throw new PublicationError('issue_unavailable')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + issueId}, 0))`)
    const [existing] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, run.id), eq(runPublications.userId, run.userId)))
    if (existing) {
      if (existing.remoteKey !== key || existing.issueId !== issueId) throw new PublicationError('publication_mismatch')
      if (existing.scopeVersion === null || existing.issueTitle === null || (task.userId !== run.userId && existing.scopeVersion !== task.scopeVersion)) throw new PublicationError('issue_unavailable')
      if (admission && existing.branch !== admission.targetBranch) throw new PublicationError('publication_mismatch')
      return existing
    }
    const [previous] = await tx.select().from(runPublications)
      .where(and(eq(runPublications.issueId, issueId), eq(runPublications.remoteKey, key), sql`${runPublications.branch} is not null`))
      .orderBy(asc(runPublications.createdAt)).limit(1)
    const identifier = previous?.identifier ?? (await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number, prefixInput: task.prefixInput }], tx)).get(issueId) ?? null
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
  }))
  const policy = defaultRunPolicy()
  // A run with a task branch delivers to it; the run uses its owner's own
  // GitHub credential, so nothing is approved here (decision 2026-11-02-1600).
  policy.permissions.git_push = row.branch ? 'allow' : 'deny'
  return { ...(row.branch ? { pushBranch: row.branch } : {}), policy }
}

/** Preserve concurrent task edits; result, history and inbox commit together. */
async function finishResult(tx: Transaction, run: Run, publication?: { pullRequest?: PublishedPullRequest | null; errorCode?: PublicationErrorCode | null; branch?: string | null }, attachPullRequest = true, expectedScopeVersion?: number | null) {
  const report = reportOf(run)
  let review: { id: string; scopeVersion: number } | null = null
  if (run.issueId) {
    const [task] = await tx.select().from(issues).where(eq(issues.id, run.issueId)).for('update')
    const accessible = task && (expectedScopeVersion === undefined || task.scopeVersion === expectedScopeVersion) && await mayCompleteIssue(task, run.userId, run.workspaceId)
    if (task && accessible && !readIssueMetadata(task.content).deletedAt) {
      const metadata = readIssueMetadata(task.content)
      const pr = attachPullRequest && publication?.pullRequest ? pullRequestSchema.parse(publication.pullRequest) : null
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
        await issueListChanged(tx, saved.id)
        if (saved.status === 'review') review = { id: saved.id, scopeVersion: saved.scopeVersion }
      }
    } else if (attachPullRequest && publication?.pullRequest) throw new PublicationError('issue_unavailable')
  }
  // A used-up quota has its own event (lib/run-quota.ts): switched to a key, or paused.
  if (run.stopReason !== 'quota_exhausted' && run.stopReason !== 'provider_failure') await recordCoordinatorEvent(tx, runFinishedEvent({ ...run, stopReason: run.stopReason ?? 'error', report,
    publication: publication?.pullRequest ? { ...publication, pullRequest: pullRequestSchema.parse(publication.pullRequest) } : publication }))
  return review
}

/**
 * Accept the first report and revoke worker credentials atomically. A replay
 * uses that frozen report even if a daemon sends different data afterward.
 */
export async function persistRunCompletion(userId: string, runId: string, completion: RunCompleteRequest, scopeDeviceId?: string | null) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await completionTransaction(userId, runId, completion, scopeDeviceId)
      // After commit: a paused cloud run goes on with its key through the cloud queue.
      if (result?.quotaCloud) await (await import('./run-quota')).continueCloudQuotaRun(result.quotaCloud.run, result.quotaCloud.plan, result.quotaCloud.resetsAt)
      // A committed provider failure changes models before Factory evaluates
      // the result, so it never spends the task's code repair budget. Replays
      // resume this idempotent step after a process interruption.
      const continuation = result?.providerRunId ? await recoverProviderFailure(pool, userId, result.providerRunId) : null
      // After commit: hand the completed run to Factory review (BE-9).
      if (result) await reconcileFactoryAfterCompletion(pool, userId, runId)
      await launchProviderContinuation(userId, continuation)
      return result
    }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function completionTransaction(userId: string, runId: string, completion: RunCompleteRequest, scopeDeviceId?: string | null) {
  const owner = and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId), eq(devices.ownerId, userId), ...(scopeDeviceId ? [eq(devices.id, scopeDeviceId)] : []))
  const [stored] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId)).where(owner).limit(1)
  if (!stored?.workspaceId) return null
  return withRunWorkspace(userId, stored.workspaceId, async () => {
  const client = await pool.connect()
  let wakeDevice: string | null | undefined
  let committed = false
  try { const result = await withDatabaseClient(client, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    // Factory writers take task -> issue -> skill scope -> run; retirement
    // takes issue -> run. Read hints choose locks only; recheck all bindings
    // and authorization after locking, including dedicated-device scope.
    const [hint] = await tx.select({ issueId: agentRuns.issueId, deviceRepoId: agentRuns.deviceRepoId }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId)).where(owner).limit(1)
    if (!hint) return null
    const factoryBound = await lockFactoryCompletionTasks(client, userId, runId)
    const [issue] = hint.issueId ? await tx.select().from(issues).where(eq(issues.id, hint.issueId)).for('update') : []
    await lockCompletionSkillScopes(client, userId, runId, hint, factoryBound)
    const [owned] = await tx.select({ run: agentRuns }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(owner).for('update', { of: agentRuns })
    if (!owned || owned.run.workspaceId !== stored.workspaceId || owned.run.issueId !== hint.issueId || owned.run.deviceRepoId !== hint.deviceRepoId) return null
    let run = owned.run
    // A run paused on its quota has completed already; a replay does not end it again.
    const firstCompletion = LIVE.includes(run.status) && !(run.status === 'paused' && run.pauseReason === 'quota_exhausted')
    if (run.issueId && (!issue || !await mayCompleteIssue(issue, run.userId, run.workspaceId))) {
      // Retirement already ended this run and revoked its credentials. Accept
      // the outbox replay without writing a result, event or publication.
      return firstCompletion ? null : { userId, issueId: null, publicationPending: false, review: null }
    }
    const [publication] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, runId), eq(runPublications.userId, userId))).for('update')
    let quotaCloud: { run: Run; plan: QuotaPlan; resetsAt: string | null } | undefined
    if (firstCompletion) {
      completion = providerCompletion(run, completion)
      // A used-up subscription quota goes on with the person's key or pauses (lib/run-quota.ts);
      // a run that was not on a subscription has no quota to switch from, so it is an error.
      const quota = completion.stopReason === 'quota_exhausted' ? await (await import('./run-quota')).planQuotaExhausted(client, run) : undefined
      if (quota === null) completion = { ...completion, stopReason: 'error' }
      const paused = Boolean(quota && (!quota.key || quota.cloud))
      const resetsAt = completion.report?.resetsAt ?? null
      const prepared = await prepareRunCompletionEffects(client, run, completion, factoryBound)
      // runReport strips unknown worker fields. The recovery receipt belongs
      // exclusively to the host, even if an internal caller bypassed parsing.
      const report = prepared ? { ...prepared } : undefined
      if (report) delete (report as Record<string, unknown>).modelFallback
      const persistedReport = report?.providerFailure && completion.stopReason === 'provider_failure'
        ? { ...report, modelFallback: pendingProviderFallback(run, report.providerFailure) } : report
      let status: RunStatus = paused ? 'paused' : runStateForStop(completion.stopReason)
      // A read-only run reports; it has nothing to publish, like a plan.
      if (completion.stopReason === 'submitted' && run.kind !== 'plan' && !run.agentDefinition?.readOnly) {
        if (report?.verify.status === 'failed') status = 'failed'
        else if (report?.verify.status !== 'passed') {
          // Match the host's claim purpose. A desktop delivery has no repository
          // build or publication; its independent checks still gate acceptance.
          if (!factoryBound || !await isCurrentFactoryDeliverable(client, userId, runId)) {
            const gate = publicationGate({ stopReason: completion.stopReason, kind: run.kind, report: report ?? null, assignment: publication ?? null })
            if (gate.state !== 'pending') status = 'stopped'
          }
        }
      }
      // A paused run holds no lease, so it is never reclaimed as lost; it is not finished yet.
      ;[run] = await tx.update(agentRuns).set({ status, pauseReason: paused ? 'quota_exhausted' : null, resumeStatus: null, stopReason: completion.stopReason, report: persistedReport ?? null,
        failureDetails: completionFailureDetails(completion, runId, { status, stopRequested: Boolean(run.stopRequestedAt), sensitiveText: [run.prompt, run.agentDefinition?.instructions ?? ''] }),
        ...(quota ? { quotaResetsAt: resetsAt ? new Date(resetsAt) : null } : {}),
        ...(paused ? { leaseExpiresAt: null, finishedAt: null } : { finishedAt: sql`clock_timestamp()` }), updatedAt: new Date() }).where(eq(agentRuns.id, runId)).returning()
      await runListChanged(tx, runId)
      await runChanged(tx, runId)
      await tx.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.runId, runId), isNull(runTokens.revokedAt)))
      await settleRunCompletionEffects(client, run, completion.stopReason, factoryBound, completion.report)
      if (quota) {
        const settled = await (await import('./run-quota')).settleQuotaExhausted(tx, run, quota, resetsAt)
        if (settled.cloud) quotaCloud = { run, plan: quota, resetsAt }
        if (settled.deviceId) wakeDevice = settled.deviceId
      }
    }
    const providerRunId = run.stopReason === 'provider_failure' ? run.id : undefined
    // A lease-expired/explicitly stopped run cannot be resurrected by a late completion.
    if (!publication) {
      const review = firstCompletion ? await finishResult(tx, run) : null
      return { userId, issueId: run.issueId, publicationPending: false, review, quotaCloud, providerRunId }
    }
    if (publication.status === 'assigned') {
      const gate = publicationGate({ stopReason: run.stopReason, kind: run.kind, report: reportOf(run), assignment: publication })
      await tx.update(runPublications).set({ status: gate.state, errorCode: gate.state === 'blocked' ? gate.error : null, updatedAt: new Date() }).where(eq(runPublications.runId, runId))
      const review = gate.state !== 'pending' ? await finishResult(tx, run, { errorCode: gate.state === 'blocked' ? gate.error : null, branch: publication.branch }, true, publication.scopeVersion) : null
      return { userId, issueId: run.issueId, publicationPending: gate.state === 'pending', review, quotaCloud, providerRunId }
    }
    return { userId, issueId: run.issueId, publicationPending: !TERMINAL_PUBLICATIONS.includes(publication.status), review: null, providerRunId }
  })))
    committed = true
    return result
  } finally {
    client.release()
    if (committed && wakeDevice) (await import('./device-gateway-notify')).notifyDeviceWork(wakeDevice)
  }
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
  const [stored] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
    .where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId), eq(agentRuns.issueId, claim.issueId))).limit(1)
  const settle = (membershipHeld: boolean) => db.transaction(async tx => {
    const [task] = await tx.select({ workspaceId: issues.workspaceId, ownershipState: issues.ownershipState }).from(issues).where(eq(issues.id, claim.issueId)).for('update')
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId))).for('update')
    if (!run || run.issueId !== claim.issueId) return false
    const [current] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, claim.runId), eq(runPublications.leaseToken, claim.leaseToken!))).for('update')
    if (!current) return false
    if (membershipHeld && run.workspaceId === stored?.workspaceId && task?.ownershipState === 'bound' && task.workspaceId === run.workspaceId) {
      try {
        await finishResult(tx, run, { ...result, branch: claim.branch }, true, claim.scopeVersion)
      } catch (error) {
        if (!(error instanceof PublicationError) || !result.pullRequest) throw error
        // A still-authorized member may keep the frozen result in their chat;
        // a late receipt never changes a newer generation of the task.
        result = { ...result, errorCode: error.code }
        await finishResult(tx, run, { ...result, branch: claim.branch }, false, claim.scopeVersion)
      }
    } else {
      // Provider IO may have finished before suspension. Preserve only that
      // durable outcome; no task, history or notification survives revocation.
      result = { ...result, errorCode: 'issue_unavailable' }
    }
    await tx.update(runPublications).set({ status: result.pullRequest ? 'published' : 'blocked', pullRequest: result.pullRequest ?? null, errorCode: result.errorCode ?? null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(runPublications.runId, claim.runId))
    return true
  })
  const settled = await withRunWorkspace(claim.userId, stored?.workspaceId ?? null, () => settle(true))
  return settled ?? settle(false)
}

/** Freeze authorized inputs and revalidate them immediately around each
 * external mutation. Workspace locks precede app locks, as team promotion
 * does; application locks always follow issue -> run -> publication. The
 * provider callback encloses only its existing eight-second HTTP write. */
async function withPublicationAuthority<T>(claim: Publication, work: (value: { publication: Publication; run: Run; report: RunReport; allowCreate: boolean }) => Promise<T>): Promise<T> {
  const [hint] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
    .where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId), eq(agentRuns.issueId, claim.issueId))).limit(1)
  if (!hint?.workspaceId) throw new PublicationError('issue_unavailable')
  return withPublicationWorkspace(claim.userId, hint.workspaceId, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    await tx.execute(sql`set local lock_timeout = '8s'`)
    try { await lockResourceAccess(tx, claim.userId, { kind: 'thread', id: claim.runId, workspaceId: hint.workspaceId! }, 'canSteer') }
    catch (error) {
      if (error instanceof ActionFailureError) throw Object.assign(new PublicationError('issue_unavailable'), { cause: error })
      throw error
    }
    // Publishing a shared execution is not authority to spend the owner's
    // private GitHub account. Organization Git custody needs its own grant.
    if (!await runPersonalResourcesAllowed(pool, claim.runId, claim.userId)) throw new PublicationError('github_identity_required')
    const [task] = await tx.select().from(issues).where(eq(issues.id, claim.issueId)).for('update')
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, claim.runId), eq(agentRuns.userId, claim.userId))).for('update')
    const [publication] = await tx.select().from(runPublications).where(and(eq(runPublications.runId, claim.runId), eq(runPublications.leaseToken, claim.leaseToken!))).for('update')
    if (!task || !run || run.workspaceId !== hint.workspaceId || run.issueId !== task.id || !publication || publication.status !== 'processing' || !publication.leaseExpiresAt || publication.leaseExpiresAt.getTime() <= Date.now()) throw new PublicationError('issue_unavailable')
    if (!await mayCompleteIssue(task, claim.userId, run.workspaceId)) throw new PublicationError('issue_unavailable')
    if (publication.scopeVersion === null || publication.issueTitle === null || readIssueMetadata(task.content).deletedAt) throw new PublicationError('issue_unavailable')
    // Frozen publication generations stay independent of tenant membership.
    // The creator may finish their old frozen inputs only while still active;
    // a teammate's older generation cannot authorize another provider write.
    if (task.userId !== claim.userId && task.scopeVersion !== publication.scopeVersion) throw new PublicationError('issue_unavailable')
    const report = reportOf(run)
    if (publication.remoteKey !== remoteKey(publication.remoteUrl) || !report?.publish?.commit || !publication.branch || !publication.identifier || publicationGate({ stopReason: run.stopReason, kind: run.kind, report, assignment: publication }).state !== 'pending') throw new PublicationError('publication_mismatch')
    const admission = run.agentDefinition?.repositoryAdmission
    const accepted = admission && (admission.workspaceId == null || admission.workspaceId === run.workspaceId) && run.deviceId && matchesRepositoryAdmission(admission, {
      userId: run.userId, issueId: task.id, deviceId: run.deviceId, agentId: run.agentId, remoteKey: publication.remoteKey, remoteUrl: publication.remoteUrl, targetBranch: publication.branch,
      workspaceId: admission.workspaceId, workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
    }) && await (await import('./run-admission-store')).acceptedEventStillMatches(admission, run.botId, tx)
    if (admission && !accepted) throw new PublicationError('publication_mismatch')
    // The pull request opens with the run owner's own GitHub credential
    // (decision 2026-11-02-1600); no Mikka setting or approval gates it.
    return work({ publication, run, report, allowCreate: readIssueMetadata(task.content).pullRequests.length < 10 })
  })))
}

/** What publication hands GitHub: the pull request, for the run owner `userId`. */
export type OwnerPullRequestOpener = (input: Omit<Parameters<typeof openRunPullRequest>[0], 'token' | 'githubAccountId' | 'installationId'> & { userId: string }) => Promise<PublishedPullRequest>

/**
 * Opens it with the run owner's own GitHub token, and only ever the owner's
 * (decision 2026-11-02-1600), recording the repository's installation on the way.
 */
export function createOwnerPullRequestOpener(deps: { credential?: (userId: string, remoteKey: string) => Promise<{ token: string; githubAccountId?: string; installationId?: string }>; fetcher?: typeof fetch; env?: Record<string, string | undefined> } = {}): OwnerPullRequestOpener {
  return async ({ userId, ...input }) => {
    const credential = await (deps.credential ?? ownerGitHubCredential)(userId, input.remoteKey)
    const { recordRepositoryInstallation } = await import('@/lib/github/repository-installation')
    return openRunPullRequest({ ...input, installationId: credential.installationId, ...credential, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      onVerified: async binding => {
        if (credential.installationId || !credential.githubAccountId) return
        await recordRepositoryInstallation(userId, input.remoteKey, { token: credential.token, githubAccountId: credential.githubAccountId, repositoryId: binding.repositoryId }, { fetcher: deps.fetcher, env: deps.env })
      } })
  }
}
export const openOwnerPullRequest = createOwnerPullRequestOpener()

/** The run owner's own GitHub token, as a publication outcome when there is none. */
async function ownerGitHubCredential(userId: string, remoteKey: string): Promise<{ token: string; githubAccountId?: string; installationId?: string }> {
  const { GitHubAccessError } = await import('@/lib/github/user-access')
  const { githubMachineCredential } = await import('@/lib/github/machine-credential')
  try { return await githubMachineCredential(userId, { remoteKey }) }
  catch (error) {
    if (!(error instanceof GitHubAccessError)) throw error
    if (error.code === 'githubNotConnected') throw new PublicationError('github_identity_required')
    if (error.code === 'githubReconnectRequired') throw new PublicationError('github_reconnect_required')
    throw new PublicationError('github_unavailable', true)
  }
}

/** A Workflow step calls this; the DB lease also protects duplicate workflows. */
export async function publishRunResult(runId: string, openPullRequest: OwnerPullRequestOpener = openOwnerPullRequest): Promise<{ done: boolean }> {
  const claim = await claimPublication(runId)
  if (!claim) {
    const [row] = await db.select({ status: runPublications.status }).from(runPublications).where(eq(runPublications.runId, runId))
    return { done: !row || WORKFLOW_DONE.includes(row.status) }
  }
  try {
    // Factory owns the final independent verify gate. Preserve the agent's PR
    // readiness instead of forcing a draft solely because execution had no
    // preconfigured command; the person's merge still requires both checks.
    const factoryBound = (await pool.query(`SELECT 1 FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND a.stage='execute' AND t."userId"=$2 AND t."issueId"=$3`,[runId,claim.userId,claim.issueId])).rowCount === 1
    const snapshot = await withPublicationAuthority(claim, async ({ publication, report, allowCreate }) => ({
      remoteKey: publication.remoteKey, issueId: publication.issueId, identifier: publication.identifier!, title: publication.issueTitle!, summary: report.summary,
      branch: publication.branch!, commit: report.publish!.commit!, baseBranch: publication.baseBranch, draft: report.verify.status === 'not_run' && !factoryBound, allowCreate,
    }))
    const pullRequest = await openPullRequest({ ...snapshot, userId: claim.userId, withWrite: write => withPublicationAuthority(claim, () => write()) })
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
  return { done: !row || WORKFLOW_DONE.includes(row.status) }
}

/** Lookup for Workflow launch/delivery. Never returns credentials or daemon report prose. */
export async function publicationDelivery(runId: string) {
  const [row] = await db.select({ userId: runPublications.userId, issueId: runPublications.issueId, status: runPublications.status, workflowRunId: runPublications.workflowRunId }).from(runPublications).where(eq(runPublications.runId, runId))
  return row ?? null
}

export async function rememberPublicationWorkflow(runId: string, workflowRunId: string) {
  await db.update(runPublications).set({ workflowRunId, updatedAt: new Date() }).where(and(eq(runPublications.runId, runId), isNull(runPublications.workflowRunId)))
}
