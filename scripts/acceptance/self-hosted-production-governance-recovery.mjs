// Recovery reads only this exact driver's earlier attempt. No raw log, signed
// download URL, cookie, bearer, email, or API response leaves this module.
import { createHash } from 'node:crypto'
import { CORE_WORKFLOW } from './self-hosted-production-target.mjs'

const API = 'https://api.github.com/repos/alexj11324/Mikka'
const REPOSITORY = 'alexj11324/Mikka'
export const GOVERNANCE_JOB = 'Core production API and gateway acceptance'
export const GOVERNANCE_STEP = 'Verify the registered Team Organization owner and audit APIs with exact cleanup'
export const GOVERNANCE_JOURNAL_PREFIX = 'MIKKA_GOVERNANCE_BINDING_RECEIPT='
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const iso = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value))
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const digest = value => createHash('sha256').update(value).digest('hex')
const STATES = ['create_intent', 'candidate_recorded', 'ownership_bound', 'organization_bound', 'rename_intent',
  'renamed', 'audit_intent', 'business_passed', 'archive_intent', 'archived', 'recovery_bound', 'unresolved', 'closed']
const CODES = new Set(['governance_recovery_reference_invalid', 'governance_recovery_read_failed',
  'governance_recovery_proof_invalid', 'governance_recovery_log_invalid'])

export class GovernanceRecoveryError extends Error {
  constructor(code, httpStatus) {
    super(CODES.has(code) ? code : 'governance_recovery_proof_invalid')
    this.name = 'GovernanceRecoveryError'; this.httpStatus = httpStatus
  }
}
const check = (value, code = 'governance_recovery_proof_invalid', status) => {
  if (!value) throw new GovernanceRecoveryError(code, status)
}
export const governanceRecoveryFailure = error => error instanceof GovernanceRecoveryError
  ? { code: error.message, ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) } : null

export function governanceRecoveryReference(value) {
  check(exact(value, ['schema', 'purpose', 'runId', 'attempt', 'jobId', 'journalSha256'])
    && value.schema === 1 && value.purpose === 'mikka1856-governance-journal-recovery'
    && positive(value.runId) && positive(value.attempt) && positive(value.jobId) && HASH.test(value.journalSha256 ?? ''),
  'governance_recovery_reference_invalid')
  return { schema: 1, purpose: value.purpose, runId: value.runId, attempt: value.attempt,
    jobId: value.jobId, journalSha256: value.journalSha256 }
}

