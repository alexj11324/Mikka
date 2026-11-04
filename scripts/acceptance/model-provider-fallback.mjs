#!/usr/bin/env node
/** Issue #1225 / PR #1232 only. Ordinary owner HTTP sessions and real tasks.
 * Credentials, cookies, upstream bodies and chat text never enter the report.
 * Unit fixtures prove this driver's guards, not production model acceptance. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { assertFlashTestModel } from '../test-model-policy.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const REPOSITORY = 'alexj11324/Mikka'
export const CASES = [
  { id: 'deepseek_402_fallback', model: 'deepseek-flash', provider: 'deepseek', harness: 'claude_code', kind: 'api_key' },
  { id: 'official_claude', model: 'claude-haiku-5-5', provider: 'claude', harness: 'claude_code', kind: 'subscription' },
  { id: 'official_codex', model: 'gpt-6-luna', provider: 'codex', harness: 'codex', kind: 'subscription' },
]
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const runStatuses = new Set(['queued', 'preparing', 'running', 'waiting_input', 'paused', 'finishing', 'succeeded', 'failed', 'stopped', 'cancelled'])
const terminalTask = new Set(['cancelled', 'revoked', 'failed', 'blocked', 'completed', 'succeeded'])
const actionsAllowed = new Set(['getIssueThread', 'changeModelOrder', 'listWorkspaceBots', 'getIssue', 'setIssueDeleted', 'getDeletedIssue', 'getArtifact'])
const serverCodes = new Set(['authRequired', 'workspaceAccessDenied', 'executionModelUnknown', 'executionAccountUnavailable', 'executionRuleOrderInvalid', 'modelUnavailable', 'botNotFound', 'factoryStale', 'factoryStopped', 'factoryNotFound', 'factoryLifecycleUnavailable', 'factoryUnavailable', 'issueOutdated', 'runChainEnded', 'runNotFound', 'subscription_unavailable', 'backend_unavailable', 'validationGeneric'])
const codes = new Set([
  'configuration_required', 'origin_rejected', 'merge_scope_rejected', 'build_mismatch', 'build_mapping_required',
  'account_required', 'sign_in_failed', 'session_missing', 'session_identity', 'workspace_missing',
  'request_failed', 'http_refused', 'response_invalid', 'action_missing', 'action_not_allowed', 'action_refused',
  'source_missing', 'source_ambiguous', 'source_blocked', 'cloud_unavailable', 'worker_release',
  'order_restore_unavailable', 'order_restore_conflict', 'order_changed', 'workspace_busy',
  'bot_scope', 'model_selection', 'model_changed', 'run_scope', 'run_model', 'run_credential', 'run_identity',
  'fixture_ambiguous', 'previous_fixture', 'task_missing', 'task_scope', 'task_blocked', 'task_timeout',
  'provider_refused', 'fallback_missing', 'not_reproduced', 'artifact_missing', 'artifact_scope', 'artifact_content',
  'checks_missing', 'artifact_creator_scope', 'cleanup_incomplete', 'acceptance_failed',
])
export class AcceptanceError extends Error {
  constructor(code, status = 'blocked', detail = {}) {
    super(codes.has(code) ? code : 'acceptance_failed')
    this.status = ['blocked', 'failed', 'not_reproduced'].includes(status) ? status : 'failed'
    this.detail = detail
  }
}
const check = (condition, code, status = 'blocked') => { if (!condition) throw new AcceptanceError(code, status) }

/** An exact projection, never a regex permission to print arbitrary messages. */
export function publicFailure(error) {
  if (!(error instanceof AcceptanceError)) return { status: 'failed', code: 'acceptance_failed' }
  const detail = error.detail ?? {}
  return { status: error.status, code: codes.has(error.message) ? error.message : 'acceptance_failed',
    ...(Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599 ? { httpStatus: detail.httpStatus } : {}),
    ...(serverCodes.has(detail.serverCode) ? { serverCode: detail.serverCode } : {}),
    ...(['balance', 'auth', 'unavailable', 'quota'].includes(detail.providerKind) ? { providerKind: detail.providerKind } : {}),
    ...(Number.isInteger(detail.providerStatus) && detail.providerStatus >= 100 && detail.providerStatus <= 599 ? { providerStatus: detail.providerStatus } : {}),
    ...(['checking', 'quota', 'expired', 'paused', 'missing', 'keyRefused', 'balance', 'providerUnavailable', 'noDevice'].includes(detail.block) ? { block: detail.block } : {}),
  }
}

