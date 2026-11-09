# Fixed-source complete functions

Commit: `12458fe22e1217f644e8b28f82ab856211e73b72`. These are public repository source excerpts, not production values. Every range below includes the complete named function or object method. Whole-file bytes and Git blob IDs were independently read from the fixed local Git object.

## lib/run-completion-effects.ts — optionalFactoryEffect

Original lines 41–48; Git blob `26ce33aa8613723457fdbb2e4a6f3033eb6bee95`; full-file SHA-256 `81011e38d1f99bfc05676f8b630de7cdff6822de57fd3fb2adedcb7ed2b68764`.

```typescript
async function optionalFactoryEffect(client: PoolClient, name: 'completion_monitor_probe' | 'completion_question_settle' | 'completion_question_record', effect: () => Promise<unknown>) {
  await client.query(`SAVEPOINT ${name}`)
  try { await effect() }
  catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
    if (!(error instanceof FactoryError)) throw error
  } finally { await client.query(`RELEASE SAVEPOINT ${name}`) }
}
```

## lib/run-completion-effects.ts — settleRunCompletionEffects

Original lines 73–83; Git blob `26ce33aa8613723457fdbb2e4a6f3033eb6bee95`; full-file SHA-256 `81011e38d1f99bfc05676f8b630de7cdff6822de57fd3fb2adedcb7ed2b68764`.

```typescript
export async function settleRunCompletionEffects(client: PoolClient, run: RunIdentity, stopReason: RunCompleteRequest['stopReason'], factoryBound: boolean, report?: RunCompleteRequest['report']) {
  if (!factoryBound) return
  const { factoryQuestions } = await import('./factory/server')
  const questions = deploymentSwitch('factoryRouting') && deploymentSwitch('factoryLifecycle')
    ? (await import('./factory/runtime')).factoryRuntimeForBot(run.botId).questions
    : factoryQuestions
  await optionalFactoryEffect(client, 'completion_question_settle', () => questions.settle(run.userId, run.id, client))
  if (!report?.repositorySelection && (stopReason === 'asked_human' || stopReason === 'blocked')) await optionalFactoryEffect(client, 'completion_question_record', () => questions.record(run.userId, run.id, client))
  // A cancelled task no longer reconciles, but its worker can still finish.
  taskActivityChanged(client, run.id)
}
```

## lib/factory/questions/store.ts — questions.record

Original lines 331–476; Git blob `08e2ad1a74722d1b866e9ad3d35b54245fb3561e`; full-file SHA-256 `c4e11455471b9a145c1520b0085ab529f8816e1cc2f394bf3e621f54d638d583`.

```typescript
    /** Call after the authentic completion is persisted, inside that same transaction. */
    async record(userId: string, runId: string, existing?: PoolClient) {
      return transaction(async (tx) => {
        const {
          rows: [prior],
        } = await tx.query<FactoryQuestion>(
          'SELECT * FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2',
          [runId, userId],
        );
        const {
          rows: [linked],
        } = prior
          ? { rows: [{ taskId: prior.taskId }] }
          : await tx.query(
              'SELECT t.id AS "taskId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE a."runId"=$1 AND t."userId"=$2',
              [runId, userId],
            );
        if (!linked) fail("factoryQuestionUnbound");
        const task = await ownedTask(tx, userId, linked.taskId);
        if (stopped(task)) fail("factoryStopped");
        const {
          rows: [run],
        } = await tx.query(
          'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
          [runId, userId, task.issueId],
        );
        if (
          !run ||
          run.status !== "stopped" ||
          !["asked_human", "blocked"].includes(run.stopReason) ||
          !run.sessionId ||
          run.stopRequestedAt
        )
          fail("factoryQuestionRunMismatch");
        const handoff: QuestionHandoff = run.report?.question
          ? parse(questionHandoffSchema, run.report.question)
          : questionHandoffSchema.parse({
              questionId: legacyQuestionId(runId),
              kind: run.stopReason === "blocked" ? "external" : "decision",
              question: (
                run.report?.openQuestions?.join("\n") ||
                run.report?.blockedOn ||
                "Missing execution input"
              ).slice(0, 4000),
              context: String(run.report?.summary ?? "").slice(0, 4000),
            });
        const request = {
          handoff,
          originRunId: runId,
          originSessionId: run.sessionId,
        };
        const {
          rows: [duplicate],
        } = await tx.query<FactoryQuestion>(
          'SELECT * FROM factory_questions WHERE "originRunId"=$1 FOR UPDATE',
          [runId],
        );
        if (duplicate) {
          if (
            duplicate.userId !== userId ||
            questionFingerprint(duplicate.request) !==
              questionFingerprint(request)
          )
            fail("factoryReplayMismatch");
          return currentView(tx, task, duplicate);
        }
        if (
          task.status !== "running" ||
          !["spec", "execute", "review", "verify", "monitor"].includes(
            task.stage,
          )
        )
          fail("factoryTransition");
        const {
          rows: [attempt],
        } = await tx.query(
          'SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 AND "runId"=$3',
          [task.attemptId, task.id, runId],
        );
        if (!attempt || attempt.candidateId !== task.candidateId)
          fail("factoryQuestionRunMismatch");
        const eventId = factoryEventId(
          "execution-question",
          handoff.questionId,
        );
        await tx.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload,"botId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("dedupeKey") DO NOTHING`,
          [
            eventId,
            userId,
            run.stopReason === "blocked" ? "run_blocked" : "run_question",
            `execution-question:${handoff.questionId}`,
            task.issueId,
            runId,
            JSON.stringify({
              ...handoff,
              reason: handoff.question,
              taskId: task.id,
              originRunId: runId,
              originSessionId: run.sessionId,
              assessment: "orchestrator_first",
            }),
            task.botId,
          ],
        );
        wakeCoordinatorAfterCommit(tx, userId);
        const state = await store.apply(
          userId,
          binding(task),
          factoryEventId("question-wait", handoff.questionId),
          {
            action: "finish",
            status: "waiting",
            reason: handoff.question,
            evidence: [],
            output: { ...attempt.output, questionId: handoff.questionId },
          },
          tx,
        );
        const {
          rows: [q],
        } = await tx.query<FactoryQuestion>(
          `INSERT INTO factory_questions (id,"userId","issueId","taskId","attemptId","candidateId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,options,request,status,reason,"sourceEventId","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'open',$13,$17,now()+interval '24 hours') RETURNING *`,
          [
            handoff.questionId,
            userId,
            task.issueId,
            task.id,
            task.attemptId,
            task.candidateId,
            task.stage,
            runId,
            run.sessionId,
            task.revision,
            JSON.stringify(binding(state.task)),
            handoff.kind,
            handoff.question,
            handoff.context ?? "",
            JSON.stringify(handoff.options),
            JSON.stringify(request),
            eventId,
          ],
        );
        return view(q);
      }, existing);
    },
