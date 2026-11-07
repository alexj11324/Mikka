// One historical run only. No provider, VM, device mutation or task mutation.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGET = Object.freeze({
  repository: 'alexj11324/Mikka', actor: 'alexj11324', actorId: '183887963',
  branch: 'ops/codex-receipt-f3ef-20261107', source: 'f3ef8f4a5f96909e84a719ab3cd4cf2515d57602',
  workflow: '.github/workflows/codex-receipt-diagnostic.yml', origin: 'https://app.aspectlylabs.com',
  runId: '024dc1a9-6ed2-4c92-a51e-53ffb324ca2c', runHash: '3337d338231d9d31',
})
export const FILES = Object.freeze([TARGET.workflow, 'scripts/ops/codex-receipt-diagnostic.mjs', 'scripts/ops/codex-receipt-diagnostic.test.mjs'])
const API = 'https://api.github.com/repos/' + TARGET.repository
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const STATES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing', 'paused', 'succeeded', 'completed', 'failed', 'stopped', 'cancelled']
// Matches removeOwnedDevice's refusal states; this view only covers this thread.
const LIVE = new Set(['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'])
const PROVIDER_CODES = { balance: ['payment_required', 'insufficient_balance', 'insufficient_quota', 'billing_hard_limit', 'billing_error'],
  auth: ['authentication_failed', 'invalid_api_key'], unavailable: ['rate_limit', 'overloaded', 'server_error', 'timeout', 'connection_error'] }
const CLOSED_ERRORS = new Set(['guard', 'request_denied', 'transport', 'http', 'response', 'identity', 'version', 'run', 'thread'])
class DiagnosticError extends Error {
  constructor(code, options) { super(code, options); this.code = code }
}
const check = (ok, code) => { if (!ok) throw new DiagnosticError(code) }
const closed = (value, allowed) => allowed.includes(value) ? value : 'unclassified'
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)

export function guard(env, event, checkout) {
  const ref = 'refs/heads/' + TARGET.branch
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === TARGET.repository
    && env.GITHUB_REPOSITORY_OWNER === TARGET.actor && env.GITHUB_ACTOR === TARGET.actor
    && env.GITHUB_ACTOR_ID === TARGET.actorId && env.GITHUB_TRIGGERING_ACTOR === TARGET.actor
    && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === ref && env.GITHUB_RUN_ATTEMPT === '1'
    && /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    && env.GITHUB_WORKFLOW_REF === `${TARGET.repository}/${TARGET.workflow}@${ref}`, 'guard')
  check(event?.repository?.full_name === TARGET.repository && event.repository.owner?.login === TARGET.actor
    && event.sender?.login === TARGET.actor && String(event.sender.id) === TARGET.actorId
    && event.ref === ref && event.after === env.GITHUB_SHA && event.deleted === false && event.forced === false, 'guard')
  check(checkout.head === env.GITHUB_SHA && checkout.parents.length === 1 && checkout.parents[0] === TARGET.source
    && checkout.clean && checkout.files.length === FILES.length
    && FILES.every(path => checkout.files.filter(row => row.status === 'A' && row.path === path).length === 1), 'guard')
  return { driverRevision: env.GITHUB_SHA, driverRunId: Number(env.GITHUB_RUN_ID), driverRunAttempt: 1 }
}

export function requestAllowed(url, method, body, { driverRunId, issueId } = {}) {
  if (method === 'GET' && body === undefined && url === `${API}/actions/runs/${driverRunId}`) return true
  const base = TARGET.origin + '/mikka'
  if (method === 'GET' && body === undefined && [base + '/api/version', base + '/api/auth/get-session?disableCookieCache=true',
    base + '/api/runs/' + TARGET.runId + '/evidence'].includes(url)) return true
  if (method === 'POST' && url === base + '/api/auth/sign-in/email') return body && Object.keys(body).sort().join(',') === 'email,password,rememberMe'
    && typeof body.email === 'string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(body.email)
    && typeof body.password === 'string' && body.password.length > 0 && body.rememberMe === false
  if (method === 'POST' && url === base + '/api/auth/sign-out') return body && Object.keys(body).length === 0
  return method === 'POST' && url === base + '/api/rpc' && (issueId === null || UUID.test(issueId ?? ''))
    && body?.version === 1 && body.action === 'agents.getIssueThread' && Object.keys(body).sort().join(',') === 'action,args,version'
    && Array.isArray(body.args) && body.args.length === 2 && body.args[0] === issueId && body.args[1] === TARGET.runId
}

export async function sourceHelpers() {
  const load = path => import(pathToFileURL(resolve(path)).href)
  const [wire, errors, coded, observation] = await Promise.all([load('lib/desktop-rpc/wire.ts'),
    load('packages/protocol/src/user-error-codes.ts'), load('packages/protocol/src/coded-error.ts'), load('scripts/acceptance/cloud-startup.mjs')])
  return { decode: wire.decode, registry: errors.USER_ERROR_CODES, parseError: coded.parseCodedErrorText, observe: observation.observeChunks }
}