export function mergeGuard({ repository, ref, eventName, event, pr }) {
  const expected = pr?.merge_commit_sha
  check(repository === REPOSITORY && ref === 'refs/heads/main' && pr?.number === 1232 && pr.merged === true
    && pr.base?.ref === 'main' && pr.base?.repo?.full_name === REPOSITORY && sha(expected)
    && /(?:refs?|fix(?:es)?|clos(?:e[sd]?|ing)|resolv(?:e[sd]?|ing))\s+(?:https:\/\/github\.com\/alexj11324\/Mikka\/issues\/)?#?1225\b/i.test(pr.body ?? ''), 'merge_scope_rejected')
  if (eventName === 'workflow_run') {
    const run = event?.workflow_run
    check(run?.name === 'Web deploy' && run.conclusion === 'success' && run.status === 'completed'
      && run.head_branch === 'main' && run.head_sha === expected && run.head_repository?.full_name === REPOSITORY
      && (run.head_commit?.message?.includes('(#1232)') || run.pull_requests?.some(item => item.number === 1232)),
    'merge_scope_rejected')
    return { sha: expected, mode: 'active' }
  }
  check(eventName === 'workflow_dispatch' && ['preflight', 'active'].includes(event?.inputs?.mode ?? 'preflight'), 'merge_scope_rejected')
  return { sha: expected, mode: event?.inputs?.mode ?? 'preflight' }
}

export function assertVersion(build, expectedSha) {
  check(sha(expectedSha), 'configuration_required')
  check(build === expectedSha, typeof build === 'string' && build.startsWith('dpl_') ? 'build_mapping_required' : 'build_mismatch')
}

export async function independently(cases, run) {
  const results = []
  for (const item of cases) {
    try { results.push({ case: item.id, ...await run(item) }) }
    catch (error) { results.push({ case: item.id, ...publicFailure(error) }) }
  }
  return results
}

const sourceId = entry => entry?.source?.kind === 'api_key' ? entry.source.keyId : entry?.source?.connectionId
const entryKey = entry => JSON.stringify([entry?.harness, entry?.model, entry?.source?.kind, sourceId(entry)])
export function orderFingerprint(order) {
  return JSON.stringify({ location: order.location, customized: order.customized, preferredHarness: order.preferredHarness,
    entries: order.entries.map(entry => ({ id: entry.id, harness: entry.harness, model: entry.model, source: entry.source })) })
}

/** Factory checks select from the order again, without the producer's explicit
 * model. The entire temporary order contains only this case's own sources. */
export function caseOrderPlan(order, wanted, ownerId) {
  check(wanted.length > 0 && wanted.length <= 2 && wanted.every(entry => entry.credentialOwnerId === ownerId
    && CASES.some(item => item.model === entry.model && item.harness === entry.harness && item.kind === entry.source?.kind)), 'run_identity')
  const already = JSON.stringify(order.entries.map(entryKey)) === JSON.stringify(wanted.map(entryKey))
  if (!already) check(order.customized === true && Array.isArray(order.candidates)
    && order.entries.every(entry => order.candidates.some(candidate => entryKey(candidate) === entryKey(entry))), 'order_restore_unavailable')
  return { already, wanted }
}

export function ownedSource(item, { order, keys, connections, ownerId }) {
  check(Array.isArray(order?.candidates) && Array.isArray(keys?.keys) && Array.isArray(connections?.connections), 'response_invalid')
  const own = item.kind === 'api_key'
    ? keys.keys.filter(key => key.provider === item.provider).map(key => key.id)
    : connections.connections.filter(connection => connection.provider === item.provider && connection.state === 'connected' && !connection.paused).map(connection => connection.id)
  const choices = order.candidates.filter(entry => entry.model === item.model && entry.harness === item.harness
    && entry.source?.kind === item.kind && own.includes(sourceId(entry)) && entry.credentialOwnerId === ownerId)
  check(choices.length > 0, 'source_missing')
  // The public native receipt exposes its binding, not its connection id.
  // One eligible own account avoids claiming an unproved connection switch.
  check(new Set(choices.map(sourceId)).size === 1, 'source_ambiguous')
  const choice = choices[0]
  const row = order.entries.find(entry => entryKey(entry) === entryKey(choice))
  if (row?.block && row.block.reason !== 'checking') throw new AcceptanceError('source_blocked', 'blocked', { block: row.block.reason })
  check(order.location === 'cloud' && order.cloudReady === true, 'cloud_unavailable')
  if (row && order.cloudModels?.[row.id] !== 'ready') throw new AcceptanceError('cloud_unavailable')
  return choice
}

export function assertRunEvidence(found, { ownerId, workspaceId, botId, issueId, model, harness, kind, keyId }) {
  const run = found?.run, identity = run?.executionIdentity
  check(uuid(run?.id) && run.botId === botId && run.issueId === issueId && runStatuses.has(run.status), 'run_scope', 'failed')
  check(CASES.some(item => item.model === run.model) && run.model === model && run.harness === harness, 'run_model', 'failed')
  check(run.credentialType === kind && (kind === 'api_key' ? !run.subscriptionRoute
    : run.subscriptionRoute === (harness === 'codex' ? 'codex_cli' : 'claude_code_cli')), 'run_credential', 'failed')
  check(identity?.version === 1 && identity.requester === ownerId && identity.executionPrincipal === ownerId
    && identity.outputOwner === ownerId && identity.botId === botId && identity.botOwner === ownerId
    && identity.workspaceId === workspaceId && identity.personalResourcePolicy === 'requester_only', 'run_identity', 'failed')
  const payer = identity.billingAccount?.model, runtime = identity.billingAccount?.runtime
  const resource = identity.resourceBindings?.find(item => item.kind === kind && item.id === payer?.resourceId)
  check(payer?.kind === kind && payer.ownerId === ownerId && resource?.ownerId === ownerId && resource.access === 'owner'
    && (kind !== 'api_key' || payer.resourceId === keyId)
    && runtime?.kind === 'e2b' && runtime.ownerId === ownerId, 'run_identity', 'failed')
  return { runId: run.id, status: run.status, harness: run.harness, model: run.model, credentialType: run.credentialType,
    subscriptionRoute: run.subscriptionRoute ?? null, ownModelAccount: true, ownRuntimeAccount: true, workspaceMatched: true }
}

/** A passed Factory check alone does not prove which account/model did it. */
export async function verifyCheckRuns(checks, scope, read) {
  check(checks.length === 2 && new Set(checks.map(attempt => attempt.stage)).size === 2
    && new Set(checks.map(attempt => attempt.runId)).size === 2, 'checks_missing', 'failed')
  const result = []
  for (const attempt of checks) {
    check(['review', 'verify'].includes(attempt.stage) && uuid(attempt.runId), 'checks_missing', 'failed')
    const found = await read(attempt.runId)
    const proof = assertRunEvidence(found, scope)
    check(proof.runId === attempt.runId && proof.status === 'succeeded', 'checks_missing', 'failed')
    result.push({ stage: attempt.stage, ...proof, runStatus: proof.status, status: 'passed' })
  }
  return result
}

/** Submitting a new version does not make the original artifact disposable.
 * The owner's ordinary detail read supplies its original creation scope. */
export async function deleteFixtureArtifact(id, { runIds, issueIds, botId }, { read, remove }) {
  const artifact = await read(id)
  check(uuid(id) && artifact?.id === id && runIds.has(artifact.runId) && issueIds.has(artifact.issueId)
    && artifact.botId === botId, 'artifact_creator_scope')
  const response = await remove(id)
  check([204, 404].includes(response.status), 'cleanup_incomplete', 'failed')
}

const providerCodes = '(payment_required|insufficient_balance|insufficient_quota|billing_hard_limit|billing_error|authentication_failed|invalid_api_key|rate_limit|overloaded|server_error|timeout|connection_error)'
const providerError = new RegExp(`^Model provider failed \\((balance|auth|unavailable)(?:: ${providerCodes})?(?:; HTTP ([1-5][0-9]{2}))?\\)$`)
export function providerReceipt(detail) {
  for (const entry of (detail?.chunks ?? []).toReversed()) {
    const chunk = entry?.chunk
    if (chunk?.type !== 'data-run-state' || chunk.data?.state !== 'failed') continue
    if (chunk.data.stopReason === 'quota_exhausted') return { kind: 'quota' }
    if (chunk.data.stopReason !== 'provider_failure') continue
    const match = typeof chunk.data.error === 'string' && providerError.exec(chunk.data.error)
    if (match) return { kind: match[1], ...(match[2] ? { code: match[2] } : {}), ...(match[3] ? { status: Number(match[3]) } : {}) }
  }
  return null
}

function deterministicId(text) {
  const hex = hash(text).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}

/** Resolve only named, public client references for this exact deployment. */
export async function discoverActions(request) {
  const page = await request('/en')
  check(page.ok, 'action_missing')
  const html = await page.text()
  const queue = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/g)]
    .map(match => new URL(match[1], ORIGIN)).filter(url => url.origin === ORIGIN && url.pathname.startsWith('/mikka/_next/static/chunks/')).map(url => url.pathname))]
  const seen = new Set(), found = {}
  while (queue.length && seen.size < 200 && Object.keys(found).length < actionsAllowed.size) {
    const batch = queue.splice(0, 20).filter(path => !seen.has(path))
    for (const path of batch) seen.add(path)
    await Promise.all(batch.map(async path => {
      const response = await request(path)
      if (!response.ok) return
      const source = await response.text()
      check(source.length <= 8_000_000, 'response_invalid')
      for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]{40,64})",[^;]{0,140}?"([A-Za-z]+)"\)/g))
        if (actionsAllowed.has(match[2])) found[match[2]] = match[1]
      for (const match of source.matchAll(/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)) {
        const next = '/mikka/_next/' + match[0]
        if (!seen.has(next) && !queue.includes(next) && queue.length < 3000) queue.push(next)
      }
    }))
  }
  return found
}