export function governanceBindingJournal(value) {
  const keys = ['schema', 'purpose', 'applicationSha', 'headSha', 'driverRunId', 'driverAttempt', 'window',
    'ownerHash', 'originalWorkspaceId', 'selectedWorkspaceId', 'sessionIdHash', 'priorSessionIdHashes', 'recoveryOf',
    'nonce', 'baselineOrgHashes', 'intentAt', 'organizationId', 'organizationCreatedAt', 'ownershipVerified',
    'emptyBindingsVerified', 'archiveIntent', 'archiveConfirmed', 'state', 'sequence', 'previousSha256', 'observedAt']
  check(exact(value, keys) && value.schema === 1 && value.purpose === 'mikka1856-owned-organization'
    && SHA.test(value.applicationSha ?? '') && SHA.test(value.headSha ?? '')
    && positive(value.driverRunId) && positive(value.driverAttempt)
    && exact(value.window, ['commentId', 'markerSha256']) && positive(value.window.commentId) && HASH.test(value.window.markerSha256 ?? '')
    && HASH.test(value.ownerHash ?? '') && HASH.test(value.sessionIdHash ?? '')
    && ['originalWorkspaceId', 'selectedWorkspaceId', 'nonce'].every(key => UUID.test(value[key] ?? ''))
    && Array.isArray(value.baselineOrgHashes) && value.baselineOrgHashes.length <= 256
    && value.baselineOrgHashes.every(hash => HASH.test(hash)) && new Set(value.baselineOrgHashes).size === value.baselineOrgHashes.length
    && Array.isArray(value.priorSessionIdHashes) && value.priorSessionIdHashes.length <= 8
    && value.priorSessionIdHashes.every(hash => HASH.test(hash) && hash !== value.sessionIdHash)
    && new Set(value.priorSessionIdHashes).size === value.priorSessionIdHashes.length
    && (value.organizationId === null || UUID.test(value.organizationId))
    && (value.organizationCreatedAt === null || iso(value.organizationCreatedAt))
    && ['ownershipVerified', 'emptyBindingsVerified', 'archiveIntent', 'archiveConfirmed'].every(key => typeof value[key] === 'boolean')
    && (!value.ownershipVerified || value.organizationId !== null && value.organizationCreatedAt !== null)
    && (!value.emptyBindingsVerified || value.ownershipVerified)
    && (!value.archiveIntent || value.emptyBindingsVerified) && (!value.archiveConfirmed || value.archiveIntent)
    && iso(value.intentAt) && iso(value.observedAt) && Date.parse(value.intentAt) <= Date.parse(value.observedAt)
    && STATES.includes(value.state) && positive(value.sequence)
    && (value.sequence === 1 ? value.previousSha256 === null : HASH.test(value.previousSha256 ?? '')))
  const recoveryOf = value.recoveryOf === null ? null : governanceRecoveryReference(value.recoveryOf)
  check(recoveryOf ? recoveryOf.runId === value.driverRunId && recoveryOf.attempt < value.driverAttempt
    && value.priorSessionIdHashes.length > 0 : value.priorSessionIdHashes.length === 0)
  check(value.state !== 'recovery_bound' || recoveryOf !== null)
  check(value.state !== 'archived' || value.archiveConfirmed)
  return { schema: 1, purpose: value.purpose, applicationSha: value.applicationSha, headSha: value.headSha,
    driverRunId: value.driverRunId, driverAttempt: value.driverAttempt,
    window: { commentId: value.window.commentId, markerSha256: value.window.markerSha256 }, ownerHash: value.ownerHash,
    originalWorkspaceId: value.originalWorkspaceId, selectedWorkspaceId: value.selectedWorkspaceId,
    sessionIdHash: value.sessionIdHash, priorSessionIdHashes: [...value.priorSessionIdHashes].sort(), recoveryOf,
    nonce: value.nonce, baselineOrgHashes: [...value.baselineOrgHashes].sort(), intentAt: value.intentAt,
    organizationId: value.organizationId, organizationCreatedAt: value.organizationCreatedAt,
    ownershipVerified: value.ownershipVerified, emptyBindingsVerified: value.emptyBindingsVerified,
    archiveIntent: value.archiveIntent, archiveConfirmed: value.archiveConfirmed, state: value.state,
    sequence: value.sequence, previousSha256: value.previousSha256, observedAt: value.observedAt }
}

export function governanceJournalEnvelope(value) {
  const journal = governanceBindingJournal(value)
  return { sha256: digest(JSON.stringify(journal)), journal }
}

const staticJournal = value => {
  const { organizationId: _id, organizationCreatedAt: _created, ownershipVerified: _owner, emptyBindingsVerified: _empty,
    archiveIntent: _intent, archiveConfirmed: _confirmed, state: _state, sequence: _sequence, previousSha256: _previous,
    observedAt: _observed, ...stable } = value
  return JSON.stringify(stable)
}
export function verifyGovernanceJournalChain(records) {
  check(Array.isArray(records) && records.length > 0 && records.length <= 64, 'governance_recovery_log_invalid')
  for (const [index, record] of records.entries()) {
    const current = record.journal, previous = records[index - 1]
    check(current.sequence === index + 1 && (index === 0 ? current.previousSha256 === null : current.previousSha256 === previous.sha256),
      'governance_recovery_log_invalid')
    if (!previous) continue
    check(staticJournal(current) === staticJournal(previous.journal)
      && Date.parse(current.observedAt) >= Date.parse(previous.journal.observedAt)
      && (!previous.journal.organizationId || previous.journal.organizationId === current.organizationId)
      && (!previous.journal.organizationCreatedAt || previous.journal.organizationCreatedAt === current.organizationCreatedAt)
      && ['ownershipVerified', 'emptyBindingsVerified', 'archiveIntent', 'archiveConfirmed']
        .every(key => !previous.journal[key] || current[key]), 'governance_recovery_log_invalid')
  }
  return records.at(-1)
}

async function boundedText(response, maximum) {
  const reader = response.body?.getReader(), chunks = []; let length = 0
  check(reader, 'governance_recovery_read_failed', response.status)
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > maximum) { await reader.cancel(); throw new GovernanceRecoveryError('governance_recovery_log_invalid') }
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch (error) {
    if (error instanceof GovernanceRecoveryError) throw error
    throw new GovernanceRecoveryError('governance_recovery_read_failed', response.status)
  } finally { reader.releaseLock() }
}