export function projectDetail(detail, helpers) {
  const thread = detail.thread
  check(thread?.ownedByCurrentUser === true && Array.isArray(thread.attempts)
    && thread.attempts.some(attempt => attempt.runId === TARGET.runId) && Array.isArray(detail.chunks), 'thread')
  const error = value => {
    if (value === null || value === undefined || value === '') return { code: 'none', detail: null }
    // Only the protocol's exact providerFailureMessage format, never keyword inference.
    const provider = typeof value === 'string' && /^Model provider failed \((balance|auth|unavailable)(?:: ([a-z_]+))?(?:; HTTP ([1-5]\d{2}))?\)$/.exec(value)
    if (provider && (!provider[2] || PROVIDER_CODES[provider[1]].includes(provider[2]))) return { code: 'provider_failure',
      kind: provider[1], providerCode: provider[2] ?? null, httpStatus: provider[3] ? Number(provider[3]) : null }
    const parsed = helpers.parseError(typeof value === 'string' ? value : null)
    if (!parsed || !Object.hasOwn(helpers.registry, parsed.code)) return { code: 'unclassified', detail: null }
    return { code: parsed.code, detail: parsed.detail === null ? null : closed(parsed.detail, helpers.registry[parsed.code]) }
  }
  const sample = typeof thread.prompt === 'string' ? thread.prompt.match(/\bSTARTUP_OK_([a-f0-9]{8}_[1-9]\d*)\b/)?.[1] : undefined
  const record = { runId: TARGET.runId, runIdHash: TARGET.runHash, harness: 'codex', sampleId: sample ?? 'missing-fixture-marker',
    requireReply: true, minToolCalls: 1, requireReplyAfterTool: true, requireRuntimeReceipt: true, requireTerminal: true, requireOfficialTiming: true }
  const proof = helpers.observe(record, detail, Date.now())
  const timing = record.runtimeTiming
  return {
    status: closed(thread.status, STATES), latestRunChanged: thread.latestRunId !== TARGET.runId,
    attempts: thread.attempts.map(row => ({ requestedRun: row.runId === TARGET.runId, status: closed(row.status, STATES), stopping: row.stopping === true })),
    threadHasActiveAttempts: thread.attempts.some(row => LIVE.has(row.status)), error: error(thread.error),
    markerFound: Boolean(sample), executionProofSatisfied: Boolean(sample && proof),
    stages: (record.stages ?? []).map(row => ({ stage: row.stage, ok: row.ok, ms: row.ms })),
    startup: { status: record.startupTimingStatus ?? 'unavailable', outcome: record.daemonStartupTiming?.outcome ?? null,
      phases: record.daemonStartupTiming?.phases.map(row => ({ name: row.name, outcome: row.outcome, ms: row.ms })) ?? [] },
    providerOutputObserved: Boolean(record.firstProviderChunk), replyVerified: record.replyVerified === true,
    toolCalls: record.toolCalls?.length ?? 0, successfulTools: record.toolCalls?.filter(row => row.outcome === 'ok').length ?? 0,
    replyVerifiedAfterTool: record.replyVerifiedAfterTool === true,
    runtime: { status: record.runtimeTimingStatus ?? 'unavailable', complete: timing?.complete === true, truncated: timing?.truncated === true,
      officialAcknowledgement: timing?.agentAccepted?.kind === 'codex_turn_start_ack', evidence: record.runtimeEvidence?.status ?? 'unavailable',
      reason: record.runtimeEvidence?.reason ?? null },
    streamErrors: detail.chunks.filter(row => row.chunk?.type === 'error').map(row => error(row.chunk.errorText)),
    fallbackPending: thread.modelFallbackPending === true,
    fallbacks: (thread.modelFallback ?? []).map(row => ({ state: closed(row.state, ['switched', 'blocked', 'picked']),
      failure: closed(row.failure, ['balance', 'auth', 'unavailable']), continuationIsLatest: row.continuationRunId === thread.latestRunId })),
  }
}

