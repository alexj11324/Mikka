// Read-only proof for recovery of one earlier Inbox acceptance attempt.
// No account credential, provider response, downloaded log or signed URL leaves
// this module. The only output is the closed journal emitted by this driver.
import { createHash } from 'node:crypto'
import { CORE_WORKFLOW } from './self-hosted-production-target.mjs'

const API = 'https://api.github.com/repos/alexj11324/Mikka'
const REPOSITORY = 'alexj11324/Mikka'
const JOB = 'Core production API and gateway acceptance'
const STEP = 'Verify the exact Inbox fixture or inventory under its current release window'
export const INBOX_JOURNAL_PREFIX = 'MIKKA_INBOX_BINDING_RECEIPT='
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const iso = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value))
const digest = value => createHash('sha256').update(value).digest('hex')
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const states = ['bound_before_mutation', 'business_checks_passed', 'recovery_bound_before_cleanup', 'cleaned']
const codes = new Set(['recovery_reference_invalid', 'recovery_read_failed', 'recovery_proof_invalid', 'recovery_log_invalid'])

export class InboxRecoveryError extends Error {
  constructor(code, httpStatus) { super(codes.has(code) ? code : 'recovery_proof_invalid'); this.name = 'InboxRecoveryError'; this.httpStatus = httpStatus }
}
const check = (value, code = 'recovery_proof_invalid', status) => { if (!value) throw new InboxRecoveryError(code, status) }
export const inboxRecoveryFailure = error => error instanceof InboxRecoveryError
  ? { code: error.message, ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) } : null

export function inboxRecoveryReference(value) {
  check(exactKeys(value, ['schema', 'purpose', 'runId', 'attempt', 'jobId', 'journalSha256']) && value.schema === 1
    && value.purpose === 'mikka1820-journal-recovery' && positive(value.runId) && positive(value.attempt)
    && positive(value.jobId) && HASH.test(value.journalSha256 ?? ''), 'recovery_reference_invalid')
  return { schema: 1, purpose: value.purpose, runId: value.runId, attempt: value.attempt,
    jobId: value.jobId, journalSha256: value.journalSha256 }
}

/** Canonical, closed projection. Hashes identify sessions; bearer values and
 * raw user/session identifiers are never part of a recovery record. */