```

## app/v1/runs/[runId]/complete/route.ts — handlePOST

Original lines 24–60; Git blob `9f42a40b8087f88d6d68c4657fa4751ffa1b2a1c`; full-file SHA-256 `0174eb18a3003b554a4cfd996dc516ce36cef29dd868bfe5e72656b035967991`.

```typescript
/** The first completion is immutable; retries also recover a failed enqueue. */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const parsed = runCompleteRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    // A malformed replay cannot change a completed run. Preserve the daemon's
    // idempotent acknowledgement without skipping valid publication retries.
    const [ended] = await db.select({ status: agentRuns.status }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(devices.ownerId, caller.userId), ...(caller.scopeDeviceId ? [eq(devices.id, caller.scopeDeviceId)] : []))).limit(1)
    if (ended && !(UNFINISHED_RUN_STATUSES as readonly string[]).includes(ended.status)) return new NextResponse(null, { status: 204 })
    return NextResponse.json({ error: 'Invalid completion.' }, { status: 400 })
  }
  let result: Awaited<ReturnType<typeof persistRunCompletion>>
  // 4e2 ②: report / error text from a cloud worker is masked before it is stored.
  const failureDetails = completionFailureDetails(parsed.data, runId)
  const { failureDetails: _suppliedFailure, ...body } = parsed.data
  const completion = maskDeep({ ...body, ...(failureDetails ? { failureDetails } : {}) }, await secretMaskerFor({ workspaceId: caller.scopeWorkspaceId, ownerId: caller.userId }))
  try { result = await persistRunCompletion(caller.userId, runId, completion, caller.scopeDeviceId) }
  catch (error) {
    if (error instanceof ImprovementError) return NextResponse.json({ error: error.code }, { status: 409 })
    throw error
  }
  if (!result) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  stopRecordingsAfter([runId])
  if (result.publicationPending) {
    try { await startRunPublication(runId) }
    catch { return NextResponse.json({ error: 'Result publication is temporarily unavailable.' }, { status: 503, headers: { 'Retry-After': '15' } }) }
  } else {
    await dispatchCompletedIssue(result, dispatchLinearIssueSync)
    afterJob('after:coordinator-wake', () => wakeCoordinator(result.userId))
    // How it came out, for the right column (R-52); a run still publishing is judged by the minute sweep.
    afterJob('after:run-outcome-judge', () => judgeRunOutcome(runId).catch(() => null))
  }
  return new NextResponse(null, { status: 204 })
}
```

## lib/run-publications.ts — completionTransaction

Original lines 163–258; Git blob `af132ce1278f7b60f7ac105e02b1d42ea986ba2e`; full-file SHA-256 `24ffcf3a364ac2d86f80c16fea7b3343e43b9c371b10963b70cbcfea7e6f788b`.

```typescript
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
```
