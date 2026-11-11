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
import { TeamWorkspaceError, isTeamWorkspaceReadPath, isTeamWorkspaceSwitchRequest, publicTeamWorkspaceFailure, selectTeamWorkspace } from './team-workspace.mjs'

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
// Root-project identifiers produced by the locked Workflow SWC transform omit the source extension.
const workflow = (value, file, name) => value === 'workflow//./' + file + '//' + name
const stepName = value => value === 'step//./workflows/due-timer/steps//runDue'
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
    || timer.deploymentId !== deploymentId || !workflow(coordinator.workflowName, 'workflows/coordinator/workflow', 'coordinatorTurn')
    || !workflow(timer.workflowName, 'workflows/due-timer/workflow', 'dueTimer')
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
    listRuns: (status, pagination) => storage.runs.list({ status, pagination, resolveData: 'none' }),
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
    status: 'running', normalSessionObserved: false, teamAdminMembershipVerified: false, sessionClosed: false, submissionCount: 0, cleanupSubmissionCount: 0,
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
    check(isTeamWorkspaceReadPath(path) || path === CHAT || path.startsWith(CHAT + '?') || ['/mikka/api/version', '/mikka/api/auth/get-session',
      '/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out', '/mikka/api/rpc'].includes(path), 'http_failed')
    check(body === undefined || path === CHAT || path.endsWith('/sign-in/email') || path.endsWith('/sign-out')
      || path === '/mikka/api/rpc' && (isTeamWorkspaceSwitchRequest(body)
        || body.version === DESKTOP_RPC_VERSION && body.action === 'coordinator.coordinatorHistory'
        && Array.isArray(body.args) && body.args.length === 3 && body.args[0] === chat?.botId
        && Number.isSafeInteger(body.args[1]) && body.args[1] >= baseline && body.args[2] === 1), 'http_failed')
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
    Object.assign(report, await selectTeamWorkspace({ ownerId: owner,
      json: async (path, body) => (await json(path, body)).value }))
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
              && workflow(holder.workflowName, 'workflows/due-timer/workflow', 'dueTimer')
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
    else if (error instanceof TeamWorkspaceError) Object.assign(report, { status: 'fail' }, publicTeamWorkspaceFailure(error))
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


/** A separate historical inspection. It cannot submit or resume a workflow. */
const INSPECTION_WORKFLOW = '.github/workflows/issue1415-managed-inspection.yml'
const INSPECTION_REPOSITORY = 'alexj11324/Mikka'
const INSPECTION_API = 'https://api.github.com/repos/' + INSPECTION_REPOSITORY
const INSPECTION_SOURCE = Object.freeze({
  runId: 42285115630, attempt: 1, jobId: 128123815664, workflowId: 409730660,
  driverRevision: 'c0c98baa3020a085652ee5f773310b6dfa412c5d',
  applicationSha: '2960d783f0196fed5375593d910a43430a101747',
  deploymentId: 'dpl_9dfpxYacqybW7U2PcpviMu83ruSg',
  startedAt: '2026-11-06T20:06:04.595Z', finishedAt: '2026-11-06T20:13:08.828Z',
  // Verified against the original downloaded artifact JSON, not a new run.
  reportCanonicalSha256: 'e261780128a5ed77baf1de32267272f168c134b9ab8d240bb55c231b158d0a8e',
})
const INSPECTION_CODES = new Set(['inspection_configuration', 'inspection_driver', 'inspection_issue',
  'inspection_source', 'inspection_read_failed', 'inspection_metadata', 'inspection_limit'])
const INSPECTION_DETAILS = new Set(['event', 'workflow', 'repository', 'identity', 'inputs', 'credentials',
  'driver_metadata', 'issue_metadata', 'run', 'attempt', 'job', 'report', 'report_hash',
  'transport', 'response', 'redirect', 'body_limit', 'sdk', 'deployment', 'page', 'candidate',
  'event_metadata', 'unexpected'])
class ManagedInspectionError extends Error {
  constructor(code, detail, cause) {
    const safeCode = INSPECTION_CODES.has(code) ? code : 'inspection_read_failed'
    super(safeCode, cause === undefined ? undefined : { cause })
    this.name = 'ManagedInspectionError'; this.code = safeCode
    this.detail = INSPECTION_DETAILS.has(detail) ? detail : 'unexpected'
  }
}
const inspectionCheck = (ok, code, detail) => { if (!ok) throw new ManagedInspectionError(code, detail) }
const canonicalJSON = value => JSON.stringify(sortJSON(value))
function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON)
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJSON(value[key])])) : value
}
const inspectionInteger = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
  && Number.isSafeInteger(Number(value)) && String(Number(value)) === value
