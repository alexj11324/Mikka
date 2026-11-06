#!/usr/bin/env node
/** One bounded normal-owner migration proof. No test workflow, SQL, cron call,
 * external message, provider login, SDK mutation or broad action transport. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { attestProductionReadCache, mergeReadChat, productionGuard, responseCookieJar } from './read-cache-production.mjs'
import { api as vercelRead, activeAlias, PROJECT, PRODUCTION_ALIAS, TEAM } from '../ops/deployment-regression.mjs'
import { DeployedTargetError, assertDeployedTarget, publicTargetFailure } from './deployed-target.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const CHAT = '/mikka/api/coordinator/messages'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RUN = /^wrun_[A-Za-z0-9_-]{10,160}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw new ProofError(code) }
const CODES = new Set(['attestation_failed', 'account_required', 'manager_token_required', 'manager_read_unavailable',
  'deployment_mismatch', 'session_identity', 'session_close_failed', 'http_failed', 'redirect_refused',
  'chat_invalid', 'coordinator_disabled', 'coordinator_busy', 'unexpected_tool', 'creation_ambiguous',
  'submission_failed', 'schedule_not_observed', 'coordinator_not_completed', 'timer_not_observed',
  'managed_evidence_missing', 'reminder_not_observed', 'future_schedule_unproven', 'proof_failed'])
export class ProofError extends Error {
  constructor(code) { super(CODES.has(code) ? code : 'proof_failed'); this.code = this.message }
}
const time = value => value instanceof Date ? value.getTime() : Date.parse(value)
const workflow = (value, file, name) => value === 'workflow//' + file + '//' + name || value === 'workflow//./' + file + '//' + name
const stepName = value => value === 'step//workflows/due-timer/steps.ts//runDue' || value === 'step//./workflows/due-timer/steps.ts//runDue'
const tools = item => item.activity?.tools ?? []
const freshItems = (chat, after) => (chat.items ?? []).filter(item => !item.pending && item.position > after)
const runId = item => typeof item.streamId === 'string' ? item.streamId.replace(/:\d+$/, '') : null

export function reminderDefinition(marker, at) {
  check(/^m1415-[0-9a-f]{12}$/.test(marker) && Number.isFinite(time(at)), 'proof_failed')
  return { title: marker, timezone: 'UTC', timing: { kind: 'once', at },
    task: { kind: 'reminder', text: marker }, misfire: 'skip', maxLatenessMinutes: 2 }
}

export function creationEvidence(chat, after, marker, at) {
  const found = []
  check(freshItems(chat, after).flatMap(tools).filter(tool => tool.name === 'schedule_create' && tool.state === 'done').length <= 1, 'creation_ambiguous')
  for (const item of freshItems(chat, after)) {
    if (item.from !== 'coordinator') continue
    for (const tool of tools(item)) {
      if (tool.name !== 'schedule_create' || tool.state !== 'done') continue
      const input = tool.input ?? '', output = tool.output ?? ''
      // Actual public previews are PostgreSQL jsonb text, capped at 200 chars.
      // These three complete nested values fit in that prefix for this marker.
      if (!input.startsWith('{"definition": {') || !input.includes('"title": "' + marker + '"')) continue
      const task = '"task": {"kind": "reminder", "text": "' + marker + '"}'
      const timing = '"timing": {"at": "' + at + '", "kind": "once"}'
      check(input.includes(task) && input.includes(timing), 'creation_ambiguous')
      const match = new RegExp('"schedule": \\{"id": "(' + UUID + ')"', 'i').exec(output)
      check(match && /"replayed": false/.test(output) && output.includes('"bot_id": "' + chat.botId + '"')
        && RUN.test(runId(item) ?? ''), 'creation_ambiguous')
      found.push({ scheduleId: match[1].toLowerCase(), coordinatorRunId: runId(item), call: tool.call })
    }
  }
  const unique = [...new Map(found.map(item => [item.call, item])).values()]
  check(unique.length <= 1, 'creation_ambiguous')
  return unique[0] ?? null
}

export function occurrenceEvidence(chat, after, marker, scheduleId) {
  const pattern = new RegExp('^\\[Schedule (' + UUID + '); occurrence (' + UUID + '); operation (' + UUID + ')\\] '
    + marker + ': succeeded\\n' + marker + '$', 'i')
  for (const item of freshItems(chat, after)) {
    const match = pattern.exec(item.text ?? '')
    // The store commits the outcome message with id=operation_id. A model's
    // textual claim cannot satisfy that host-written message identity.
    if (item.from === 'coordinator' && match && match[1].toLowerCase() === scheduleId
      && item.id?.toLowerCase() === match[3].toLowerCase() && !item.streamId)
      return { occurrenceId: match[2].toLowerCase(), operationId: match[3].toLowerCase(), createdAt: time(item.createdAt) }
  }
  return null
}

export function managedEvidence({ coordinator, timer, events, deploymentId, dueAt, occurrenceAt, startedAt }) {
  if (!coordinator || !timer || coordinator.status !== 'completed' || coordinator.deploymentId !== deploymentId
    || timer.deploymentId !== deploymentId || !workflow(coordinator.workflowName, 'workflows/coordinator/workflow.ts', 'coordinatorTurn')
    || !workflow(timer.workflowName, 'workflows/due-timer/workflow.ts', 'dueTimer')
    || time(coordinator.createdAt) < startedAt - 1000) return null
  const due = time(dueAt)
  if (![due, occurrenceAt, startedAt].every(Number.isFinite) || occurrenceAt < due || occurrenceAt > due + 120_000) return null
  const created = events.find(event => event.runId === timer.runId && event.eventType === 'wait_created'
    && time(event.eventData?.resumeAt) === due && time(event.createdAt) >= startedAt - 1000)
  if (!created) return null
  const completed = events.find(event => event.runId === timer.runId && event.eventType === 'wait_completed'
    && event.correlationId === created.correlationId && time(event.createdAt) >= due
    && time(event.createdAt) <= due + 120_000)
  if (!completed) return null
  let step, started, finished
  // SDK pages are descending. A newer incomplete runDue must not mask an
  // eligible completed correlation already present in the same bounded window.
  for (const candidate of events) {
    if (candidate.runId !== timer.runId || candidate.eventType !== 'step_created'
      || !stepName(candidate.eventData?.stepName) || time(candidate.createdAt) < time(completed.createdAt)
      || !Number.isFinite(time(candidate.createdAt)) || time(candidate.createdAt) > due + 120_000) continue
    const start = events.find(event => event.runId === timer.runId && event.eventType === 'step_started'
      && event.correlationId === candidate.correlationId && time(event.createdAt) >= time(candidate.createdAt)
      && time(event.createdAt) <= due + 120_000)
    const finish = start && events.find(event => event.runId === timer.runId && event.eventType === 'step_completed'
      && event.correlationId === candidate.correlationId && time(event.createdAt) >= time(start.createdAt)
      && time(event.createdAt) <= due + 120_000)
    if (finish) { step = candidate; started = start; finished = finish; break }
  }
  if (!finished) return null
  return { coordinatorCompleted: true, dueTimerObserved: true, waitCreatedAt: new Date(time(created.createdAt)).toISOString(),
    dueAt, waitCompletedAt: new Date(time(completed.createdAt)).toISOString(),
    runDueCreatedAt: new Date(time(step.createdAt)).toISOString(),
    runDueStartedAt: new Date(time(started.createdAt)).toISOString(),
    runDueCompletedAt: new Date(time(finished.createdAt)).toISOString(), timerTerminalRequired: false,
    // The SDK's optimistic inline execution can persist created/started after
    // the business write. Observe both real outcomes without inventing a cross-
    // clock ordering or claiming that a concurrent reconciliation was excluded.
    concurrentReconciliationExcluded: false,
    coordinatorRunHash: hash(coordinator.runId), timerRunHash: hash(timer.runId) }
}

export function cancellationObserved(chat, after, scheduleId) {
  return freshItems(chat, after).some(item => item.from === 'coordinator' && tools(item).some(tool => {
    if (tool.name !== 'schedule_cancel' || tool.state !== 'done') return false
    try { const input = JSON.parse(tool.input); return input.scheduleId === scheduleId && Number.isSafeInteger(input.version) && input.version > 0 }
    catch { return false }
  }))
}

export async function readTimerHook(read) {
  try { return await read() }
  catch (error) {
    // Locked SDK HookNotFoundError has no HTTP status field.
    if (error instanceof Error && error.name === 'HookNotFoundError') return null
    throw error
  }
}

/** The existing platform identity authenticates this SDK manager separately
 * from the ordinary owner cookie. Only read closures leave this factory. */