export function inboxBindingJournal(value) {
  const keys = ['schema', 'purpose', 'applicationSha', 'headSha', 'driverRunId', 'driverAttempt', 'window',
    'ownerHash', 'workspaceId', 'suggestionId', 'originalWorkspaceId', 'selectedWorkspaceId', 'sessionIdHash',
    'priorSessionIdHashes', 'recoveryOf', 'nonce', 'sourceUrl', 'occurredAt', 'action', 'required',
    'externalSourceClosed', 'sourceEventId', 'sourceIssueNumber', 'state', 'observedAt']
  check(exactKeys(value, keys) && value.schema === 1 && value.purpose === 'mikka1820-exact-suggestion'
    && SHA.test(value.applicationSha ?? '') && SHA.test(value.headSha ?? '')
    && positive(value.driverRunId) && positive(value.driverAttempt)
    && exactKeys(value.window, ['commentId', 'markerSha256']) && positive(value.window.commentId) && HASH.test(value.window.markerSha256 ?? '')
    && HASH.test(value.ownerHash ?? '') && HASH.test(value.sessionIdHash ?? '')
    && ['workspaceId', 'suggestionId', 'originalWorkspaceId', 'selectedWorkspaceId', 'nonce'].every(key => UUID.test(value[key] ?? ''))
    && Array.isArray(value.priorSessionIdHashes) && value.priorSessionIdHashes.length <= 8
    && value.priorSessionIdHashes.every(hash => HASH.test(hash) && hash !== value.sessionIdHash)
    && new Set(value.priorSessionIdHashes).size === value.priorSessionIdHashes.length
    && (value.recoveryOf === null || object(value.recoveryOf))
    && iso(value.occurredAt) && iso(value.observedAt) && Date.parse(value.occurredAt) <= Date.parse(value.observedAt)
    && states.includes(value.state) && value.externalSourceClosed === true
    && positive(value.sourceEventId) && positive(value.sourceIssueNumber)
    && (value.action === 'reply' && value.required === false || value.action === 'handle' && value.required === true))
  const base = 'https://github.com/alexj11324/Mikka-handoff/'
  check(['issues/', 'pull/'].some(kind => value.sourceUrl === base + kind + value.sourceIssueNumber
    + (value.action === 'reply' ? '#issuecomment-' + value.sourceEventId : '')))
  const recoveryOf = value.recoveryOf === null ? null : inboxRecoveryReference(value.recoveryOf)
  check(recoveryOf ? recoveryOf.runId === value.driverRunId && recoveryOf.attempt < value.driverAttempt
    && value.priorSessionIdHashes.length > 0 : value.priorSessionIdHashes.length === 0)
  check(value.state !== 'recovery_bound_before_cleanup' || recoveryOf !== null)
  return { schema: 1, purpose: value.purpose, applicationSha: value.applicationSha, headSha: value.headSha,
    driverRunId: value.driverRunId, driverAttempt: value.driverAttempt,
    window: { commentId: value.window.commentId, markerSha256: value.window.markerSha256 }, ownerHash: value.ownerHash,
    workspaceId: value.workspaceId, suggestionId: value.suggestionId, originalWorkspaceId: value.originalWorkspaceId,
    selectedWorkspaceId: value.selectedWorkspaceId, sessionIdHash: value.sessionIdHash,
    priorSessionIdHashes: [...value.priorSessionIdHashes].sort(), recoveryOf, nonce: value.nonce,
    sourceUrl: value.sourceUrl, occurredAt: value.occurredAt, action: value.action, required: value.required,
    externalSourceClosed: true, sourceEventId: value.sourceEventId, sourceIssueNumber: value.sourceIssueNumber,
    state: value.state, observedAt: value.observedAt }
}

export function inboxJournalEnvelope(value) {
  const journal = inboxBindingJournal(value)
  return { sha256: digest(JSON.stringify(journal)), journal }
}

async function boundedText(response, maximum) {
  const reader = response.body?.getReader(), chunks = []; let length = 0
  check(reader, 'recovery_read_failed', response.status)
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > maximum) { await reader.cancel(); throw new InboxRecoveryError('recovery_log_invalid') }
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch (error) { if (error instanceof InboxRecoveryError) throw error; throw new InboxRecoveryError('recovery_read_failed', response.status) }
  finally { reader.releaseLock() }
}

/** Requires Actions read only. GitHub's job-log endpoint returns a temporary
 * plain-text download URL; the repository token is never forwarded there.
 * https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run
 */