const inspectionRepository = value => value?.full_name === INSPECTION_REPOSITORY
  && value.owner?.login === 'alexj11324' && value.owner.id === 183887963
function inspectionGuard(env, event) {
  inspectionCheck(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REF === 'refs/heads/main', 'inspection_configuration', 'event')
  inspectionCheck(env.GITHUB_REPOSITORY === INSPECTION_REPOSITORY && env.GITHUB_REPOSITORY_OWNER === 'alexj11324'
    && env.GITHUB_REPOSITORY_OWNER_ID === '183887963' && inspectionRepository(event?.repository),
  'inspection_configuration', 'repository')
  inspectionCheck(env.GITHUB_WORKFLOW_REF === INSPECTION_REPOSITORY + '/' + INSPECTION_WORKFLOW + '@refs/heads/main',
    'inspection_configuration', 'workflow')
  inspectionCheck(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && inspectionInteger(env.GITHUB_RUN_ID)
    && inspectionInteger(env.GITHUB_RUN_ATTEMPT), 'inspection_configuration', 'identity')
  inspectionCheck(event?.inputs && Object.keys(event.inputs).join(',') === 'source_run_id'
    && event.inputs.source_run_id === String(INSPECTION_SOURCE.runId)
    && env.SOURCE_RUN_ID === event.inputs.source_run_id, 'inspection_configuration', 'inputs')
  inspectionCheck(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'inspection_configuration', 'credentials')
  return { driverRevision: env.GITHUB_SHA, driverRunId: Number(env.GITHUB_RUN_ID),
    driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT) }
}
async function inspectionText(response) {
  const reader = response.body?.getReader()
  inspectionCheck(reader, 'inspection_read_failed', 'response')
  const chunks = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      inspectionCheck(size <= 2 * 1024 * 1024, 'inspection_read_failed', 'body_limit')
      chunks.push(value)
    }
  } catch (cause) {
    await reader.cancel().catch(() => {})
    if (cause instanceof ManagedInspectionError) throw cause
    throw new ManagedInspectionError('inspection_read_failed', 'transport', cause)
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}
function inspectionGithub(env, fetchImpl) {
  return async (path, logs = false) => {
    let response
    try {
      response = await fetchImpl(INSPECTION_API + path, { method: 'GET', redirect: 'manual',
        signal: AbortSignal.timeout(30_000), headers: { accept: logs ? 'application/vnd.github+json' : 'application/json',
          authorization: 'Bearer ' + env.GH_TOKEN, 'x-github-api-version': '2022-11-28' } })
      if (logs && response.status === 302) {
        let location
        try { location = new URL(response.headers.get('location')) }
        catch (cause) { throw new ManagedInspectionError('inspection_read_failed', 'redirect', cause) }
        inspectionCheck(location.protocol === 'https:' && !location.username && !location.password && !location.hash
          && !location.port && (/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(location.hostname)
            || /^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/.test(location.hostname)),
        'inspection_read_failed', 'redirect')
        // The signed log URL receives no GitHub or platform credentials.
        response = await fetchImpl(location.href, { method: 'GET', redirect: 'error',
          signal: AbortSignal.timeout(30_000), headers: { accept: 'text/plain' } })
      }
    } catch (cause) {
      if (cause instanceof ManagedInspectionError) throw cause
      throw new ManagedInspectionError('inspection_read_failed', 'transport', cause)
    }
    inspectionCheck(response.ok && !response.redirected, 'inspection_read_failed', 'response')
    const text = await inspectionText(response)
    if (logs) return text
    try { return JSON.parse(text) }
    catch (cause) { throw new ManagedInspectionError('inspection_read_failed', 'response', cause) }
  }
}
async function inspectSource(env, event, fetchImpl) {
  const guard = inspectionGuard(env, event), get = inspectionGithub(env, fetchImpl)
  const driver = await get('/actions/runs/' + guard.driverRunId)
  inspectionCheck(driver?.id === guard.driverRunId && driver.run_attempt === guard.driverRunAttempt
    && inspectionRepository(driver.repository) && inspectionRepository(driver.head_repository)
    && driver.url === INSPECTION_API + '/actions/runs/' + guard.driverRunId
    && driver.path === INSPECTION_WORKFLOW && driver.event === 'workflow_dispatch' && driver.head_branch === 'main'
    && driver.head_sha === guard.driverRevision && driver.status === 'in_progress' && driver.conclusion === null,
  'inspection_driver', 'driver_metadata')
  const issue = await get('/issues/1415')
  inspectionCheck(issue?.number === 1415 && issue.url === INSPECTION_API + '/issues/1415'
    && issue.repository_url === INSPECTION_API && !issue.pull_request && issue.state === 'open',
  'inspection_issue', 'issue_metadata')
  const source = INSPECTION_SOURCE
  for (const [suffix, detail] of [['', 'run'], ['/attempts/1', 'attempt']]) {
    const run = await get('/actions/runs/' + source.runId + suffix)
    inspectionCheck(run?.id === source.runId && run.run_attempt === source.attempt
      && run.workflow_id === source.workflowId && inspectionRepository(run.repository) && inspectionRepository(run.head_repository)
      && run.url === INSPECTION_API + '/actions/runs/' + source.runId
      && run.path === '.github/workflows/issue1415-deployed-production.yml' && run.event === 'workflow_dispatch'
      && run.head_branch === 'main' && run.head_sha === source.driverRevision
      && run.status === 'completed' && run.conclusion === 'failure', 'inspection_source', detail)
  }
  const jobs = await get('/actions/runs/' + source.runId + '/attempts/1/jobs?per_page=100')
  const job = jobs?.jobs?.[0]
  inspectionCheck(jobs?.total_count === 1 && jobs.jobs.length === 1 && job.id === source.jobId
    && job.run_id === source.runId && job.run_attempt === source.attempt && job.head_sha === source.driverRevision
    && job.name === 'acceptance' && job.status === 'completed' && job.conclusion === 'failure'
    && job.steps?.filter(step => step.name === 'Verify the normal owner browser and close only its own session'
      && step.status === 'completed' && step.conclusion === 'success').length === 1
    && job.steps?.filter(step => step.name === 'Prove one normal Coordinator turn and its managed due reminder'
      && step.status === 'completed' && step.conclusion === 'failure').length === 1,
  'inspection_source', 'job')
  const log = await get('/actions/jobs/' + source.jobId + '/logs', true)
  const reports = []
  for (const line of log.split(/\r?\n/)) {
    const text = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, '')
    if (!text.startsWith('{') || !text.includes('"purpose":"workflow-migration-production"')) continue
    try { reports.push(JSON.parse(text)) }
    catch (cause) { throw new ManagedInspectionError('inspection_source', 'report', cause) }
  }
  const report = reports[0]
  inspectionCheck(reports.length === 1 && report?.purpose === 'workflow-migration-production' && report.issue === 1415
    && report.driverRevision === source.driverRevision && report.driverRunId === source.runId
    && report.driverRunAttempt === source.attempt && report.applicationSha === source.applicationSha
    && report.deploymentId === source.deploymentId && report.startedAt === source.startedAt
    && report.finishedAt === source.finishedAt && report.status === 'fail' && report.code === 'http_failed'
    && report.submissionCount === 1 && report.cleanupSubmissionCount === 0 && report.normalSessionObserved === true
    && report.sessionClosed === true && report.futureScheduleConfirmedAbsent === true && !report.cleanupCode
    && report.sdkMutations === 0 && report.cronRequests === 0 && report.databaseWritesByDriver === 0,
  'inspection_source', 'report')
  inspectionCheck(hash(canonicalJSON(report)) === source.reportCanonicalSha256, 'inspection_source', 'report_hash')
  return guard
}