export async function runDiagnostic({ env, identity, helpers, fetchImpl = fetch, guardOnly = false }) {
  const report = { kind: 'fixed-codex-receipt-read', sourceRevision: TARGET.source, runIdHash: TARGET.runHash,
    ...identity, status: 'failed', originalGate: 'failed', modelCalls: 0, resourceMutations: 0, checks: {}, cleanup: {} }
  const cookies = new Map()
  let issueId, signInAttempted = false, stage = 'driver'
  const request = async (url, method = 'GET', body, github = false) => {
    check(requestAllowed(url, method, body, { driverRunId: identity.driverRunId, issueId }), 'request_denied')
    let response, value
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json', 'cache-control': 'no-store', ...(github ? { authorization: `Bearer ${env.GH_TOKEN}` } : {
          origin: TARGET.origin, ...(cookies.size ? { cookie: [...cookies].map(([name, token]) => `${name}=${token}`).join('; ') } : {}),
          ...(url.endsWith('/api/rpc') ? { 'x-mikka-rpc': '1' } : {}) }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) { throw new DiagnosticError('transport', { cause }) }
    check(!response.redirected && (!response.url || response.url === url), 'response')
    if (!github) for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], index = pair.indexOf('=')
      if (index > 0) { const name = pair.slice(0, index), token = pair.slice(index + 1); if (token && !/;\s*max-age=0(?:;|$)/i.test(line)) cookies.set(name, token); else cookies.delete(name) }
    }
    report.lastHttpStatus = response.status
    check(response.status === 200, 'http')
    try { const text = await response.text(); check(Buffer.byteLength(text) <= 8_000_000, 'response'); value = JSON.parse(text) }
    catch (cause) { throw new DiagnosticError('response', { cause }) }
    return value
  }
  const owner = (path, method, body) => request(TARGET.origin + '/mikka' + path, method, body)
  try {
    check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'guard')
    const driver = await request(`${API}/actions/runs/${identity.driverRunId}`, 'GET', undefined, true)
    check(driver.id === identity.driverRunId && driver.run_attempt === 1 && driver.head_sha === identity.driverRevision
      && driver.path === TARGET.workflow && driver.head_branch === TARGET.branch && driver.event === 'push'
      && driver.repository?.full_name === TARGET.repository && driver.head_repository?.full_name === TARGET.repository
      && driver.actor?.login === TARGET.actor && String(driver.actor.id) === TARGET.actorId
      && driver.triggering_actor?.login === TARGET.actor && driver.status === 'in_progress' && driver.conclusion === null, 'guard')
    report.checks.driver = true
    stage = 'version'; check((await owner('/api/version')).build === TARGET.source, 'version')
    report.checks.productionRevision = true
    if (guardOnly) { report.status = 'guarded'; return report }
    stage = 'sign-in'; signInAttempted = true
    await owner('/api/auth/sign-in/email', 'POST', { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD, rememberMe: false })
    stage = 'identity'; const session = await owner('/api/auth/get-session?disableCookieCache=true')
    check(typeof session.user?.id === 'string' && session.user.id.length > 0 && session.user.emailVerified === true
      && session.user.email?.toLowerCase() === env.SMOKE_OWNER_EMAIL.toLowerCase(), 'identity')
    report.checks.normalSmokeSession = true
    stage = 'evidence'; const { run } = await owner('/api/runs/' + TARGET.runId + '/evidence')
    check(run?.id === TARGET.runId && hash(run.id) === TARGET.runHash && run.harness === 'codex' && run.model === 'gpt-6-luna'
      && run.credentialType === 'subscription' && run.executionIdentity?.requester === session.user.id
      && (run.issueId === null || UUID.test(run.issueId ?? '')), 'run')
    issueId = run.issueId
    report.run = { status: closed(run.status, STATES), harness: 'codex', model: 'gpt-6-luna', subscription: true, issueAttached: issueId !== null }
    stage = 'thread'; const reply = await owner('/api/rpc', 'POST', { version: 1, action: 'agents.getIssueThread', args: [issueId, TARGET.runId] })
    check(reply?.version === 1 && reply.ok === true && !reply.error, 'thread')
    report.thread = projectDetail(helpers.decode(reply.result), helpers)
    stage = 'version'; check((await owner('/api/version')).build === TARGET.source, 'version')
    report.status = 'read'
  } catch (error) {
    report.failure = { stage, code: error instanceof DiagnosticError && CLOSED_ERRORS.has(error.code) ? error.code : 'unexpected',
      httpStatus: report.lastHttpStatus ?? null }
  } finally {
    if (signInAttempted) {
      try { await owner('/api/auth/sign-out', 'POST', {}); report.cleanup.sessionClosed = true }
      catch { report.cleanup.sessionClosed = false; report.status = 'failed' }
    }
    cookies.clear()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report
  try {
    check(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--guard'), 'guard')
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
    const identity = guard(process.env, JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), {
      head: git(['rev-parse', 'HEAD']), parents: git(['show', '-s', '--format=%P', 'HEAD']).split(' '),
      clean: git(['status', '--porcelain', '--untracked-files=no']) === '',
      files: git(['diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD']).split('\n').map(row => { const [status, path] = row.split('\t'); return { status, path } }),
    })
    report = await runDiagnostic({ env: process.env, identity, helpers: await sourceHelpers(), guardOnly: process.argv[2] === '--guard' })
  } catch { report = { kind: 'fixed-codex-receipt-read', status: 'failed', failure: { stage: 'guard', code: 'guard' } } }
  console.log(JSON.stringify(report))
  if (!['read', 'guarded'].includes(report.status)) process.exitCode = 1
}