export function actionResult(text, name) {
  check(actionsAllowed.has(name), 'action_not_allowed')
  const rows = new Map()
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]+):(.*)$/.exec(line)
    if (!match) continue
    try { rows.set(match[1], JSON.parse(match[2])) } catch { /* Flight imports/debug rows aren't results. */ }
  }
  let result = rows.get('0')?.a
  for (let depth = 0; depth < 8 && typeof result === 'string' && /^\$@?[a-f0-9]+$/.test(result); depth++) result = rows.get(result.replace(/^\$@?/, ''))
  if (result === undefined) {
    const shape = value => value && typeof value === 'object' && (value.error
      || (name === 'getIssueThread' && value.thread && Array.isArray(value.chunks))
      || (name === 'changeModelOrder' && Array.isArray(value.entries) && typeof value.customized === 'boolean')
      || (name === 'listWorkspaceBots' && Array.isArray(value.bots))
      || (['getIssue', 'setIssueDeleted'].includes(name) && value.issue)
      || (name === 'getDeletedIssue' && uuid(value.id) && value.deletedAt)
      || (name === 'getArtifact' && uuid(value.id) && Array.isArray(value.versions) && 'runId' in value && 'issueId' in value))
    result = [...rows.values()].find(shape)
  }
  if (result?.error) throw new AcceptanceError('action_refused', 'blocked', { serverCode: result.error })
  check(result !== undefined, 'action_refused')
  return result
}