export async function readGovernanceRecovery({ reference, selected, env, fetchImpl = fetch, now = Date.now }) {
  const ref = governanceRecoveryReference(reference)
  check(selected?.selected === true && selected.window?.phase === 'cleanup'
    && ref.runId === selected.driverRunId && ref.attempt < selected.driverRunAttempt
    && SHA.test(selected.applicationSha ?? '') && SHA.test(selected.headSha ?? '')
    && typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0)
  const request = async (url, { authenticated = true, redirect = 'error' } = {}) => {
    let response
    try { response = await fetchImpl(url, { method: 'GET', redirect, cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: authenticated ? { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN,
        'x-github-api-version': '2022-11-28' } : { accept: 'text/plain' } }) }
    catch { throw new GovernanceRecoveryError('governance_recovery_read_failed') }
    check(!response.redirected && (!response.url || response.url === url), 'governance_recovery_read_failed', response.status)
    return response
  }
  const read = async path => {
    const response = await request(API + path)
    check(response.status === 200, 'governance_recovery_read_failed', response.status)
    try { return JSON.parse(await boundedText(response, 1_000_000)) }
    catch (error) { if (error instanceof GovernanceRecoveryError) throw error; throw new GovernanceRecoveryError('governance_recovery_read_failed', response.status) }
  }
  const run = await read('/actions/runs/' + ref.runId + '/attempts/' + ref.attempt)
  check(run?.id === ref.runId && run.run_attempt === ref.attempt && run.status === 'completed'
    && run.event === 'workflow_run' && run.head_branch === 'main' && run.head_sha === selected.applicationSha
    && run.path === CORE_WORKFLOW && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY)
  const listing = await read('/actions/runs/' + ref.runId + '/attempts/' + ref.attempt + '/jobs?per_page=100')
  check(Number.isSafeInteger(listing?.total_count) && listing.total_count > 0 && listing.total_count <= 100
    && Array.isArray(listing.jobs) && listing.jobs.length === listing.total_count)
  const matches = listing.jobs.filter(job => job?.id === ref.jobId && job.name === GOVERNANCE_JOB)
  check(matches.length === 1)
  const job = matches[0]
  check(job.run_id === ref.runId && job.run_attempt === ref.attempt
    && job.head_sha === selected.applicationSha && job.head_branch === 'main'
    && job.status === 'completed' && job.run_url === API + '/actions/runs/' + ref.runId
    && iso(job.started_at) && iso(job.completed_at) && Date.parse(job.completed_at) <= now()
    && Date.parse(job.started_at) <= Date.parse(job.completed_at)
    && Array.isArray(job.steps) && job.steps.filter(step => step.name === GOVERNANCE_STEP && step.status === 'completed'
      && ['success', 'failure', 'cancelled', 'timed_out'].includes(step.conclusion)).length === 1)
  const download = await request(API + '/actions/jobs/' + ref.jobId + '/logs', { redirect: 'manual' })
  check(download.status === 302, 'governance_recovery_read_failed', download.status)
  let url
  try { url = new URL(download.headers.get('location')) } catch { throw new GovernanceRecoveryError('governance_recovery_read_failed') }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)
      || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname)), 'governance_recovery_read_failed')
  const response = await request(url.href, { authenticated: false })
  check(response.status === 200, 'governance_recovery_read_failed', response.status)
  const log = await boundedText(response, 8_000_000), records = []
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(GOVERNANCE_JOURNAL_PREFIX)) continue
    const match = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z[ \t]+)?MIKKA_GOVERNANCE_BINDING_RECEIPT=(\{[^\r\n]*\})$/.exec(line)
    check(match && match[1].length <= 24_000, 'governance_recovery_log_invalid')
    let raw
    try { raw = JSON.parse(match[1]) } catch { throw new GovernanceRecoveryError('governance_recovery_log_invalid') }
    check(exact(raw, ['sha256', 'journal']), 'governance_recovery_log_invalid')
    const record = governanceJournalEnvelope(raw.journal)
    check(record.sha256 === raw.sha256 && JSON.stringify(record) === match[1]
      && record.journal.applicationSha === selected.applicationSha && record.journal.headSha === selected.headSha
      && record.journal.driverRunId === ref.runId && record.journal.driverAttempt === ref.attempt
      && Date.parse(record.journal.observedAt) >= Date.parse(job.started_at) - 1_000
      && Date.parse(record.journal.observedAt) <= Date.parse(job.completed_at) + 1_000, 'governance_recovery_log_invalid')
    records.push(record)
  }
  const latest = verifyGovernanceJournalChain(records)
  check(latest.sha256 === ref.journalSha256 && latest.journal.state !== 'closed', 'governance_recovery_log_invalid')
  return { reference: ref, journal: latest.journal, proof: { source: 'completed_github_job_log',
    originalJobStatus: job.status, originalAttempt: ref.attempt, journalSha256: latest.sha256, journalRecords: records.length } }
}