const INSPECTION_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled'])
const INSPECTION_EVENT_TYPES = new Set(['run_created', 'run_started', 'run_completed', 'run_failed',
  'run_cancelled', 'step_created', 'step_started', 'step_completed', 'step_failed', 'step_retrying',
  'wait_created', 'wait_completed', 'hook_created', 'hook_received', 'hook_disposed'])
const inspectionISO = value => Number.isFinite(time(value)) ? new Date(time(value)).toISOString() : null
async function defaultInspectionStorage(config) {
  const sdkRequire = createRequire(import.meta.resolve('workflow'))
  const { createStorage } = await import(pathToFileURL(sdkRequire.resolve('@workflow/world-vercel')).href)
  return createStorage(config)
}
async function inspectionSDKRead(call) {
  try { return await call() }
  catch (cause) {
    if (cause instanceof ManagedInspectionError) throw cause
    throw new ManagedInspectionError('inspection_read_failed', 'sdk', cause)
  }
}
async function inspectionPages(list, params, stop, counters) {
  const rows = [], seen = new Set(); let cursor
  for (let page = 0; page < 20; page++) {
    const result = await inspectionSDKRead(() => list({ ...params, resolveData: 'none',
      pagination: { limit: 100, sortOrder: 'desc', ...(cursor ? { cursor } : {}) } }))
    counters.pages++; counters.rows += Array.isArray(result?.data) ? result.data.length : 0
    inspectionCheck(Array.isArray(result?.data) && result.data.length <= 100 && typeof result.hasMore === 'boolean',
      'inspection_metadata', 'page')
    rows.push(...result.data)
    if (!result.hasMore || stop?.(result.data, rows)) return rows
    inspectionCheck(typeof result.cursor === 'string' && result.cursor.length > 0 && result.cursor.length <= 2048
      && !seen.has(result.cursor), 'inspection_metadata', 'page')
    seen.add(result.cursor); cursor = result.cursor
  }
  throw new ManagedInspectionError('inspection_limit', 'page')
}
function inspectionRun(row, expectedName) {
  inspectionCheck(RUN.test(row?.runId ?? '') && row.workflowName === expectedName
    && INSPECTION_STATUSES.has(row.status) && /^dpl_[A-Za-z0-9]+$/.test(row.deploymentId ?? '')
    && inspectionISO(row.createdAt) && (row.completedAt === undefined || inspectionISO(row.completedAt)),
  'inspection_metadata', 'candidate')
}
function inspectionEvent(row, runId) {
  inspectionCheck(row?.runId === runId && typeof row.eventType === 'string' && inspectionISO(row.createdAt)
    && (row.correlationId === undefined || (typeof row.correlationId === 'string' && row.correlationId.length <= 2048)),
  'inspection_metadata', 'event_metadata')
  const eventType = INSPECTION_EVENT_TYPES.has(row.eventType) ? row.eventType : 'other'
  const resumeAt = row.eventData?.resumeAt
  inspectionCheck(resumeAt === undefined || inspectionISO(resumeAt), 'inspection_metadata', 'event_metadata')
  return { eventType, createdAt: inspectionISO(row.createdAt),
    inSourceWindow: time(row.createdAt) >= time(INSPECTION_SOURCE.startedAt) - 1000
      && time(row.createdAt) <= time(INSPECTION_SOURCE.finishedAt),
    correlationHash: row.correlationId ? hash(row.correlationId) : null,
    resumeAt: resumeAt === undefined ? null : inspectionISO(resumeAt),
    stepNameClass: row.eventData?.stepName === undefined ? null : stepName(row.eventData.stepName) ? 'runDue' : 'other' }
}
async function inspectSDKHistory(report, env, fetchImpl, createStorageImpl) {
  inspectionCheck(typeof env.VERCEL_TEAM_TOKEN === 'string' && env.VERCEL_TEAM_TOKEN.length > 0,
    'inspection_configuration', 'credentials')
  for (const key of ['WORKFLOW_VERCEL_BACKEND_URL', 'VERCEL_WORKFLOW_SERVER_URL', 'WORKFLOW_SERVER_URL_OVERRIDE'])
    inspectionCheck(!env[key], 'inspection_configuration', 'sdk')
  const scopes = new Map()
  const deploymentScope = async deploymentId => {
    if (scopes.has(deploymentId)) return scopes.get(deploymentId)
    let value
    try { value = await vercelRead('/v13/deployments/' + encodeURIComponent(deploymentId), { token: env.VERCEL_TEAM_TOKEN, fetchImpl }) }
    catch (cause) { throw new ManagedInspectionError('inspection_read_failed', 'deployment', cause) }
    const project = value?.projectId ?? value?.project?.id, sha = value?.gitSource?.sha ?? value?.meta?.githubCommitSha
    inspectionCheck((value?.id ?? value?.uid) === deploymentId && project === PROJECT && value.target === 'production'
      && (!value.projectId || !value.project?.id || value.projectId === value.project.id)
      && (!value.teamId || value.teamId === TEAM) && (!value.ownerId || value.ownerId === TEAM)
      && /^[a-f0-9]{40}$/.test(sha ?? '') && (!value.meta?.githubCommitSha || value.meta.githubCommitSha === sha),
    'inspection_metadata', 'deployment')
    const result = { scopeMatches: true, sourceMatches: sha === INSPECTION_SOURCE.applicationSha }
    if (deploymentId === INSPECTION_SOURCE.deploymentId)
      inspectionCheck(result.sourceMatches, 'inspection_metadata', 'deployment')
    scopes.set(deploymentId, result)
    return result
  }
  await deploymentScope(INSPECTION_SOURCE.deploymentId)
  const storage = await inspectionSDKRead(() => createStorageImpl({
    token: env.VERCEL_TEAM_TOKEN, projectConfig: { projectId: PROJECT, teamId: TEAM, environment: 'production' },
  }))
  const begin = time(INSPECTION_SOURCE.startedAt) - 1000, end = time(INSPECTION_SOURCE.finishedAt)
  const timerBegin = begin - 6 * 60 * 60_000 // The product's DUE_TIMER_LIFETIME_MS.
  const selected = new Map()
  report.listing = { pages: 0, rows: 0, canonicalFilters: 2, complete: false,
    timerCreatedNotBefore: new Date(timerBegin).toISOString(), olderTimersInspected: false }
  report.eventReads = { pages: 0, rows: 0 }
  report.candidates = []
  for (const [nameClass, file, name] of [
    ['coordinatorTurn', 'workflows/coordinator/workflow', 'coordinatorTurn'],
    ['dueTimer', 'workflows/due-timer/workflow', 'dueTimer'],
  ]) {
    const expectedName = 'workflow//./' + file + '//' + name
    const rows = await inspectionPages(options => storage.runs.list(options), { workflowName: expectedName },
      page => page.some(row => time(row.createdAt) < (nameClass === 'coordinatorTurn' ? begin : timerBegin)), report.listing)
    for (const row of rows) {
      inspectionRun(row, expectedName)
      const inWindow = nameClass === 'coordinatorTurn'
        ? time(row.createdAt) >= begin && time(row.createdAt) <= end && row.deploymentId === INSPECTION_SOURCE.deploymentId
        : time(row.createdAt) >= timerBegin && time(row.createdAt) <= end
          && (row.completedAt === undefined || time(row.completedAt) >= begin)
      if (!inWindow) continue
      if (selected.has(row.runId)) {
        const earlier = selected.get(row.runId).row
        inspectionCheck(earlier.workflowName === row.workflowName && earlier.deploymentId === row.deploymentId
          && time(earlier.createdAt) === time(row.createdAt), 'inspection_metadata', 'candidate')
      } else selected.set(row.runId, { row, nameClass })
      inspectionCheck(selected.size <= 40, 'inspection_limit', 'candidate')
    }
  }
  report.listing.complete = true
  for (const { row, nameClass } of selected.values()) {
    const current = await inspectionSDKRead(() => storage.runs.get(row.runId, { resolveData: 'none' }))
    inspectionRun(current, row.workflowName)
    inspectionCheck(current.runId === row.runId && current.deploymentId === row.deploymentId
      && time(current.createdAt) === time(row.createdAt), 'inspection_metadata', 'candidate')
    const scope = await deploymentScope(current.deploymentId)
    const candidate = { runHash: hash(current.runId), nameClass, status: current.status,
      deploymentId: current.deploymentId, deploymentMatches: current.deploymentId === INSPECTION_SOURCE.deploymentId,
      ...scope, createdAt: inspectionISO(current.createdAt), completedAt: inspectionISO(current.completedAt),
      sourceAttribution: 'candidate-only', rejectReasons: [], events: [] }
    report.candidates.push(candidate)
    if (!candidate.deploymentMatches) candidate.rejectReasons.push('deployment_mismatch')
    if (nameClass === 'coordinatorTurn' && current.status !== 'completed') candidate.rejectReasons.push('coordinator_not_completed')
    if (!scope.sourceMatches) {
      candidate.rejectReasons.push('application_source_mismatch')
      continue
    }
    const events = await inspectionPages(options => storage.events.list(options), { runId: current.runId },
      (page, all) => page.some(item => time(item.createdAt) < begin)
        && all.some(item => item.eventType === 'wait_created' && time(item.createdAt) < begin), report.eventReads)
    let priorWait = false
    for (const event of events) {
      const projection = inspectionEvent(event, current.runId)
      if (time(event.createdAt) > end) continue
      const precedingWait = projection.eventType === 'wait_created' && time(event.createdAt) < begin && !priorWait
      if (precedingWait) priorWait = true
      if (time(event.createdAt) < begin && !precedingWait) continue
      candidate.events.push(projection)
    }
    candidate.eventCounts = {}
    for (const event of candidate.events)
      candidate.eventCounts[event.eventType] = (candidate.eventCounts[event.eventType] ?? 0) + 1
    if (nameClass === 'dueTimer') {
      for (const type of ['wait_created', 'wait_completed', 'step_created', 'step_started', 'step_completed'])
        if (!candidate.events.some(event => event.inSourceWindow && event.eventType === type))
          candidate.rejectReasons.push('no_' + type + '_in_window')
    }
    // The original closed report has no schedule/run IDs or exact due time.
    // Candidate metadata can diagnose predicates, never attribute this task.
    candidate.rejectReasons.push('source_attribution_unavailable')
  }
}