export async function runModelProviderAcceptance({ env = process.env, fetchImpl = fetch, wait = delay, now = Date.now } = {}) {
  const expectedSha = env.MIKKA_EXPECTED_DEPLOYMENT_SHA, mode = env.MIKKA_PROVIDER_ACCEPTANCE_MODE ?? 'preflight'
  check(sha(expectedSha) && ['preflight', 'active'].includes(mode), 'configuration_required')
  check(!env.MIKKA_ACCEPTANCE_BASE_URL || env.MIKKA_ACCEPTANCE_BASE_URL === ORIGIN + '/mikka', 'origin_rejected')
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account_required')
  const workerRunId = Number(env.MIKKA_WORKER_RELEASE_RUN_ID)
  const workerReady = env.MIKKA_WORKER_RELEASE_SHA === expectedSha && Number.isSafeInteger(workerRunId) && workerRunId > 0
  const timeoutMs = Number(env.MIKKA_PROVIDER_ACCEPTANCE_TIMEOUT_MS ?? 600_000)
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1_200_000, 'configuration_required')
  const report = { issue: 1225, pullRequest: 1232, revision: expectedSha, origin: ORIGIN, mode,
    startedAt: new Date(now()).toISOString(), workerRelease: { ready: workerReady,
      ...(workerReady ? { sha: expectedSha, runId: workerRunId } : {}) }, cases: [], status: 'running' }
  let cookie = '', ownerId, workspaceId, actionRefs = {}
  async function request(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const url = new URL(path.startsWith('/mikka/') ? path : '/mikka' + path, ORIGIN)
    check(url.origin === ORIGIN && url.pathname.startsWith('/mikka/') && !url.username && !url.password, 'origin_rejected')
    try {
      return await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw new AcceptanceError('request_failed') }
  }
  async function json(path, body, method) {
    const response = await request(path, body, method)
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.error) throw new AcceptanceError('http_refused', 'blocked', { httpStatus: response.status, serverCode: data?.error })
    check(data !== null, 'response_invalid')
    return data
  }
  async function pin() { assertVersion((await json('/api/version')).build, expectedSha) }
  async function action(name, args) {
    check(actionsAllowed.has(name), 'action_not_allowed')
    check(typeof actionRefs[name] === 'string', 'action_missing')
    const response = await request('/en', args, 'POST', { 'next-action': actionRefs[name], accept: 'text/x-component' })
    if (!response.ok) throw new AcceptanceError('action_refused', 'blocked', { httpStatus: response.status })
    return actionResult(await response.text(), name)
  }
  const orderRead = () => json(`/api/settings/model-order?workspace=${workspaceId}`)
  async function inventory(kind) {
    const [order, keys, connections] = await Promise.all([orderRead(), kind === 'api_key'
      ? json(`/api/settings/api-keys?workspace=${workspaceId}`) : Promise.resolve({ keys: [] }), json(`/api/subscriptions?workspace=${workspaceId}`)])
    return { order, keys, connections, ownerId }
  }
  async function quietWorkspace() {
    const state = await action('listWorkspaceBots', [])
    check(Array.isArray(state?.bots), 'response_invalid')
    check(state.bots.every(bot => bot.status === 'idle' && bot.runningThreads === 0), 'workspace_busy')
    const own = await json('/api/mobile/threads')
    check(Array.isArray(own?.threads) && own.threads.every(thread => !['running', 'waiting', 'paused'].includes(thread.status)), 'workspace_busy')
  }
  async function changeChecked(current, change) {
    await pin()
    check(orderFingerprint(await orderRead()) === orderFingerprint(current), 'order_restore_conflict')
    return action('changeModelOrder', [change, workspaceId])
  }
  async function installOrder(current, wanted, observe) {
    const mutate = async change => {
      // Retain the last acknowledged state even if a later Settings call is
      // refused or its response is lost. Restoration must compare that state.
      observe?.(current, true)
      current = await changeChecked(current, change)
      observe?.(current, false)
    }
    for (const entry of current.entries) if (!wanted.some(next => entryKey(next) === entryKey(entry))) await mutate({ kind: 'remove', id: entry.id })
    for (const entry of wanted) if (!current.entries.some(next => entryKey(next) === entryKey(entry))) await mutate({
      kind: 'add', entries: [{ harness: entry.harness, model: entry.model, source: entry.source }],
    })
    const ids = wanted.map(entry => current.entries.find(next => entryKey(next) === entryKey(entry))?.id)
    check(ids.every(id => typeof id === 'string') && ids.length === current.entries.length, 'order_changed')
    if (JSON.stringify(ids) !== JSON.stringify(current.entries.map(entry => entry.id))) await mutate({ kind: 'reorder', ids })
    return current
  }
  async function threadDetail(issueId, runId) {
    let detail = await action('getIssueThread', [issueId, runId])
    check(detail?.thread?.ownedByCurrentUser === true && uuid(detail.thread.rootRunId), 'run_scope', 'failed')
    if (detail.thread.rootRunId !== runId) detail = await action('getIssueThread', [issueId, detail.thread.rootRunId])
    return detail
  }
  async function runCase(item) {
    const result = { status: 'running', model: item.model, preflight: {}, cleanup: { state: 'not_created' } }
    let bot, fixture, originalOrder, testOrder, orderTouched = false
    const taskIds = new Set(), runIds = new Set(), validatedRunIds = new Set(), issueIds = new Set(), artifactIds = new Set()
    const marker = `1225-${expectedSha.slice(0, 12)}-${item.id}`
    const title = `${marker}.txt`, content = `mikka-provider-acceptance:${marker}\nstatus=ready\n`
    const expected = Buffer.from(content, 'utf8')
    let source, next
    async function inspectRun(runId, issueId, choice) {
      const found = await json(`/api/runs/${runId}/evidence`)
      const proof = assertRunEvidence(found, { ownerId, workspaceId, botId: bot.id, issueId,
        model: choice.model, harness: choice.harness, kind: choice.source.kind, keyId: sourceId(choice) })
      runIds.add(runId)
      validatedRunIds.add(runId)
      for (const file of found.artifacts ?? []) if (uuid(file.id)) artifactIds.add(file.id)
      return { found, proof }
    }
    async function taskFromRuns(cleanup = false) {
      const page = await json(`/api/mobile/bots/${bot.id}`)
      check(Array.isArray(page?.threads), 'response_invalid')
      for (const row of page.threads) {
        check(uuid(row.id), 'run_scope', 'failed')
        const found = await json(`/api/runs/${row.id}/evidence`)
        const identity = found?.run?.executionIdentity
        check(found?.run?.botId === bot.id && uuid(found.run.issueId) && identity?.requester === ownerId
          && identity.workspaceId === workspaceId, 'run_scope', 'failed')
        runIds.add(row.id); issueIds.add(found.run.issueId)
      }
      // Dispatch can be blocked before a run exists. Its owner chat still has
      // the real issue citation; validate its Factory Bot before any mutation.
      const chat = await json(`/api/mobile/chat?bot=${bot.id}`)
      for (const [id, citation] of Object.entries(chat?.sources ?? {})) {
        const issueId = citation?.kind === 'issue' ? id : citation?.kind === 'run' ? citation.issue?.id : null
        if (uuid(issueId)) {
          const listed = await json(`/api/factory/tasks?issueId=${issueId}`)
          for (const summary of listed.tasks ?? []) {
            check(uuid(summary.id), 'task_scope', 'failed')
            const state = await json(`/api/factory/tasks/${summary.id}`)
            if (state.task?.botId === bot.id && state.task.issueId === issueId && state.task.userId === ownerId) issueIds.add(issueId)
          }
        }
      }
      let active
      for (const issueId of issueIds) {
        const list = await json(`/api/factory/tasks?issueId=${issueId}`)
        check(list?.issueId === issueId && Array.isArray(list.tasks), 'task_scope', 'failed')
        for (const entry of list.tasks) {
          check(uuid(entry.id), 'task_scope', 'failed')
          const state = await json(`/api/factory/tasks/${entry.id}`)
          check(uuid(state?.task?.id) && state.task.issueId === issueId && state.task.botId === bot.id && state.task.userId === ownerId, 'task_scope', 'failed')
          taskIds.add(state.task.id)
          for (const attempt of state.attempts ?? []) if (uuid(attempt.runId)) runIds.add(attempt.runId)
          active = state
        }
      }
      if (!cleanup) check(taskIds.size <= 1 && issueIds.size <= 1, 'fixture_ambiguous', 'failed')
      return active
    }
    async function finishCleanup() {
      if (!bot) return
      const cleanup = { state: 'stopping', botId: bot.id, bot: 'retained_no_delete_api', tasksStopped: false,
        threadsStopped: false, chatStopped: false, artifactsDeleted: 0, artifactsRetained: 0, issuesDeleted: 0 }
      result.cleanup = cleanup
      try {
        await json('/api/mobile/chat/stop', { botId: bot.id })
        await taskFromRuns(true)
        const cancelTasks = async () => { for (const taskId of taskIds) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const state = await json(`/api/factory/tasks/${taskId}`)
            check(state.task?.botId === bot.id && state.task.userId === ownerId && issueIds.has(state.task.issueId), 'task_scope', 'failed')
            if (['cancelled', 'revoked', 'completed', 'succeeded'].includes(state.task.status)) break
            const response = await request(`/api/factory/tasks/${taskId}`, { binding: { taskId, revision: state.task.revision },
              eventId: deterministicId(`${marker}:cancel:${state.task.revision}`), action: 'cancel', reason: 'Issue #1225 acceptance cleanup' })
            const body = await response.json().catch(() => null)
            if (response.ok) break
            check(response.status === 409 && ['factoryStale', 'factoryStopped'].includes(body?.error), 'cleanup_incomplete', 'failed')
          }
        } }
        await cancelTasks()
        let stable = 0, previous = ''
        const deadline = now() + 90_000
        while (now() < deadline && stable < 2) {
          await json('/api/mobile/chat/stop', { botId: bot.id })
          await taskFromRuns(true)
          await cancelTasks()
          for (const runId of runIds) {
            const response = await request(`/api/mobile/threads/${runId}/stop`, {}, 'POST')
            const body = await response.json().catch(() => null)
            check(response.ok || (response.status === 409 && body?.error === 'runChainEnded'), 'cleanup_incomplete', 'failed')
          }
          const [page, chat] = await Promise.all([json(`/api/mobile/bots/${bot.id}`), json(`/api/mobile/chat?bot=${bot.id}`)])
          for (const row of page.threads ?? []) if (uuid(row.id)) runIds.add(row.id)
          const signature = [...taskIds, ...issueIds, ...runIds].sort().join(',')
          cleanup.chatStopped = chat.working === false && !chat.streamRunId
          cleanup.threadsStopped = (page.threads ?? []).every(row => !['running', 'waiting', 'paused'].includes(row.status))
          cleanup.tasksStopped = true
          for (const taskId of taskIds) {
            const state = await json(`/api/factory/tasks/${taskId}`)
            if (!['cancelled', 'revoked', 'completed', 'succeeded'].includes(state.task?.status)) cleanup.tasksStopped = false
          }
          stable = cleanup.chatStopped && cleanup.threadsStopped && cleanup.tasksStopped && signature === previous ? stable + 1 : 0
          previous = signature
          if (stable < 2) await wait(3000)
        }
        check(stable >= 2, 'cleanup_incomplete', 'failed')
        for (const runId of runIds) {
          const found = await json(`/api/runs/${runId}/evidence`)
          const identity = found.run?.executionIdentity
          check(found.run?.id === runId && found.run.botId === bot.id && issueIds.has(found.run.issueId)
            && identity?.requester === ownerId && identity.executionPrincipal === ownerId && identity.outputOwner === ownerId
            && identity.botId === bot.id && identity.botOwner === ownerId && identity.workspaceId === workspaceId,
          'run_scope', 'failed')
          validatedRunIds.add(runId)
          for (const artifact of found.artifacts ?? []) if (uuid(artifact.id)) artifactIds.add(artifact.id)
        }
        for (const id of artifactIds) {
          try {
            await deleteFixtureArtifact(id, { runIds: validatedRunIds, issueIds, botId: bot.id }, {
              read: artifactId => action('getArtifact', [artifactId]),
              remove: artifactId => request(`/api/mobile/artifacts/${artifactId}`, undefined, 'DELETE'),
            })
            cleanup.artifactsDeleted++
          } catch (error) {
            cleanup.artifactsRetained++
            cleanup.artifactFailures ??= []
            cleanup.artifactFailures.push({ artifactId: id, ...publicFailure(error) })
          }
        }
        for (const id of issueIds) {
          if (!['getIssue', 'setIssueDeleted', 'getDeletedIssue'].every(name => actionRefs[name])) { cleanup.issue = 'retained_cleanup_action_unavailable'; continue }
          const read = await action('getIssue', [id])
          check(read?.issue?.id === id && read.issue.userId === ownerId && read.issue.title.includes(marker), 'task_scope', 'failed')
          await action('setIssueDeleted', [{ id, revision: read.issue.revision }])
          const deleted = await action('getDeletedIssue', [id])
          check(deleted?.id === id && Boolean(deleted.deletedAt), 'cleanup_incomplete', 'failed')
          cleanup.issuesDeleted++
        }
        cleanup.state = cleanup.artifactsRetained ? 'blocked' : 'stopped'
      } catch (error) { cleanup.state = 'incomplete'; cleanup.error = publicFailure(error) }
    }
    try {
      await pin()
      const inventoryNow = await inventory(item.kind)
      source = ownedSource(item, inventoryNow)
      result.preflight.ownSource = true
      result.preflight.cloudReady = true
      result.preflight.workerReleaseReady = workerReady
      check(Boolean(actionRefs.getIssueThread) && Boolean(actionRefs.getArtifact), 'action_missing')
      if (item.kind === 'api_key') {
        assertFlashTestModel(item.model)
        const options = CASES.slice(1).flatMap(candidate => { try { return [ownedSource(candidate, inventoryNow)] } catch { return [] } })
        check(options.length > 0, 'source_missing')
        next = options[0]
      }
      const plan = caseOrderPlan(inventoryNow.order, item.kind === 'api_key' ? [source, next] : [source], ownerId)
      result.preflight.orderAlreadyMatches = plan.already
      result.preflight.orderRestorable = plan.already || inventoryNow.order.customized === true
      result.preflight.checkModelsRestricted = true
      if (!plan.already) check(Boolean(actionRefs.changeModelOrder), 'action_missing')
      await quietWorkspace()
      result.preflight.workspaceIdle = true
      // One read of the existing owner's menu, before creating any fixture.
      const menu = await json('/api/mobile/model')
      const chatChoice = item.kind === 'api_key' ? next : source
      const chatOptions = (menu?.groups ?? []).filter(group => group.kind === 'subscription').flatMap(group => group.options ?? [])
        .filter(option => option.modelId === chatChoice.model && option.provider === (chatChoice.harness === 'codex' ? 'codex' : 'claude'))
      check(chatOptions.length === 1, chatOptions.length ? 'source_ambiguous' : 'source_missing')
      result.preflight.chatSource = true
      if (mode === 'preflight') { result.status = 'ready'; return result }
      check(workerReady, 'worker_release')
      const bots = await json('/api/bots')
      const named = bots.filter(value => value.name === marker)
      check(named.length <= 1, 'fixture_ambiguous')
      const reusable = named[0]
      if (reusable) {
        check(uuid(reusable.id) && reusable.ownerId === ownerId && reusable.workspaceId === workspaceId, 'bot_scope', 'failed')
        const [page, chat] = await Promise.all([json(`/api/mobile/bots/${reusable.id}`), json(`/api/mobile/chat?bot=${reusable.id}`)])
        result.botId = reusable.id
        result.cleanup = { state: 'retained', botId: reusable.id, bot: 'retained_no_delete_api' }
        // A rerun can reuse a Bot whose setup stopped before any send. Once a
        // paid task was submitted, preserve its receipt rather than silently
        // spending again after its artifact/issue was cleaned up.
        check(Array.isArray(page?.threads) && page.threads.length === 0 && Array.isArray(chat?.items)
          && chat.items.length === 0 && !chat.working && !chat.streamRunId, 'previous_fixture')
      }
      originalOrder = inventoryNow.order
      await quietWorkspace()
      check(orderFingerprint(await orderRead()) === orderFingerprint(originalOrder), 'order_changed')
      testOrder = originalOrder
      await installOrder(originalOrder, plan.wanted, (current, touching) => {
        testOrder = current
        if (touching) orderTouched = true
      })
      const created = reusable ?? await json('/api/bots', { name: marker })
      check(uuid(created?.id) && created.ownerId === ownerId && created.workspaceId === workspaceId, 'bot_scope', 'failed')
      bot = created
      result.botId = bot.id
      result.cleanup = { state: 'created', botId: bot.id }
      const ownMenu = await json(`/api/mobile/model?bot=${bot.id}`)
      const option = (ownMenu.groups ?? []).filter(group => group.kind === 'subscription').flatMap(group => group.options ?? [])
        .find(value => value.id === chatOptions[0].id && value.modelId === chatChoice.model)
      check(Boolean(option), 'model_selection')
      const selected = await json('/api/mobile/model', { bot: bot.id, id: option.id }, 'PUT')
      check(selected?.current?.kind === 'subscription' && selected.current.modelId === chatChoice.model
        && selected.current.available === true && !selected.current.fallback, 'model_selection')
      await pin()
      const current = await json(`/api/mobile/model?bot=${bot.id}`)
      check(current.current?.kind === 'subscription' && current.current.modelId === chatChoice.model && current.current.available === true
        && !current.current.fallback, 'model_changed')
      check(orderFingerprint(await orderRead()) === orderFingerprint(testOrder), 'order_changed')
      check(caseOrderPlan(testOrder, plan.wanted, ownerId).already, 'order_changed')
      const modelInstruction = item.kind === 'api_key'
        ? '执行模型使用当前优先使用的模型设置，不要显式指定执行模型；提供商拒绝时由系统正常按偏好接续。'
        : `执行线程必须显式选择我自己的官方 ${item.provider === 'claude' ? 'Claude Code' : 'Codex'} 订阅模型 ${item.model}，不要换账号、API key 或其他模型。`
      const text = `请创建且只创建一个独立 Factory 任务，任务标题必须是 ${marker}。用这个 Bot 在云端实际执行并交付一个纯文本 Artifact，名称为 ${title}。${modelInstruction}不要操作其他任务、创建仓库、推送代码或发送外部消息。文件必须等于以下 JSON 字符串解码后的精确 UTF-8 字节，包含末尾换行：${JSON.stringify(content)}。检查实际文件内容并用正常 Artifact 提交交付，交给独立 review 和 verify。聊天文字不能替代文件。完成或受阻后只汇报 Task、Thread 和 Artifact 链接，不重试创建第二个任务。`
      // Required Flash policy check is also executed by the workflow before
      // this driver starts. Keep it at the precise API-key send boundary too.
      if (item.kind === 'api_key') assertFlashTestModel(item.model)
      await json('/api/mobile/chat', { botId: bot.id, text, submissionId: deterministicId(marker) })
      const deadline = now() + timeoutMs
      let accepted, rootDetail
      while (now() < deadline) {
        await pin()
        check(orderFingerprint(await orderRead()) === orderFingerprint(testOrder), 'order_changed')
        fixture = await taskFromRuns()
        if (fixture) {
          result.taskId = fixture.task.id
          result.issueId = fixture.task.issueId
          const executions = (fixture.attempts ?? []).filter(attempt => ['execute', 'repair'].includes(attempt.stage) && uuid(attempt.runId))
          const first = executions[0]
          if (first) {
            rootDetail = await threadDetail(fixture.task.issueId, first.runId)
            for (const attempt of rootDetail.thread.attempts ?? []) if (uuid(attempt.runId)) runIds.add(attempt.runId)
            const receipt = providerReceipt(rootDetail)
            if (receipt) result.provider = receipt
          }
          const candidate = fixture.candidates?.find(value => value.id === fixture.task.candidateId)
          const checks = (fixture.attempts ?? []).filter(attempt => attempt.candidateId === candidate?.id && attempt.status === 'passed')
          if (candidate && ['review', 'verify'].every(stage => checks.some(attempt => attempt.stage === stage))) {
            accepted = { candidate, checks }; break
          }
          if (terminalTask.has(fixture.task.status) || (rootDetail?.thread?.status === 'failed' && !rootDetail.thread.modelFallbackPending
            && !(rootDetail.thread.modelFallback ?? []).some(notice => notice.state === 'switched'))) {
            const receipt = providerReceipt(rootDetail)
            if (receipt) throw new AcceptanceError('provider_refused', 'blocked', { providerKind: receipt.kind, providerStatus: receipt.status })
            throw new AcceptanceError('task_blocked')
          }
        }
        await wait(5000)
      }
      check(accepted && fixture && rootDetail, 'task_timeout')
      if (item.kind === 'api_key' && providerReceipt(rootDetail)?.status !== 402) throw new AcceptanceError('not_reproduced', 'not_reproduced')
      const finalChoice = item.kind === 'api_key' ? next : source
      const { found, proof } = await inspectRun(accepted.candidate.runId, fixture.task.issueId, finalChoice)
      check(found.run.status === 'succeeded', 'task_blocked')
      result.execution = proof
      const checks = ['review', 'verify'].map(stage => accepted.checks.findLast(attempt => attempt.stage === stage))
      check(new Set([accepted.candidate.runId, ...checks.map(attempt => attempt.runId)]).size === 3
        && checks.every(attempt => uuid(attempt.runId) && attempt.output?.requestEpoch === fixture.task.sourceEventId), 'checks_missing', 'failed')
      result.checks = await verifyCheckRuns(checks, { ownerId, workspaceId, botId: bot.id, issueId: fixture.task.issueId,
        model: finalChoice.model, harness: finalChoice.harness, kind: finalChoice.source.kind, keyId: sourceId(finalChoice) }, async runId => {
        const { found } = await inspectRun(runId, fixture.task.issueId, finalChoice)
        return found
      })
      if (item.kind === 'api_key') {
        const chain = rootDetail.thread.attempts
        const original = chain[0]
        const { proof: firstProof } = await inspectRun(original.runId, fixture.task.issueId, source)
        result.sourceExecution = firstProof
        const receipt = providerReceipt(rootDetail)
        if (!receipt || receipt.status !== 402 || receipt.kind !== 'balance') throw new AcceptanceError('not_reproduced', 'not_reproduced')
        const notice = rootDetail.thread.modelFallback?.find(value => value.runId === original.runId && value.state === 'switched')
        check(chain.length === 2 && original.status === 'failed' && chain[1].runId === accepted.candidate.runId
          && notice?.failure === 'balance' && notice.from?.model === source.model && notice.from.source === 'api_key'
          && notice.to?.model === next.model && notice.to.source === 'subscription' && notice.to.harness === next.harness, 'fallback_missing', 'failed')
        result.fallback = { status: 402, kind: 'balance', sourceRunId: original.runId, continuationRunId: accepted.candidate.runId,
          from: source.model, to: next.model, attempts: 2, hostConfirmed: true }
      } else check(!(rootDetail.thread.modelFallback ?? []).some(value => value.state === 'switched'), 'run_model', 'failed')
      const files = (found.artifacts ?? []).filter(file => file.title === title)
      check(files.length === 1 && uuid(files[0].id), 'artifact_missing', 'failed')
      const file = files[0]
      check(Number.isSafeInteger(file.latestVersion) && file.latestVersion > 0, 'artifact_scope', 'failed')
      check(typeof file.url === 'string' && new RegExp(`^/mikka/api/artifacts/${file.id}/versions/[1-9][0-9]*/download$`).test(file.url), 'artifact_scope', 'failed')
      const response = await request(file.url)
      check(response.ok, 'artifact_missing', 'failed')
      check(Boolean(response.body), 'artifact_missing', 'failed')
      const chunks = [], reader = response.body.getReader()
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          check(size <= 65_536, 'artifact_content', 'failed')
          chunks.push(part.value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      const bytes = Buffer.concat(chunks)
      check(bytes.equals(expected), 'artifact_content', 'failed')
      result.artifact = { id: file.id, version: file.latestVersion, bytes: bytes.length, sha256: hash(bytes) }
      await pin()
      result.status = 'pass'
    } catch (error) { Object.assign(result, publicFailure(error)) }
    finally {
      await finishCleanup()
      if (originalOrder && testOrder && orderTouched) {
        try {
          // No API revision token exists: compare the exact saved test state
          // immediately before each normal Settings action; never blind-write.
          check(result.cleanup.state !== 'incomplete', 'cleanup_incomplete', 'failed')
          check(orderFingerprint(await orderRead()) === orderFingerprint(testOrder), 'order_restore_conflict')
          await quietWorkspace()
          const restored = await installOrder(testOrder, originalOrder.entries)
          check(JSON.stringify(restored.entries.map(entryKey)) === JSON.stringify(originalOrder.entries.map(entryKey)), 'order_restore_conflict')
          result.cleanup.order = 'restored'
        } catch (error) { result.cleanup.order = 'not_restored'; result.cleanup.orderError = publicFailure(error) }
      }
      if (['incomplete', 'blocked'].includes(result.cleanup.state) || result.cleanup.order === 'not_restored') {
        result.acceptanceStatus = result.status
        result.status = 'failed'
        result.code = 'cleanup_incomplete'
      }
    }
    return result
  }
  try {
    await pin()
    const login = await request('/api/auth/sign-in/email', { email, password })
    check(login.ok, 'sign_in_failed')
    cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    check(Boolean(cookie), 'session_missing')
    const session = await json('/api/auth/get-session')
    check(session?.user?.email?.toLowerCase() === email.toLowerCase() && typeof session.user.id === 'string', 'session_identity')
    ownerId = session.user.id
    const bots = await json('/api/bots')
    check(Array.isArray(bots) && bots.length > 0 && bots.every(bot => bot.ownerId === ownerId && bot.workspaceId === bots[0].workspaceId)
      && uuid(bots[0].workspaceId), 'workspace_missing')
    workspaceId = bots[0].workspaceId
    actionRefs = await discoverActions(request)
    report.cases = await independently(CASES, runCase)
    await pin()
    report.status = report.cases.every(item => item.status === (mode === 'preflight' ? 'ready' : 'pass')) ? (mode === 'preflight' ? 'ready' : 'pass') : 'partial'
  } catch (error) {
    Object.assign(report, publicFailure(error))
    if (!report.cases.length) report.cases = CASES.map(item => ({ case: item.id, ...publicFailure(error) }))
  } finally {
    if (cookie) {
      const signedOut = await request('/api/auth/sign-out', {}).then(response => response.ok).catch(() => false)
      report.sessionClosed = signedOut
    }
    cookie = ''
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

async function writeReport(report) {
  const directory = resolve('model-provider-fallback-report')
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/results.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const summary = ['## Issue #1225 provider acceptance', '', `Revision: ${report.revision ?? 'unavailable'}`, '',
    `Mode: ${report.mode ?? 'preflight'}; result: ${report.status}`, '', '| Path | Result | Code |', '| --- | --- | --- |',
    ...(report.cases ?? []).map(item => `| ${item.case} | ${item.status} | ${item.code ?? ''} |`), '',
    'Reports contain only allowlisted evidence. A blocked path does not count as passed.', ''].join('\n')
  await writeFile(`${directory}/summary.md`, summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report
  try { report = await runModelProviderAcceptance() }
  catch (error) { report = { issue: 1225, pullRequest: 1232, ...publicFailure(error), cases: [] } }
  await writeReport(report)
  if (!['pass', 'ready'].includes(report.status)) process.exitCode = 1
}
