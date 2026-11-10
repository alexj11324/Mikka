import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { queueFactoryRun } from '@/lib/agent-runs'
import { queueCloudRun } from '@/lib/computer/queue-run'
import { ensureRecordedBotHarnessRuntime } from '@/lib/computer/bot-runtime-records'
import { chooseCloudRunModel, chooseLocalRunModel, threadRunModel, type RunModel } from '@/lib/computer/run-model'
import { deviceOnlineStates } from '@/lib/device-presence'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { tiptapToText } from '@/lib/tiptap-text'
import { createFactoryDispatch, defaultFactoryDispatchAdapters, factoryBinding } from './dispatch'
import { configureFactoryCheck, currentFactoryRequest } from './checks'
import { checkFactoryRepairBudget } from './check-recovery-evidence'
import { observeFactoryProfileDispatch } from './reconcile'
import { FactoryError, factoryFlowVersion } from './contract'
import { notifyDeviceWork } from '../device-gateway-notify'
import type { FactoryTask, createFactoryStore } from './store'
import { assertRecoveredCheck, type FrozenFactoryCheck } from './check-start-recovery'
import { candidateRecheckRound, candidateRecheckDispatchSource, refreshRecheckSource, admitRecheckSource } from './candidate-recheck'
import type { ProfileCheckWork } from './agent-profile-decision'

/** Provider I/O boundary; no model input selects these callbacks. */
export const factoryAutomaticRuntime = {
  park: async (pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, nextRunId?: string) => {
    const { parkThreadMachine, retainThreadMachineForHandoff } = await import('@/lib/cloud-computer/thread-machines')
    if (nextRunId && await retainThreadMachineForHandoff(pool, actor, runId, nextRunId)) return
    await parkThreadMachine(pool, actor, runId)
  },
  // The durable Factory workflow owns its lifecycle; do not spawn a second,
  // non-idempotent child workflow from its retried handoff step.
  start: async (actor: { userId: string; workspaceId: string }, runId: string) => (await import('@/lib/run-leases')).startThreadMachine(actor, runId, false),
  enqueue: async (_pool: Pool, actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string) => {
    const [{ start }, { factoryCloudStageHandoff }] = await Promise.all([import('workflow/api'), import('@/workflows/factory-stage/workflow')])
    await start(factoryCloudStageHandoff, [actor, previousRunId, runId])
  },
}