/** Only the two fixed inspection CLI modes use this entry. External API/SDK seams are injectable for offline tests. */
export async function inspectManagedHistory({ env = process.env, event, fetchImpl = fetch, metadata = false,
  createStorageImpl = defaultInspectionStorage, now = Date.now } = {}) {
  const report = { version: 1, purpose: 'workflow-migration-history-inspection', issue: 1415,
    status: 'blocked', inspectionStage: metadata ? 'metadata' : 'source', mode: 'readonly-history',
    sourceRunId: INSPECTION_SOURCE.runId, sourceRunAttempt: INSPECTION_SOURCE.attempt, sourceJobId: INSPECTION_SOURCE.jobId,
    sourceDriverRevision: INSPECTION_SOURCE.driverRevision, applicationSha: INSPECTION_SOURCE.applicationSha,
    deploymentId: INSPECTION_SOURCE.deploymentId, sourceStartedAt: INSPECTION_SOURCE.startedAt,
    sourceFinishedAt: INSPECTION_SOURCE.finishedAt, sourceReportCanonicalSha256: INSPECTION_SOURCE.reportCanonicalSha256,
    canonicalAlgorithm: 'json-recursive-sorted-v1', businessExecutionVerified: false, ownerRequests: 0,
    modelCalls: 0, sdkMutations: 0, cronRequests: 0, databaseWritesByDriver: 0 }
  try {
    Object.assign(report, await inspectSource(env, event, fetchImpl))
    if (metadata) await inspectSDKHistory(report, env, fetchImpl, createStorageImpl)
    report.status = 'inspected'
  } catch (error) {
    report.code = error instanceof ManagedInspectionError ? error.code : 'inspection_read_failed'
    report.detail = error instanceof ManagedInspectionError ? error.detail : 'unexpected'
  }
  report.inspectedAt = new Date(now()).toISOString()
  return report
}

async function inspectionCLI() {
  let report
  const metadata = process.argv[2] === '--inspect-managed'
  try {
    inspectionCheck(process.argv.length === 3 && ['--inspect-source', '--inspect-managed'].includes(process.argv[2]),
      'inspection_configuration', 'inputs')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report = await inspectManagedHistory({ event, metadata })
  } catch (error) {
    report = { version: 1, purpose: 'workflow-migration-history-inspection', issue: 1415, status: 'blocked',
      code: error instanceof ManagedInspectionError ? error.code : 'inspection_configuration',
      detail: error instanceof ManagedInspectionError ? error.detail : 'event', businessExecutionVerified: false,
      ownerRequests: 0, modelCalls: 0, sdkMutations: 0, cronRequests: 0, databaseWritesByDriver: 0 }
  }
  await mkdir('production-managed-inspection-report', { recursive: true, mode: 0o700 })
  await writeFile('production-managed-inspection-report/' + (metadata ? 'report' : 'source') + '.json',
    JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report))
  process.exitCode = report.status === 'inspected' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  && process.argv.slice(2).some(arg => arg.startsWith('--inspect'))) {
  await inspectionCLI()
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