export async function readInboxRecovery({ reference, selected, env, fetchImpl = fetch, now = Date.now }) {
  const ref = inboxRecoveryReference(reference)
  check(ref.runId === selected.driverRunId && ref.attempt < selected.driverRunAttempt
    && selected.selected === true && selected.window.phase === 'cleanup'
    && SHA.test(selected.applicationSha ?? '') && SHA.test(selected.headSha ?? '')
    && typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0)
  const request = async (url, { authenticated = true, redirect = 'error' } = {}) => {
    let response
    try { response = await fetchImpl(url, { method: 'GET', redirect, cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: authenticated ? { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN,
        'x-github-api-version': '2022-11-28' } : { accept: 'text/plain' } }) }
    catch { throw new InboxRecoveryError('recovery_read_failed') }
    check(!response.redirected && (!response.url || response.url === url), 'recovery_read_failed', response.status)
    return response
  }
  const read = async path => {
    const response = await request(API + path)
    check(response.status === 200, 'recovery_read_failed', response.status)
    try { return JSON.parse(await boundedText(response, 1_000_000)) }
    catch (error) { if (error instanceof InboxRecoveryError) throw error; throw new InboxRecoveryError('recovery_read_failed', response.status) }
  }
  const run = await read(`/actions/runs/${ref.runId}/attempts/${ref.attempt}`)
  check(run?.id === ref.runId && run.run_attempt === ref.attempt && run.status === 'completed'
    && run.event === 'workflow_run' && run.head_branch === 'main' && run.head_sha === selected.applicationSha
    && run.path === CORE_WORKFLOW && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY)
  const listing = await read(`/actions/runs/${ref.runId}/attempts/${ref.attempt}/jobs?per_page=100`)
  check(Number.isSafeInteger(listing?.total_count) && listing.total_count > 0 && listing.total_count <= 100
    && Array.isArray(listing.jobs) && listing.jobs.length === listing.total_count)
  const matches = listing.jobs.filter(job => job?.id === ref.jobId && job.name === JOB)
  check(matches.length === 1)
  const job = matches[0]
  // Bind both membership in the complete attempt-specific listing and the
  // independently returned job attempt, not a latest-attempt projection.
  check(job.run_id === ref.runId && job.run_attempt === ref.attempt
    && job.head_sha === selected.applicationSha && job.head_branch === 'main'
    && job.status === 'completed' && job.run_url === API + '/actions/runs/' + ref.runId
    && iso(job.started_at) && iso(job.completed_at) && Date.parse(job.completed_at) <= now()
    && Date.parse(job.started_at) <= Date.parse(job.completed_at)
    && Array.isArray(job.steps) && job.steps.filter(step => step.name === STEP && step.status === 'completed'
      && ['success', 'failure', 'cancelled', 'timed_out'].includes(step.conclusion)).length === 1)
  const download = await request(API + '/actions/jobs/' + ref.jobId + '/logs', { redirect: 'manual' })
  check(download.status === 302, 'recovery_read_failed', download.status)
  let url
  try { url = new URL(download.headers.get('location')) } catch { throw new InboxRecoveryError('recovery_read_failed') }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)
      || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname)), 'recovery_read_failed')
  const response = await request(url.href, { authenticated: false })
  check(response.status === 200, 'recovery_read_failed', response.status)
  const log = await boundedText(response, 8_000_000), records = []
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(INBOX_JOURNAL_PREFIX)) continue
    const match = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z[ \t]+)?MIKKA_INBOX_BINDING_RECEIPT=(\{[^\r\n]*\})$/.exec(line)
    check(match && match[1].length <= 12_000, 'recovery_log_invalid')
    let raw
    try { raw = JSON.parse(match[1]) } catch { throw new InboxRecoveryError('recovery_log_invalid') }
    check(exactKeys(raw, ['sha256', 'journal']), 'recovery_log_invalid')
    const record = inboxJournalEnvelope(raw.journal)
    check(record.sha256 === raw.sha256 && JSON.stringify(record) === match[1], 'recovery_log_invalid')
    check(record.journal.applicationSha === selected.applicationSha && record.journal.headSha === selected.headSha
      && record.journal.driverRunId === ref.runId && record.journal.driverAttempt === ref.attempt
      && Date.parse(record.journal.observedAt) >= Date.parse(job.started_at) - 1_000
      && Date.parse(record.journal.observedAt) <= Date.parse(job.completed_at) + 1_000, 'recovery_log_invalid')
    records.push(record)
  }
  const bound = records.filter(record => ['bound_before_mutation', 'recovery_bound_before_cleanup'].includes(record.journal.state))
  check(bound.length === 1 && bound[0].sha256 === ref.journalSha256, 'recovery_log_invalid')
  const stable = ({ state: _state, observedAt: _time, ...value }) => JSON.stringify(value)
  check(records.every(record => stable(record.journal) === stable(bound[0].journal)), 'recovery_log_invalid')
  return { reference: ref, journal: bound[0].journal, proof: { source: 'completed_github_job_log',
    originalJobStatus: job.status, originalAttempt: ref.attempt, journalSha256: bound[0].sha256 } }
}