/** The host, rather than a model tool call, queues every independent stage. */
export function automaticFactoryDispatch(pool: Pool) {
  return observeFactoryProfileDispatch(async (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, prior: FactoryTask, _run: Record<string, any>, initialCheckStart?: FrozenFactoryCheck) => {
    let task = await store.lockTask(tx, prior.userId, prior.id)
    const recheck = initialCheckStart ? null : await candidateRecheckRound(tx, task)
    // This Owner request is for new checks on the retained candidate. A real
    // failed check stays failed; only a separate repair action may replace it.
    if (recheck && task.status === 'failed') return
    if (task.status === 'failed' && ['review','verify'].includes(task.stage)) {
      const { rows: [attempt] } = await tx.query('SELECT output FROM factory_attempts WHERE id=$1', [task.attemptId])
      if (attempt?.output?.completion?.trustedFailureProvenance === true) {
        try { await checkFactoryRepairBudget(tx, task) }
        catch (error) {
          if (!(error instanceof FactoryError) || error.code !== 'factoryRecoveryBudgetExceeded') throw error
          await tx.query(`UPDATE factory_attempts SET output=output || '{"reasonCode":"repair_budget_exhausted"}'::jsonb WHERE id=$1`, [task.attemptId])
          return
        }
        task = (await store.apply(task.userId, factoryBinding(task), (await import('./event-id')).factoryEventId('check-repair', task.attemptId), { action: 'repair', reason: task.reason.slice(0,4000) }, tx)).task
      }
    }
    if (task.status !== 'pending' || !['execute','review','verify'].includes(task.stage)) return
    const checkStart = initialCheckStart ?? (recheck ? await candidateRecheckDispatchSource(tx, task, recheck) : undefined)
    if (recheck && checkStart) {
      await refreshRecheckSource(pool, checkStart)
      await admitRecheckSource(tx, checkStart)
    }
    const assertFrozenDispatch = async (runId: string) => {
      if (!checkStart) return
      const { rows: [queued] } = await tx.query(`SELECT r.*,a.output->'check' AS "checkAssignment" FROM factory_attempts a
        JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1 AND a."taskId"=$2 AND r.id=$3`, [task.attemptId, task.id, runId])
      if (!queued) throw new FactoryError('factoryCheckBindingMismatch')
      assertRecoveredCheck(checkStart, queued, queued.checkAssignment)
    }
    const { rows: [source] } = await tx.query(`SELECT r.*,repo."remoteUrl",d.kind AS "deviceKind",b."botId" AS "runtimeBotId",b."workspaceId" AS "runtimeWorkspaceId",COALESCE(r."agentDefinition"->>'harness',a.harness) AS harness
      FROM factory_attempts f JOIN agent_runs r ON r.id=f."runId"
      JOIN agents a ON a.id=r."agentId" JOIN devices d ON d.id=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId"
      LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE f."taskId"=$1 AND f.stage IN ('execute','spec') ORDER BY f.position DESC LIMIT 1`, [task.id])
    const workspaceId = task.workspaceId
    // The runtime join must not shadow the run's persisted tenant (it is
    // absent for local runs). Every later role and recovery selection keeps
    // the task/run tenant, including a botless shared task.
    if (!source || !workspaceId || source.workspaceId !== workspaceId || source.userId !== task.userId || source.issueId !== task.issueId ||
      // A completed source may have released its live cloud binding. The
      // persisted run/task tenant remains authoritative; only a binding that
      // still exists can contradict it.
      (source.deviceKind === 'cloud' && source.runtimeWorkspaceId != null && source.runtimeWorkspaceId !== workspaceId)) throw new FactoryError('factoryRunMismatch')
    const check = task.stage !== 'execute'
    const checkStage = task.stage === 'review' || task.stage === 'verify' ? task.stage : undefined
    const candidateId = task.candidateId
    // A newly approved specification starts an executor, not a continuation of
    // the planner's role, credential, read-only grant or native session.
    const firstImplementation = !check && source.kind === 'plan'
    const selectStageProfile = check || firstImplementation
    const continueImplementation = !check && !firstImplementation
    if (checkStart && (!check || checkStart.taskId !== task.id || checkStart.candidateId !== task.candidateId ||
        checkStart.sourceEventId !== task.sourceEventId || checkStart.attemptId === task.attemptId ||
        checkStart.run.deviceKind !== source.deviceKind || checkStart.run.agentDefinition.executionIdentity.workspaceId !==
          (source.workspaceId ?? source.agentDefinition?.executionIdentity?.workspaceId)))
      throw new FactoryError('factoryCheckBindingMismatch')
    // The producer still supplies the candidate/runtime admission. A host-only
    // unstarted retry keeps the failed check's exact role and credential instead
    // of choosing again from the person's now-current stage preferences.
    const inheritedPolicy = checkStart ? { policyCeiling: checkStart.selection.policyCeiling }
      : source.agentDefinition?.policyCeiling ? { policyCeiling: source.agentDefinition.policyCeiling } : {}
    let selection: Partial<RunModel> = checkStart?.selection ?? (selectStageProfile ? inheritedPolicy : threadRunModel(source.agentDefinition) ?? inheritedPolicy)
    let checkWork: ProfileCheckWork | undefined
    if (check && !checkStart) {
      // Select the current check's role from its actual candidate, not from the
      // original implementation prompt or whichever execution ran most recently.
      const { rows: [candidate] } = await tx.query<{ id: string; kind: ProfileCheckWork['candidate']['kind']; sha: string | null; runId: string;
        harness: ProfileCheckWork['producer']['harness']; model: string | null; profileId: string | null; profileVersion: number | null }>(
        `SELECT c.id,c.kind,c.sha,c."runId",COALESCE(producer."agentDefinition"->>'harness',a.harness) AS harness,
           producer."agentDefinition"->>'model' AS model,producer."agentDefinition"->'agentProfile'->>'profileId' AS "profileId",
           producer."agentDefinition"->'agentProfile'->'version' AS "profileVersion"
         FROM factory_candidates c JOIN agent_runs producer ON producer.id=c."runId" AND producer."userId"=$3 AND producer."issueId"=$4
         JOIN agents a ON a.id=producer."agentId" AND a."userId"=producer."userId"
         WHERE c.id=$1 AND c."taskId"=$2`, [task.candidateId, task.id, task.userId, task.issueId])
      if (!candidate) throw new FactoryError('factoryCheckBindingMismatch')
      checkWork = {
        stage: task.stage as 'review' | 'verify', flowVersion: factoryFlowVersion(task), taskId: task.id, attemptId: task.attemptId, requestEpoch: task.sourceEventId,
        candidate: { id: candidate.id, kind: candidate.kind, sha: candidate.sha },
        producer: { runId: candidate.runId, harness: candidate.harness, model: candidate.model,
          ...(candidate.profileId && Number.isInteger(candidate.profileVersion) && candidate.profileVersion! > 0
            ? { profile: { id: candidate.profileId, version: candidate.profileVersion! } } : {}) },
      }
    }
    let profileChoice = selectStageProfile && !checkStart ? await (await import('./agent-profile')).resolveAgentProfileDispatch(pool, {
      ownerId: task.userId, workspaceId, botId: task.botId,
    }, { issueId: task.issueId, stage: task.stage, location: source.deviceKind === 'cloud' ? 'cloud' : 'local',
      defaultHarness: source.harness, cloudPurpose: source.remoteUrl ? 'task' : 'desktop',
      ...(source.agentDefinition?.pinnedDeviceId ? { deviceId: source.agentDefinition.pinnedDeviceId } : {}),
    }, { transaction: tx, checkWork,
      ...(checkStage && candidateId ? { independentCheck: async () => ({
        taskId: task.id, requestEpoch: task.sourceEventId, candidateId, stage: checkStage,
        currentOwnerRequest: await currentFactoryRequest(tx, task),
      }) } : {}),
    }) : undefined
    if (profileChoice?.target.kind === 'none') throw new FactoryError('factoryCheckHarnessUnavailable')
    const { rows: [pending] } = await tx.query('SELECT output,position FROM factory_attempts WHERE id=$1 AND "taskId"=$2', [task.attemptId, task.id])
    const recovery = pending?.output?.watchdogRecovery
    const previousRouting = source.agentDefinition?.modelDispatch?.routing
    const frozenProfile = source.agentDefinition?.agentProfile
    let routingScope: { ownerId: string; workspaceId: string } | undefined
    if (continueImplementation && !recovery && previousRouting && source.agentDefinition.modelDispatch.mode === 'preference' && frozenProfile?.definition.model.mode !== 'fixed') {
      // Only the adjacent, persisted failed attempt in this request can raise
      // a model. A repeated dispatch or a watchdog migration is not a failure.
      const { rows: [failed] } = await tx.query(`SELECT a.stage,a.output,a."runId" FROM factory_attempts a
        WHERE a."taskId"=$1 AND a.position=$2-1 AND a.status='failed'
          AND COALESCE(a.output->>'requestEpoch',$3::text)=$3::text
          AND ((a.stage IN ('review','verify') AND a.output->'completion'->'trustedFailureProvenance'='true'::jsonb)
            OR (a.stage='execute' AND a."runId"=$4 AND a.output->>'reasonCode'='run_failed'))`,
      [task.id, pending?.position, task.sourceEventId, source.id])
      if (failed) {
        const scope = {
          ownerId: task.userId, workspaceId, botId: task.botId,
        }
        let target = await (await import('@/lib/model-dispatch')).resolveModelDispatch(pool, scope, null, source.deviceKind === 'cloud' ? 'cloud' : 'local', source.agentDefinition.pinnedDeviceId, {
          cloudPurpose: source.remoteUrl ? 'task' : 'desktop', bindSubscription: false,
          ...(frozenProfile?.definition.harness && frozenProfile.definition.harness !== 'auto' ? { harness: frozenProfile.definition.harness } : {}),
          routing: { issueId: task.issueId, stage: task.stage, previous: previousRouting, escalate: true, effort: frozenProfile?.effort },
        })
        // An off switch keeps the existing frozen choice. Preserve the role,
        // policy and skill digest; only its actual execution target changes.
        if (target.kind !== 'none' && target.routing) {
          const agentProfile = frozenProfile ? { ...structuredClone(frozenProfile), targetEntry: structuredClone(target.entry) } : undefined
          // As with Profile planning, only an adopted target may write a
          // binding. Keep source authorization and binding on the owner tx,
          // before the queue takes any current Profile lock.
          if (agentProfile) await (await import('./agent-profile')).assertProfileTarget(tx, scope, agentProfile)
          if (target.kind === 'device' && target.entry.source.kind === 'subscription') target = { ...target,
            subscriptionBindingId: await (await import('@/lib/model-dispatch')).bindAgentToConnection(tx, scope, target.agentId, target.entry.harness, target.entry.source.connectionId, target.model) }
          profileChoice = { target, selectionMode: 'preference', ...(agentProfile ? { agentProfile } : {}) }
          routingScope = scope
        }
      }
    }
    const registerRoutingAdmission = async (runId: string) => {
      if (!routingScope) return
      const { rows: [queued] } = await tx.query<{ profileOriginRunId: string | null }>(
        `SELECT "agentDefinition"->>'profileOriginRunId' AS "profileOriginRunId" FROM agent_runs
          WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 AND "agentDefinition"->'executionIdentity'->>'workspaceId'=$4`,
        [runId, task.userId, task.issueId, routingScope.workspaceId])
      if (!queued) throw new FactoryError('factoryRunMismatch')
      // Only the queue's verified native grant may retain an older role.
      // Fresh repairs recheck the Profile at COMMIT; both pin membership.
      const { registerFactoryProfile } = await import('./transaction')
      registerFactoryProfile(tx, routingScope,
        queued.profileOriginRunId === source.id ? undefined : profileChoice?.agentProfile)
    }
    let agentId = checkStart?.run.agentId ?? source.agentId, deviceId = checkStart?.run.deviceId ?? source.deviceId, deviceRepoId = checkStart?.run.deviceRepoId ?? source.deviceRepoId
    if (recovery && !check && source.deviceKind !== 'cloud') {
      if (recovery.requestEpoch !== task.sourceEventId || recovery.previousRunId !== source.id || !source.remoteUrl)
        throw new FactoryError('factoryRecoveryExecutorUnavailable')
      // An idle gateway daemon stops HTTP heartbeats, so lastSeenAt alone would miss it: ask presence.
      const { rows: candidates } = await tx.query(`SELECT a.id,d.id AS "deviceId",d."lastSeenAt",a.harness FROM agents a JOIN devices d ON d.id=a."deviceId" AND d."ownerId"=a."userId"
        WHERE a."userId"=$1 AND d.enabled=true AND d.kind='local' AND d.id<>$2 AND a.harness=$3
          AND d."protocolVersion">=$4
        ORDER BY (d."deviceType"='server') DESC,d."lastSeenAt" DESC NULLS LAST,a.id LIMIT 20`,
      [task.userId, source.deviceId, source.harness, DAEMON_PROTOCOL_VERSION])
      const online = await deviceOnlineStates(candidates.map(c => ({ id: c.deviceId, lastSeenAt: c.lastSeenAt })))
      const targets = candidates.filter(c => online.get(c.deviceId)).slice(0, 5)
      let selected = false
      const profile = source.agentDefinition?.agentProfile
      const exactEntry = profile?.definition.model.mode === 'fixed' ? profile.targetEntry
        : source.agentDefinition?.modelDispatch?.mode === 'picked' ? source.agentDefinition.modelDispatch.entry : undefined
      for (const target of targets) {
        const model = await chooseLocalRunModel(pool, { ownerId: task.userId, workspaceId, botId: task.botId }, target, source.agentDefinition?.model, exactEntry)
        if ('error' in model) continue
        agentId = target.id
        deviceId = target.deviceId
        deviceRepoId = (await ensureDeviceRepository(task.userId, target.deviceId, source.remoteUrl, tx)).id
        // Retain the frozen role and selection policy, but record B's actual
        // authorized source. The queue verifies the current watchdog receipt.
        const modelDispatch = model.modelDispatch?.entry ? { ...model.modelDispatch, entry: model.modelDispatch.entry,
          mode: source.agentDefinition?.modelDispatch?.mode ?? 'preference' as const } : undefined
        if (profile && !modelDispatch) throw new FactoryError('factoryRecoveryExecutorUnavailable')
        const agentProfile = profile && modelDispatch ? profile.source === 'default'
          ? (await import('./agent-profile')).builtinAgentProfileSelection({ ownerId: task.userId, workspaceId }, modelDispatch.entry)
          : { ...structuredClone(profile), targetEntry: structuredClone(modelDispatch.entry) } : undefined
        selection = { ...model, modelDispatch, ...(agentProfile ? { agentProfile } : {}), ...inheritedPolicy }
        selected = true
        break
      }
      if (!selected) throw new FactoryError('factoryRecoveryExecutorUnavailable')
    }
    if (source.deviceKind !== 'cloud') {
      if (profileChoice) {
        const target = profileChoice.target
        if (target.kind !== 'device') throw new FactoryError('factoryCheckHarnessUnavailable')
        agentId = target.agentId
        deviceId = target.deviceId
        deviceRepoId = (await ensureDeviceRepository(task.userId, target.deviceId, source.remoteUrl, tx)).id
        selection = { ...inheritedPolicy, model: target.model, agentProfile: profileChoice.agentProfile,
          modelDispatch: { mode: profileChoice.selectionMode ?? 'preference', location: 'local', entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) },
          ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}),
          ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}) }
      }
      const dispatch = createFactoryDispatch(pool, store, (client, userId, input, botId, context) => queueFactoryRun(client, userId, input, botId, context, undefined, { ...selection, ...(continueImplementation ? { threadRunId: source.id } : {}), pinnedDeviceId: (checkStart?.run ?? source).agentDefinition?.pinnedDeviceId, readOnly: check || (continueImplementation && source.agentDefinition?.readOnly) }),
        checkStart ? { ...defaultFactoryDispatchAdapters, configure: { ...defaultFactoryDispatchAdapters.configure,
          review: (client, current, id) => configureFactoryCheck(client, current, id, checkStart.selection.policyCeiling),
          verify: (client, current, id) => configureFactoryCheck(client, current, id, checkStart.selection.policyCeiling),
        } } : defaultFactoryDispatchAdapters)
      const result = await dispatch(task.userId, { binding: factoryBinding(task), agentId, deviceRepoId }, tx)
      await assertFrozenDispatch(result.runId)
      await registerRoutingAdmission(result.runId)
      if (continueImplementation) await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [result.runId, source.id])
      if (recovery && !check) await tx.query('UPDATE agent_runs SET "retryOf"=$2,attempt=$3 WHERE id=$1', [result.runId, source.id, source.attempt + 1])
      return async () => { notifyDeviceWork(deviceId) }
    }
    const selectedHarness = checkStart?.run.agentDefinition.harness ?? (profileChoice?.target.kind === 'cloud' ? profileChoice.target.harness : source.harness)
    // The live computer binding is released when a source run finishes. The
    // run's own bot is the durable fallback, then the task's bot for legacy rows.
    const runtimeBotId = source.runtimeBotId ?? source.botId ?? task.botId
    const runtime = await ensureRecordedBotHarnessRuntime(tx, { userId: task.userId, workspaceId: source.workspaceId }, runtimeBotId, selectedHarness, { freshTask: true })
    if (!runtime || (checkStart && runtime.agentId !== checkStart.run.agentId)) throw new FactoryError('factoryCheckHarnessUnavailable')
    let model: Partial<RunModel> | { error: string } = selection
    if (profileChoice) {
      const target = profileChoice.target
      if (target.kind !== 'cloud') throw new FactoryError('factoryCheckHarnessUnavailable')
      const entry = target.entry.source
      model = { model: target.model, agentProfile: profileChoice.agentProfile,
        modelDispatch: { mode: profileChoice.selectionMode ?? 'preference', location: 'cloud', entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) },
        ...(entry.kind === 'api_key' ? { apiKeyId: entry.keyId } : { subscriptionBindingId: await (await import('@/lib/model-dispatch')).bindAgentToConnection(tx,
          { ownerId: task.userId, workspaceId: source.workspaceId }, runtime.agentId, target.harness, entry.connectionId, target.model) }) }
    } else if (selectStageProfile && !checkStart) model = await chooseCloudRunModel(pool, { ownerId: task.userId, workspaceId: source.workspaceId, botId: task.botId }, runtime.agentId, source.harness, undefined, source.remoteUrl ? 'task' : 'desktop')
    if ('error' in model || !('model' in model) || typeof model.model !== 'string') throw new FactoryError('factoryCheckHarnessUnavailable')
    const cloudModel = model.model
    const repoId = source.remoteUrl ? (await ensureDeviceRepository(task.userId, runtime.deviceId, source.remoteUrl, tx)).id : runtime.repoId
    const { rows: [issue] } = await tx.query('SELECT title,content FROM issues WHERE id=$1', [task.issueId])
    const actor = { userId: task.userId, workspaceId: source.workspaceId as string }
    const dispatch = createFactoryDispatch(pool, store, (client, _owner, _input, _bot, context) => queueCloudRun(pool, actor, {
      botId: runtimeBotId, issueId: task.issueId, agentId: runtime.agentId, deviceRepoId: repoId, title: issue.title, body: tiptapToText(issue.content), ...model, model: cloudModel, ...inheritedPolicy,
      withoutBot: task.botId === null, ...(continueImplementation ? { threadRunId: source.id } : {}), readOnly: check || (continueImplementation && source.agentDefinition?.readOnly), idempotencyKey: `factory:${context.attemptId}`,
      allowLocalRecovery: source.agentDefinition?.allowLocalRecovery, sourceEventId: context.sourceEventId,
    }, client, context), { ...defaultFactoryDispatchAdapters, configure: {
      ...defaultFactoryDispatchAdapters.configure,
      review: (client, current, id) => configureFactoryCheck(client, current, id, checkStart?.selection.policyCeiling),
      verify: (client, current, id) => configureFactoryCheck(client, current, id, checkStart?.selection.policyCeiling),
    } })
    const result = await dispatch(task.userId, { binding: factoryBinding(task), agentId: runtime.agentId, deviceRepoId: repoId }, tx)
    await assertFrozenDispatch(result.runId)
    await registerRoutingAdmission(result.runId)
    if (continueImplementation) await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [result.runId, source.id])
    return async () => {
      // A host workflow owns the handoff. Parking revokes the completed
      // worker's device token; its request must not perform the next stage's
      // database work under that now-revoked device authority.
      try { await factoryAutomaticRuntime.enqueue(pool, actor, typeof _run.id === 'string' ? _run.id : null, result.runId) }
      catch { await (await import('./cloud-stage-handoff')).failFactoryCloudStage(pool, actor, result.runId, 'Cloud stage handoff could not be queued') }
    }
  })
}
