import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { assertFlashTestModel } from '../test-model-policy.mjs'

const check = (condition, code) => { if (!condition) throw Error(`acceptance_factory_${code}`) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const ended = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
const stateOf = snapshot => ({ taskId: snapshot.task.id, issueId: snapshot.task.issueId,
  requestEpoch: snapshot.task.sourceEventId, stage: snapshot.task.stage, status: snapshot.task.status,
  revision: snapshot.task.revision, attemptId: snapshot.task.attemptId, candidateId: snapshot.task.candidateId,
  attempts: snapshot.attempts.map(a => ({ id: a.id, stage: a.stage, status: a.status, runId: a.runId, requestEpoch: a.output?.requestEpoch })) })

/** Paid, real API acceptance when called by the owner-session driver. The unit
 * tests exercise this driver's assertions only; they are not live acceptance.
 * This is Flash API-key execution, never official Codex/Claude subscription
 * acceptance. It accepts two independently checked artifact versions under
 * successive request epochs, then stops a third epoch while retaining both. */
export async function runGroupFactoryScenario({ report, json, readTurn, guard, download,
  wait = delay, now = Date.now, timeoutMs = 1200000, stopTimeoutMs = 180000 }) {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3600000, 'timeout_invalid')
  const reporter = report.bots.find(bot => bot.role === 'Coding')
  check(reporter && uuid(reporter.id) && uuid(report.conversationId), 'fixture_missing')
  const groupId = report.conversationId
  const evidence = { name: 'group-factory-artifact-continuation-stop', status: 'running',
    executionPolicy: 'DeepSeek Flash API key; not official subscription acceptance',
    reporterId: reporter.id, phase: 'preflight', messages: [], runs: [], observations: [] }
  report.cases.push(evidence)
  const roots = new Set()
  const runs = new Map()
  const filename = `group-factory-${report.fixtureId.slice(0, 8)}.txt`
  const content = `mikka-group-factory:${report.fixtureId}\nstatus=ready\n`
  const expected = Buffer.from(content, 'utf8')
  evidence.expectedArtifact = { title: filename, bytes: expected.length, sha256: hash(expected) }

  async function executionGuard() {
    await guard()
    const order = await json(`/api/settings/model-order?workspace=${encodeURIComponent(report.workspaceId)}`)
    check(!order?.error && order?.entries?.length > 0, 'execution_order_missing')
    // The workspace order is distinct from each Bot's chat model. Do not alter
    // existing account preferences or quietly permit a paid fallback here.
    for (const entry of order.entries) {
      try { assertFlashTestModel(entry.model) } catch { check(false, 'execution_model_forbidden') }
      check(entry.provider === 'deepseek' && entry.source?.kind === 'api_key', 'execution_credential_forbidden')
    }
    check(order.location === 'cloud' && order.cloudReady === true, 'cloud_unavailable')
    evidence.executionModels = order.entries.map(({ harness, model, provider }) => ({ harness, model, provider, credentialType: 'api_key' }))
  }
  function inspectTurn(result, messageId, operation) {
    const trace = result.turn.trace
    check(trace?.action === 'delegate' && trace.responders?.length === 1 && trace.responders[0] === reporter.id, 'reporter_mismatch')
    check(trace.execution?.executionId && trace.execution?.providerGenerationId && trace.execution?.requestDigest, 'decision_receipt_missing')
    check(!trace.events.some(event => ['generate', 'private_publish'].includes(event.type)), 'unexpected_group_generation')
    check(new Set(trace.events.map(event => event.id)).size === trace.events.length, 'duplicate_trace_event')
    const delegated = trace.events.filter(event => event.type === 'delegate')
    if (['create', 'continue'].includes(operation)) {
      check(delegated.length === 1 && delegated[0].outcome === 'succeeded' && delegated[0].memberId === reporter.id
        && uuid(delegated[0].taskId) && uuid(delegated[0].runId), 'dispatch_unconfirmed')
    } else check(delegated.length === 0, 'status_or_stop_dispatched_work')
    for (const item of result.page.messages.filter(item => roots.has(item.replyToId) && item.authorType !== 'user')) {
      check(item.authorType === 'bot' && item.authorId === reporter.id, 'multiple_reporters')
    }
    for (const event of trace.events.filter(event => ['publish', 'task_result', 'delegate'].includes(event.type)))
      check(event.memberId === reporter.id, 'trace_reporter_mismatch')
    return { trace, delegated: delegated[0], replyIds: result.page.messages.filter(item => item.replyToId === messageId && item.authorType !== 'user').map(item => item.id).sort() }
  }
  async function post(operation, body) {
    evidence.phase = operation
    await executionGuard()
    const message = await json(`/api/conversations/${groupId}/messages`, { body, mentions: [] })
    check(uuid(message?.id), 'message_missing')
    roots.add(message.id)
    const record = { operation, messageId: message.id }
    evidence.messages.push(record)
    const result = await readTurn(groupId, message.id)
    const inspected = inspectTurn(result, message.id, operation)
    Object.assign(record, { decisionExecutionId: inspected.trace.execution.executionId,
      taskId: inspected.delegated?.taskId, runId: inspected.delegated?.runId })
    return { ...inspected, messageId: message.id }
  }
  async function readTask(taskId) {
    const state = await json(`/api/factory/tasks/${taskId}`)
    check(state?.task?.id === taskId && Array.isArray(state.attempts), 'task_missing')
    const compact = stateOf(state)
    evidence.lastTask = compact
    const progress = JSON.stringify(compact)
    if (progress !== evidence.observations.at(-1)?.state) {
      evidence.observations.push({ at: new Date(now()).toISOString(), state: progress })
      evidence.observations = evidence.observations.slice(-30)
    }
    return state
  }
  async function inspectRun(runId, issueId, refresh = false) {
    if (runs.has(runId) && !refresh) return runs.get(runId)
    const found = await json(`/api/runs/${runId}/evidence`)
    check(found?.run?.id === runId && found.run.issueId === issueId && found.run.botId === reporter.id, 'run_scope_mismatch')
    try { assertFlashTestModel(found.run.model) } catch { check(false, 'run_model_forbidden') }
    check(found.run.credentialType === 'api_key' && !found.run.subscriptionRoute, 'run_credential_forbidden')
    const identity = found.run.executionIdentity
    check(identity?.version === 1 && identity.requester === report.requesterId && identity.executionPrincipal === report.requesterId
      && identity.outputOwner === report.requesterId && identity.botId === reporter.id && identity.botOwner === report.requesterId
      && identity.workspaceId === report.workspaceId && identity.personalResourcePolicy === 'requester_only', 'run_identity_mismatch')
    const payer = identity.billingAccount?.model, runtimePayer = identity.billingAccount?.runtime
    const modelResource = identity.resourceBindings?.find(resource => resource.kind === 'api_key' && resource.id === payer?.resourceId)
    check(payer?.kind === 'api_key' && payer.amount === 'provider_unknown' && modelResource?.ownerId === payer.ownerId
      && (payer.ownerId === report.requesterId ? modelResource.access === 'owner' : modelResource.access === 'workspace_share')
      && runtimePayer?.kind === 'e2b' && runtimePayer.ownerId === report.requesterId && runtimePayer.amount === 'provider_unknown', 'run_billing_mismatch')
    runs.set(runId, found)
    evidence.runs = [...runs.values()].map(({ run }) => ({ id: run.id, status: run.status, harness: run.harness, model: run.model, credentialType: run.credentialType,
      requester: run.executionIdentity.requester, executionPrincipal: run.executionIdentity.executionPrincipal, outputOwner: run.executionIdentity.outputOwner,
      modelAccountOwner: run.executionIdentity.billingAccount.model.ownerId, runtimeAccountOwner: run.executionIdentity.billingAccount.runtime.ownerId,
      externalCost: 'provider_unknown' }))
    return found
  }
  async function onlyTask(task) {
    const list = await json(`/api/factory/tasks?issueId=${encodeURIComponent(task.issueId)}`)
    check(Array.isArray(list) && list.length === 1 && list[0].id === task.id, 'duplicate_task')
  }
  async function stable(messageId, operation, taskId) {
    const before = inspectTurn(await readTurn(groupId, messageId), messageId, operation)
    const state = stateOf(await readTask(taskId))
    for (let read = 0; read < 2; read++) {
      const after = inspectTurn(await readTurn(groupId, messageId), messageId, operation)
      check(JSON.stringify(after.trace.events) === JSON.stringify(before.trace.events)
        && JSON.stringify(after.replyIds) === JSON.stringify(before.replyIds), 'replayed_group_effect')
      check(JSON.stringify(stateOf(await readTask(taskId))) === JSON.stringify(state), 'read_changed_task')
    }
    return { messageId, repeatReads: 2, replyIds: before.replyIds, traceEventIds: before.trace.events.map(event => event.id) }
  }
  async function artifactProof(candidate, task, target = expected) {
    const found = await inspectRun(candidate.runId, task.issueId, true)
    const artifacts = found.artifacts.filter(item => item.title === filename)
    check(artifacts.length === 1 && uuid(artifacts[0].id), 'artifact_missing_or_ambiguous')
    const artifact = artifacts[0]
    const bytes = await download(artifact.url)
    check(bytes.length === target.length && hash(bytes) === hash(target), 'artifact_content_mismatch')
    return { artifactId: artifact.id, version: artifact.latestVersion, runId: candidate.runId, title: filename,
      bytes: bytes.length, sha256: hash(bytes), url: artifact.url }
  }

  const created = await post('create', `请负责代码实现的 Coding Bot 在云端实际执行一个独立 Factory 任务，并由同一个 Bot 统一汇报，其他 Bot 不要插话。任务只需创建并交付可下载的纯文本文件 ${filename}，不要建立代码仓库或发送外部消息。文件必须是以下 JSON 字符串解码后的精确 UTF-8 字节（包括最后换行）：${JSON.stringify(content)}。使用当前已授权的 DeepSeek Flash API key 执行，不切换模型。请检查文件字节与内容，将文件作为 Artifact 发布，正常提交执行结果，交给独立审查和验证；不能用聊天文本或模拟报告代替文件。完成后汇报 Task、Thread 和 Artifact 链接。`)
  evidence.taskId = created.delegated.taskId
  evidence.phase = 'independent-checks'
  const deadline = now() + timeoutMs
  let ready
  while (now() < deadline) {
    await guard()
    const state = await readTask(evidence.taskId)
    evidence.issueId = state.task.issueId
    evidence.requestEpoch = state.task.sourceEventId
    for (const attempt of state.attempts.filter(a => a.runId)) await inspectRun(attempt.runId, state.task.issueId)
    check(!['cancelled', 'revoked', 'blocked', 'failed'].includes(state.task.status), 'task_blocked')
    if (state.task.stage === 'approval' && ['pending', 'waiting'].includes(state.task.status)) { ready = state; break }
    await readTurn(groupId, created.messageId)
    await wait(3000)
  }
  check(ready, 'task_timeout')
  await onlyTask(ready.task)
  const candidate = ready.candidates.find(item => item.id === ready.task.candidateId)
  check(candidate && ['report', 'deliverable'].includes(candidate.kind), 'deliverable_candidate_missing')
  const checks = ['review', 'verify'].map(stage => ready.attempts.findLast(a => a.stage === stage && a.status === 'passed'
    && a.candidateId === candidate.id && a.output?.requestEpoch === ready.task.sourceEventId))
  check(checks.every(a => a?.runId && a.output?.check?.requestEpoch === ready.task.sourceEventId), 'independent_checks_missing')
  check(new Set([candidate.runId, ...checks.map(a => a.runId)]).size === 3, 'checks_not_independent')
  evidence.checks = checks.map(a => ({ stage: a.stage, attemptId: a.id, runId: a.runId, candidateId: a.candidateId, requestEpoch: a.output.requestEpoch }))
  evidence.artifact = await artifactProof(candidate, ready.task)
  evidence.phase = 'human-acceptance'
  const input = { binding: { taskId: ready.task.id, issueId: ready.task.issueId, attemptId: ready.task.attemptId,
    revision: ready.task.revision, candidateId: ready.task.candidateId }, eventId: randomUUID() }
  const accepted = await json(`/api/factory/tasks/${ready.task.id}/approval`, { operation: 'accept', input })
  check(accepted?.status === 'accepted' && uuid(accepted.acceptanceId), 'acceptance_unconfirmed')
  const replay = await json(`/api/factory/tasks/${ready.task.id}/approval`, { operation: 'accept', input })
  check(replay?.status === 'accepted' && replay.acceptanceId === accepted.acceptanceId, 'duplicate_acceptance')
  evidence.acceptance = { acceptanceId: accepted.acceptanceId, eventId: input.eventId, replayConfirmed: true }
  const acceptedState = await readTask(ready.task.id)
  check(acceptedState.task.stage === 'approval' && acceptedState.task.status === 'passed', 'acceptance_state_mismatch')
  evidence.phase = 'final-reporter'
  const reportDeadline = now() + 120000
  let final
  while (now() < reportDeadline) {
    const current = await readTurn(groupId, created.messageId)
    const inspected = inspectTurn(current, created.messageId, 'create')
    const finalEvent = inspected.trace.events.find(e => e.type === 'task_result' && e.taskId === ready.task.id && e.outcome === 'succeeded')
    const linked = current.page.messages.filter(item => item.replyToId === created.messageId && item.authorType === 'bot'
      && item.authorId === reporter.id && item.body.includes(`artifact=${evidence.artifact.artifactId}`) && item.body.includes(`issue=${ready.task.issueId}`))
    if (finalEvent && inspected.trace.taskFinishedAt && linked.length) { final = { eventId: finalEvent.id, messageIds: linked.map(item => item.id), reporterId: reporter.id }; break }
    await wait(2000)
  }
  check(final, 'final_report_timeout')
  evidence.finalReport = final
  evidence.createReplay = await stable(created.messageId, 'create', ready.task.id)
  const status = await post('status', `请由同一 Coding Bot 查询现有任务 ${ready.task.issueId} 的真实状态和成果链接。仅查询状态，不新建任务、不重新执行、不改变要求。`)
  check(JSON.stringify(stateOf(await readTask(ready.task.id))) === JSON.stringify(stateOf(acceptedState)), 'status_changed_task')
  evidence.statusReplay = await stable(status.messageId, 'status', ready.task.id)
  const continued = await post('continue', `继续现有任务 ${ready.task.issueId}，仍由同一 Coding Bot 执行并统一汇报。把同一个文件 ${filename} 的 status=ready 改成 status=continued，保留其他字节和最终换行，继续使用 DeepSeek Flash。不要创建另一项任务。`)
  check(continued.delegated.taskId === ready.task.id, 'continuation_changed_task')
  const continuation = await readTask(ready.task.id)
  check(continuation.task.sourceEventId !== ready.task.sourceEventId && continuation.task.sourceEventId, 'continuation_epoch_unchanged')
  check(continuation.attempts.some(a => a.runId === continued.delegated.runId && a.output?.requestEpoch === continuation.task.sourceEventId), 'continuation_run_missing')
  for (const old of acceptedState.attempts.filter(a => a.status === 'passed'))
    check(continuation.attempts.find(a => a.id === old.id)?.status === 'passed', 'accepted_history_changed')
  await inspectRun(continued.delegated.runId, ready.task.issueId)
  await onlyTask(continuation.task)
  evidence.continuation = { taskId: ready.task.id, runId: continued.delegated.runId, previousEpoch: ready.task.sourceEventId,
    requestEpoch: continuation.task.sourceEventId, outcome: 'running', updatedArtifactVerified: false }
  evidence.phase = 'continuation-independent-checks'
  const continuedExpected = Buffer.from(content.replace('status=ready', 'status=continued'), 'utf8')
  const continuationDeadline = now() + timeoutMs
  let continuedReady
  while (now() < continuationDeadline) {
    await guard()
    const state = await readTask(ready.task.id)
    check(state.task.sourceEventId === continuation.task.sourceEventId, 'continuation_epoch_changed')
    for (const attempt of state.attempts.filter(a => a.runId && a.output?.requestEpoch === state.task.sourceEventId))
      await inspectRun(attempt.runId, state.task.issueId)
    check(!['cancelled', 'revoked', 'blocked', 'failed'].includes(state.task.status), 'continuation_blocked')
    if (state.task.stage === 'approval' && ['pending', 'waiting'].includes(state.task.status)) { continuedReady = state; break }
    await readTurn(groupId, continued.messageId)
    await wait(3000)
  }
  check(continuedReady, 'continuation_timeout')
  const continuedCandidate = continuedReady.candidates.find(item => item.id === continuedReady.task.candidateId)
  check(continuedCandidate && continuedCandidate.id !== candidate.id && ['report', 'deliverable'].includes(continuedCandidate.kind), 'continuation_candidate_missing')
  const continuedChecks = ['review', 'verify'].map(stage => continuedReady.attempts.findLast(a => a.stage === stage && a.status === 'passed'
    && a.candidateId === continuedCandidate.id && a.output?.requestEpoch === continuation.task.sourceEventId))
  check(continuedChecks.every(a => a?.runId && a.output?.check?.requestEpoch === continuation.task.sourceEventId), 'continuation_checks_missing')
  check(new Set([continuedCandidate.runId, ...continuedChecks.map(a => a.runId)]).size === 3, 'continuation_checks_not_independent')
  evidence.continuation.checks = continuedChecks.map(a => ({ stage: a.stage, attemptId: a.id, runId: a.runId, candidateId: a.candidateId, requestEpoch: a.output.requestEpoch }))
  evidence.continuation.artifact = await artifactProof(continuedCandidate, continuedReady.task, continuedExpected)
  evidence.phase = 'continuation-human-acceptance'
  const continuationInput = { binding: { taskId: ready.task.id, issueId: ready.task.issueId, attemptId: continuedReady.task.attemptId,
    revision: continuedReady.task.revision, candidateId: continuedCandidate.id }, eventId: randomUUID() }
  const continuedAccepted = await json(`/api/factory/tasks/${ready.task.id}/approval`, { operation: 'accept', input: continuationInput })
  check(continuedAccepted?.status === 'accepted' && uuid(continuedAccepted.acceptanceId)
    && continuedAccepted.acceptanceId !== accepted.acceptanceId, 'continuation_acceptance_unconfirmed')
  const continuedReplay = await json(`/api/factory/tasks/${ready.task.id}/approval`, { operation: 'accept', input: continuationInput })
  check(continuedReplay?.status === 'accepted' && continuedReplay.acceptanceId === continuedAccepted.acceptanceId, 'continuation_duplicate_acceptance')
  evidence.continuation.acceptance = { acceptanceId: continuedAccepted.acceptanceId, eventId: continuationInput.eventId, replayConfirmed: true }
  const continuedAcceptedState = await readTask(ready.task.id)
  check(continuedAcceptedState.task.stage === 'approval' && continuedAcceptedState.task.status === 'passed', 'continuation_acceptance_state_mismatch')
  for (const old of acceptedState.attempts.filter(a => a.status === 'passed'))
    check(continuedAcceptedState.attempts.find(a => a.id === old.id)?.status === 'passed', 'accepted_history_changed')
  const continuedReportDeadline = now() + 120000
  let continuedFinal
  while (now() < continuedReportDeadline) {
    const current = await readTurn(groupId, continued.messageId)
    const inspected = inspectTurn(current, continued.messageId, 'continue')
    const finalEvent = inspected.trace.events.find(e => e.type === 'task_result' && e.taskId === ready.task.id && e.outcome === 'succeeded')
    const linked = current.page.messages.filter(item => item.replyToId === continued.messageId && item.authorType === 'bot'
      && item.authorId === reporter.id && item.body.includes(`artifact=${evidence.continuation.artifact.artifactId}`) && item.body.includes(`issue=${ready.task.issueId}`))
    if (finalEvent && inspected.trace.taskFinishedAt && linked.length) { continuedFinal = { eventId: finalEvent.id, messageIds: linked.map(item => item.id), reporterId: reporter.id }; break }
    await wait(2000)
  }
  check(continuedFinal, 'continuation_final_report_timeout')
  evidence.continuation.finalReport = continuedFinal
  evidence.continuation.replay = await stable(continued.messageId, 'continue', ready.task.id)
  evidence.continuation.updatedArtifactVerified = true
  evidence.continuation.outcome = 'completed_and_accepted'
  const stopTarget = await post('continue', `继续现有任务 ${ready.task.issueId}，仍由同一 Coding Bot 执行并统一汇报。把文件 ${filename} 的 status=continued 改成 status=stopping，保留其他字节和最终换行，继续使用 DeepSeek Flash。不要创建另一项任务。`)
  check(stopTarget.delegated.taskId === ready.task.id, 'stop_continuation_changed_task')
  const stopContinuation = await readTask(ready.task.id)
  check(stopContinuation.task.sourceEventId && stopContinuation.task.sourceEventId !== continuation.task.sourceEventId, 'stop_continuation_epoch_unchanged')
  check(stopContinuation.attempts.some(a => a.runId === stopTarget.delegated.runId && a.output?.requestEpoch === stopContinuation.task.sourceEventId), 'stop_continuation_run_missing')
  evidence.stopContinuation = { taskId: ready.task.id, runId: stopTarget.delegated.runId,
    previousEpoch: continuation.task.sourceEventId, requestEpoch: stopContinuation.task.sourceEventId, outcome: 'admitted_then_cancelled', updatedArtifactVerified: false }
  const stopped = await post('stop', `请由同一 Coding Bot 立即停止现有任务 ${ready.task.issueId} 的这次续作。只取消当前任务并报告真实停止状态，不创建新任务，不再执行。保留之前已验收的成果。`)
  const stopDeadline = now() + stopTimeoutMs
  let stoppedState
  while (now() < stopDeadline) {
    const state = await readTask(ready.task.id)
    check(['cancelled', 'revoked'].includes(state.task.status) && state.task.sourceEventId === stopContinuation.task.sourceEventId, 'stop_not_confirmed')
    const currentRuns = await Promise.all(state.attempts.filter(a => a.output?.requestEpoch === state.task.sourceEventId && a.runId)
      .map(a => inspectRun(a.runId, ready.task.issueId, true)))
    if (currentRuns.every(item => ended.has(item.run.status))) { stoppedState = state; break }
    await wait(2000)
  }
  check(stoppedState, 'stop_ack_timeout')
  evidence.stopReplay = await stable(stopped.messageId, 'stop', ready.task.id)
  await onlyTask(stoppedState.task)
  // A cancelled continuation must not destroy the exact earlier deliverable.
  const retained = await download(evidence.artifact.url)
  check(retained.length === expected.length && hash(retained) === hash(expected), 'accepted_artifact_changed')
  evidence.artifact.retainedAfterStop = true
  delete evidence.artifact.url
  const continuedRetained = await download(evidence.continuation.artifact.url)
  check(continuedRetained.length === continuedExpected.length && hash(continuedRetained) === hash(continuedExpected), 'continued_artifact_changed')
  evidence.continuation.artifact.retainedAfterStop = true
  delete evidence.continuation.artifact.url
  await guard()
  evidence.phase = 'complete'
  evidence.status = 'pass'
  return evidence
}