export async function managedReader(token) {
  check(typeof token === 'string' && token.length > 0, 'manager_token_required')
  for (const key of ['WORKFLOW_VERCEL_BACKEND_URL', 'VERCEL_WORKFLOW_SERVER_URL', 'WORKFLOW_SERVER_URL_OVERRIDE'])
    check(!process.env[key], 'manager_read_unavailable')
  const sdkRequire = createRequire(import.meta.resolve('workflow'))
  const { createStorage } = await import(pathToFileURL(sdkRequire.resolve('@workflow/world-vercel')).href)
  const storage = createStorage({ token, projectConfig: { projectId: PROJECT, teamId: TEAM, environment: 'production' } })
  return {
    async probe() {
      const rows = await storage.runs.list({ resolveData: 'none', pagination: { limit: 1, sortOrder: 'desc' } })
      check(Array.isArray(rows.data), 'manager_read_unavailable')
    },
    getRun: id => storage.runs.get(id, { resolveData: 'none' }),
    timer: () => readTimerHook(() => storage.hooks.getByToken('due-timer:schedules')),
    async events(runId, since) {
      const values = []; let cursor
      for (let page = 0; page < 20; page++) {
        const result = await storage.events.list({ runId, resolveData: 'none', pagination: { limit: 100, sortOrder: 'desc', ...(cursor ? { cursor } : {}) } })
        check(Array.isArray(result.data) && result.data.every(event => event.runId === runId), 'manager_read_unavailable')
        values.push(...result.data)
        if (!result.hasMore || result.data.some(event => time(event.createdAt) < since)) return values
        check(typeof result.cursor === 'string' && result.cursor !== cursor, 'manager_read_unavailable'); cursor = result.cursor
      }
      throw new ProofError('manager_read_unavailable')
    },
  }
}

export async function runWorkflowMigrationProof({ env = process.env, event, fetchImpl = fetch, now = Date.now,
  wait = sleep, readerFactory = managedReader, attestation } = {}) {
  const guard = productionGuard(env, event), deployed = guard.targetMode === 'deployed-target'
  const report = { version: 1, purpose: 'workflow-migration-production', issue: 1415,
    applicationSha: guard.applicationSha, driverRevision: guard.driverRevision, webDeployRunId: guard.webDeployRunId,
    status: 'running', normalSessionObserved: false, sessionClosed: false, submissionCount: 0, cleanupSubmissionCount: 0,
    sdkMutations: 0, cronRequests: 0, databaseWritesByDriver: 0, providerLoginTested: false,
    startedAt: new Date(now()).toISOString(), futureScheduleConfirmedAbsent: false }
  if (deployed) Object.assign(report, { targetMode: guard.targetMode, driverRunId: guard.driverRunId,
    driverRunAttempt: guard.driverRunAttempt, deploymentId: guard.deploymentId })
  let proof
  try { proof = deployed ? await assertDeployedTarget({ env, event, attestation, fetchImpl, now })
    : await attestProductionReadCache({ env, event, fetchImpl, now, issueNumber: 1415 }) }
  catch (error) { return { ...report, ...(deployed ? publicTargetFailure(error) : { status: 'blocked', code: 'attestation_failed' }) } }
  if (deployed) Object.assign(report, { targetBefore: proof, webAttempt: proof.webAttempt, webDeployJobId: proof.webDeployJobId })
  if (!proof.readable) return { ...report, status: 'skipped', code: 'issue_closed' }
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD, token = env.VERCEL_TEAM_TOKEN
  check(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account_required')
  check(typeof token === 'string' && token.length > 0, 'manager_token_required')
  const cookies = responseCookieJar(now), started = now(), deadline = started + 7 * 60_000
  const marker = 'm1415-' + randomUUID().replaceAll('-', '').slice(0, 12)
  const at = new Date(Math.ceil(now() / 1000) * 1000 + 180_000).toISOString()
  const definition = reminderDefinition(marker, at)
  let closeSession = false, owner, chat, baseline = 0, etag, schedule, occurrence, timerId, managed, deploymentId
  const request = async (path, body, cleanup = false) => {
    check(path === CHAT || path.startsWith(CHAT + '?') || ['/mikka/api/version', '/mikka/api/auth/get-session',
      '/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out', '/mikka/api/workspace', '/mikka/api/rpc'].includes(path), 'http_failed')
    check(body === undefined || path === CHAT || path.endsWith('/sign-in/email') || path.endsWith('/sign-out')
      || path === '/mikka/api/rpc' && body.version === DESKTOP_RPC_VERSION && body.action === 'coordinator.coordinatorHistory'
      && Array.isArray(body.args) && body.args.length === 3 && body.args[0] === chat?.botId
      && Number.isSafeInteger(body.args[1]) && body.args[1] >= baseline && body.args[2] === 1, 'http_failed')
    const url = new URL(path, ORIGIN), headers = new Headers({ origin: ORIGIN, 'cache-control': 'no-store' })
    const cookie = cookies.header(url); if (cookie) headers.set('cookie', cookie)
    if (body !== undefined) headers.set('content-type', 'application/json')
    if (path === '/mikka/api/rpc') headers.set('x-mikka-rpc', '1')
    if (path.startsWith(CHAT) && body === undefined && etag) headers.set('if-none-match', etag)
    const timeout = cleanup ? 20_000 : Math.min(20_000, deadline - now())
    check(timeout > 0, 'http_failed')
    let response
    try { response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeout) }) }
    catch { throw new ProofError('http_failed') }
    check(!response.redirected && (response.status < 300 || response.status >= 400 || response.status === 304)
      && (!response.url || new URL(response.url).origin === ORIGIN), 'redirect_refused')
    cookies.receive(url, response.headers)
    return response
  }
  const json = async (path, body, cleanup) => {
    const response = await request(path, body, cleanup), value = await response.json().catch(() => null)
    check(response.ok && value && !value.error, 'http_failed')
    return { value, status: response.status }
  }
  const pin = async () => {
    if (deployed) return assertDeployedTarget({ env, event, attestation, fetchImpl, now })
    check((await json('/mikka/api/version')).value.build === guard.applicationSha, 'deployment_mismatch')
  }
  const session = async cleanup => {
    const value = (await json('/mikka/api/auth/get-session', undefined, cleanup)).value
    check(value?.user?.email?.toLowerCase() === email.toLowerCase() && typeof value.user.id === 'string'
      && (!owner || value.user.id === owner), 'session_identity')
    owner = value.user.id
  }
  const poll = async cleanup => {
    const continuation = chat?.continuation
    const suffix = continuation ? '?' + new URLSearchParams({ after: String(continuation.after), cursor: String(continuation.cursor), prefix: continuation.prefix }) : ''
    const response = await request(CHAT + suffix, undefined, cleanup)
    if (response.status === 304) return
    const value = await response.json().catch(() => null)
    check(response.ok && value && value.enabled === true && typeof value.botId === 'string'
      && (!chat || chat.botId === value.botId), 'chat_invalid')
    chat = mergeReadChat(chat, value)
    etag = response.headers.get('etag')
  }
  const observeOccurrence = async cleanup => {
    if (!schedule || !freshItems(chat, baseline).some(item => item.text?.includes('[Schedule ' + schedule.scheduleId + ';'))) return null
    // Public chat rows merge consecutive assistant messages. Read a bounded
    // one-row window through the existing authorized history action so the
    // host operation ID cannot be confused with the preceding model row.
    for (let through = chat.cursor, count = 0; through > baseline && count < 5; count++) {
      const result = (await json('/mikka/api/rpc', { version: DESKTOP_RPC_VERSION,
        action: 'coordinator.coordinatorHistory', args: [chat.botId, through, 1] }, cleanup)).value
      check(result.ok === true, 'chat_invalid')
      const single = decode(result.result)
      check(single && Array.isArray(single.items) && Number.isSafeInteger(single.cursor), 'chat_invalid')
      const found = occurrenceEvidence(single, baseline, marker, schedule.scheduleId)
      if (found) return found
      if (single.cursor <= baseline || single.cursor > through) break
      through = single.cursor - 1
    }
    return null
  }
  const submit = async (text, cleanup = false) => {
    if (!cleanup) await pin()
    if (cleanup) report.cleanupSubmissionCount++; else report.submissionCount++
    const value = await json(CHAT, { text, submissionId: randomUUID() }, cleanup)
    check(value.status === 202 && value.value.queued === true && value.value.enabled === true, 'submission_failed')
  }
  try {
    const read = path => vercelRead(path, { token, fetchImpl })
    const alias = activeAlias(await read('/v4/aliases/' + PRODUCTION_ALIAS))
    if (deployed && alias.deploymentId !== guard.deploymentId) throw new DeployedTargetError('target_changed', { detail: 'alias' })
    const deployment = await read('/v13/deployments/' + encodeURIComponent(alias.deploymentId))
    if (deployed) {
      const project = deployment.projectId ?? deployment.project?.id
      const source = deployment.gitSource?.sha ?? deployment.meta?.githubCommitSha
      if (project !== PROJECT || (deployment.projectId && deployment.project?.id && deployment.projectId !== deployment.project.id)
        || source !== guard.applicationSha || (deployment.meta?.githubCommitSha && deployment.meta.githubCommitSha !== source)
        || deployment.readyState !== 'READY' || deployment.target !== 'production')
        throw new DeployedTargetError('target_changed', { detail: 'deployment' })
    } else {
    check(deployment.projectId === PROJECT && (deployment.gitSource?.sha ?? deployment.meta?.githubCommitSha) === guard.applicationSha
      && deployment.readyState === 'READY' && deployment.target === 'production', 'deployment_mismatch')
    }
    deploymentId = alias.deploymentId
    managed = await readerFactory(token, deploymentId)
    await managed.probe() // management read permission must work before the message
    await pin()
    closeSession = true
    await json('/mikka/api/auth/sign-in/email', { email, password })
    await session(); report.normalSessionObserved = true
    const workspace = (await json('/mikka/api/workspace')).value
    check(workspace.currentUserId === owner && workspace.workspace?.kind === 'personal' && workspace.role === 'admin', 'session_identity')
    report.personalWorkspaceConfirmed = true
    await poll()
    check(chat.enabled === true, 'coordinator_disabled'); check(chat.working === false, 'coordinator_busy')
    baseline = chat.cursor
    await submit('This is one authorized internal reminder verification. Do not contact anyone or use external integrations, devices, browser, tasks or messages. '
      + 'Call only schedule_create exactly once with this exact definition: ' + JSON.stringify(definition)
      + '. It must be one-time, not recurring. After the successful persisted tool result, reply briefly with its schedule ID and title. Do not claim a tool ran unless it succeeded.')
    while (now() < deadline) {
      await poll()
      check(freshItems(chat, baseline).flatMap(tools).every(tool => ['schedule_create', 'schedule_list'].includes(tool.name)), 'unexpected_tool')
      const observed = creationEvidence(chat, baseline, marker, at)
      check(!schedule || !observed || schedule.scheduleId === observed.scheduleId, 'creation_ambiguous')
      schedule ??= observed
      if (schedule) {
        occurrence ??= await observeOccurrence()
        if (!timerId) {
          const hook = await managed.timer()
          if (hook && RUN.test(hook.runId)) {
            const holder = await managed.getRun(hook.runId)
            // A normal deployment handoff may briefly expose the old hook.
            // The application owns replacement; this driver only observes.
            if (holder.deploymentId === deploymentId
              && workflow(holder.workflowName, 'workflows/due-timer/workflow.ts', 'dueTimer')
              && ['pending', 'running'].includes(holder.status)) timerId = hook.runId
          }
        }
        if (occurrence && timerId) {
          const [coordinator, timer, events] = await Promise.all([
            managed.getRun(schedule.coordinatorRunId), managed.getRun(timerId), managed.events(timerId, started - 1000),
          ])
          check(coordinator.runId === schedule.coordinatorRunId && timer.runId === timerId, 'manager_read_unavailable')
          const evidence = managedEvidence({ coordinator, timer, events, deploymentId, dueAt: at,
            occurrenceAt: occurrence.createdAt, startedAt: started })
          if (evidence) {
            report.managed = evidence
            // The observed definition is once. Store.materialize commits
            // next_at=NULL/status=completed before this exact host-written
            // successful occurrence; no second/recurring future slot exists.
            report.futureScheduleConfirmedAbsent = true
            report.futureScheduleEvidence = 'observed-once-definition-and-committed-operation'
            report.scheduleHash = hash(schedule.scheduleId); report.occurrenceHash = hash(occurrence.occurrenceId)
            report.operationHash = hash(occurrence.operationId)
            await session(); await pin()
            const current = activeAlias(await read('/v4/aliases/' + PRODUCTION_ALIAS))
            if (deployed && current.deploymentId !== guard.deploymentId) throw new DeployedTargetError('target_changed', { detail: 'alias' })
            check(current.deploymentId === deploymentId, 'deployment_mismatch')
            report.status = 'pass'
            break
          }
        }
      }
      await wait(5000)
    }
    check(report.status === 'pass', schedule ? occurrence ? 'managed_evidence_missing' : 'reminder_not_observed' : 'schedule_not_observed')
  } catch (error) {
    if (deployed && error instanceof DeployedTargetError) Object.assign(report, publicTargetFailure(error))
    else { report.status = 'fail'; report.code = error instanceof ProofError ? error.code : 'proof_failed' }
  } finally {
    if (report.submissionCount && !report.futureScheduleConfirmedAbsent && closeSession) {
      // No unknown IDs are adopted. An uncertain POST may have been accepted:
      // observe its unique actual tool result before allowing bounded cleanup.
      try {
        const recoverUntil = now() + 30_000
        while (!schedule && now() < recoverUntil) {
          await poll(true); schedule = creationEvidence(chat, baseline, marker, at)
          if (!schedule) await wait(5000)
        }
        if (schedule) {
          occurrence ??= await observeOccurrence(true)
          if (occurrence) {
            report.futureScheduleConfirmedAbsent = true
            report.futureScheduleEvidence = 'observed-once-definition-and-committed-operation'
          } else {
            await session(true)
            const after = chat.cursor
            await submit('Cancel only the internal reminder with exact schedule ID ' + schedule.scheduleId
              + ' and title ' + marker + '. Use schedule_list to get its current version, then schedule_cancel only for that ID. '
              + 'Do not create, change, pause, cancel or contact anything else. Report failure honestly.', true)
            const end = now() + 90_000
            while (now() < end) {
              await poll(true)
              if (cancellationObserved(chat, after, schedule.scheduleId)) {
                report.futureScheduleConfirmedAbsent = true; report.futureScheduleEvidence = 'normal-owner-schedule-cancel'
                break
              }
              await wait(5000)
            }
          }
        }
      } catch { /* failure remains; cleanup cannot authorize an unproven ID */ }
      if (!report.futureScheduleConfirmedAbsent) { report.status = 'fail'; report.cleanupCode = 'future_schedule_unproven' }
    }
    if (closeSession) report.sessionClosed = await request('/mikka/api/auth/sign-out', {}, true).then(res => res.ok).catch(() => false)
    if (closeSession && !report.sessionClosed) { report.status = 'fail'; report.code = 'session_close_failed' }
    cookies.clear()
    if (deployed) {
      // Target drift cannot prevent the existing exact-resource cleanup above.
      // It also cannot turn a cleanup failure into an inconclusive success.
      try { report.targetAfter = await assertDeployedTarget({ env, event, attestation, fetchImpl, now }) }
      catch (error) {
        report.targetAfterFailure = publicTargetFailure(error)
        if (!report.cleanupCode && (!closeSession || report.sessionClosed)) {
          if (report.status === 'fail') report.businessFailure = { status: report.status, code: report.code }
          Object.assign(report, report.targetAfterFailure)
        }
      }
    }
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const attestation = process.env.MIKKA_ACCEPTANCE_TARGET_MODE === 'deployed-target'
      ? JSON.parse(await readFile('production-read-cache-report/attestation.json', 'utf8')) : undefined
    report = await runWorkflowMigrationProof({ event, attestation })
  } catch (error) { report = { version: 1, issue: 1415, ...(error instanceof DeployedTargetError
    ? publicTargetFailure(error) : { status: 'blocked', code: error instanceof ProofError ? error.code : 'proof_failed' }) } }
  await mkdir('production-workflow-migration-report', { recursive: true, mode: 0o700 })
  await writeFile('production-workflow-migration-report/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report))
  process.exitCode = report.status === 'pass' || report.status === 'skipped' ? 0 : 1
}
