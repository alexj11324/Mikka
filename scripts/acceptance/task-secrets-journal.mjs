// Trusted runner bookkeeping only. No value, cookie, capability or object body
// belongs in this journal; the existing artifact allowlist keeps only receipts.
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const check = (condition, code = 'journal') => { if (!condition) throw Error(`task_secrets_${code}`) }
const iso = value => new Date(value).toISOString()
const positive = value => Number.isSafeInteger(value) && value > 0
export const SECRET_BUDGET = Object.freeze({ jobMs: 35 * 60_000, stepMs: 24 * 60_000,
  fixtureMs: 20 * 60_000, evidenceMs: 60_000, cleanupMs: 4 * 60_000, recoveryStepMs: 5 * 60_000, uploadMs: 60_000 })

/** Read the running job, not the later shell/process clock. The existing
 * actions:read token suffices; a partial page or unknown job never starts work.
 */
export async function readSecretJobStart(env, { fetchImpl = fetch, now = Date.now, expectedJob = 'acceptance' } = {}) {
  const repo = 'alexj11324/Mikka', runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repo && env.GITHUB_REF === 'refs/heads/main'
    && ['acceptance', 'factory'].includes(expectedJob) && env.GITHUB_JOB === expectedJob
    && positive(runId) && positive(attempt) && env.GITHUB_TOKEN
    && SHA.test(env.GITHUB_SHA ?? '') && env.APPLICATION_SHA === env.GITHUB_SHA, 'budget')
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  check(response.ok && response.body && !/rel="?next\b/.test(response.headers.get('link') ?? ''), 'budget')
  const reader = response.body.getReader(), chunks = []; let bytes = 0
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break
      bytes += item.value.byteLength; check(bytes <= 128 * 1024, 'budget'); chunks.push(item.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const listing = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  check(Array.isArray(listing.jobs) && listing.jobs.length <= 100 && listing.total_count === listing.jobs.length, 'budget')
  const matches = listing.jobs.filter(job => job.name === expectedJob)
  check(matches.length === 1, 'budget')
  const job = matches[0], started = Date.parse(job.started_at ?? '')
  check(positive(job.id) && job.run_id === runId && (job.run_attempt === undefined || job.run_attempt === attempt)
    && job.head_sha === env.GITHUB_SHA && job.status === 'in_progress' && job.conclusion === null
    && Number.isFinite(started) && started <= now(), 'budget')
  return { id: job.id, startedAt: iso(started), source: 'github_actions_job.started_at' }
}

/** One-shot deadlines, never a background status poll. The finite provider
 * lifetime is not renewed. Recovery may retire an exact VM after the owner
 * window, but the Secret writer independently still refuses an expired window.
 */
export function createSecretBudget({ jobStartedAt, startedAt, window, recovery = false }, { now = Date.now, signal } = {}) {
  const jobStart = Date.parse(jobStartedAt), start = Date.parse(startedAt)
  check(Number.isFinite(jobStart) && Number.isFinite(start) && jobStart <= start && start <= now(), 'budget')
  let fixtureDeadline, phase = recovery ? 'cleanup' : 'execution'
  const controllers = new Map(['execution', 'evidence', 'cleanup'].map(kind => [kind, new AbortController()])), timers = []
  const hardEnd = () => Math.min(jobStart + SECRET_BUDGET.jobMs - SECRET_BUDGET.uploadMs - (recovery ? 0 : SECRET_BUDGET.recoveryStepMs),
    start + (recovery ? SECRET_BUDGET.cleanupMs : SECRET_BUDGET.stepMs - SECRET_BUDGET.uploadMs),
    ...(!recovery && window ? [Date.parse(window.expiresAt) - 30_000] : []),
    ...(!recovery && fixtureDeadline ? [fixtureDeadline] : []))
  const deadline = kind => hardEnd() - (kind === 'execution' ? SECRET_BUDGET.cleanupMs + SECRET_BUDGET.evidenceMs
    : kind === 'evidence' ? SECRET_BUDGET.cleanupMs : 0)
  const arm = () => {
    for (const timer of timers.splice(0)) clearTimeout(timer)
    for (const kind of ['execution', 'evidence', 'cleanup']) {
      const controller = controllers.get(kind)
      const timer = setTimeout(() => controller.abort(Error('task_secrets_budget')), Math.max(0, deadline(kind) - now()))
      timer.unref?.(); timers.push(timer)
    }
  }
  arm()
  const remaining = (kind = phase, maximum = 30_000) => {
    check(['execution', 'evidence', 'cleanup'].includes(kind) && Number.isFinite(maximum) && maximum > 0, 'budget')
    const available = deadline(kind) - now()
    check(available > 0 && !controllers.get(kind).signal.aborted && (kind === 'cleanup' || !signal?.aborted), 'budget')
    return Math.max(1, Math.floor(Math.min(available, maximum)))
  }
  const currentSignal = (kind = phase) => {
    remaining(kind)
    const own = controllers.get(kind).signal
    return signal && kind !== 'cleanup' ? AbortSignal.any([own, signal]) : own
  }
  return {
    remaining,
    signal: currentSignal,
    phase: value => { check(['execution', 'evidence', 'cleanup'].includes(value), 'budget'); phase = value },
    bindFixture: started => {
      const time = Date.parse(started)
      check(!recovery && !fixtureDeadline && Number.isFinite(time) && time >= start && time <= now(), 'budget')
      fixtureDeadline = time + SECRET_BUDGET.fixtureMs; arm(); remaining()
    },
    snapshot: () => ({ jobStartedAt: iso(jobStart), jobDeadlineAt: iso(jobStart + SECRET_BUDGET.jobMs),
      recoveryReservedUntilAt: iso(jobStart + SECRET_BUDGET.jobMs - SECRET_BUDGET.uploadMs),
      executionDeadlineAt: iso(deadline('execution')), evidenceDeadlineAt: iso(deadline('evidence')),
      cleanupDeadlineAt: iso(deadline('cleanup')), fixtureDeadlineAt: fixtureDeadline ? iso(fixtureDeadline) : null,
      limits: SECRET_BUDGET, hardJobCancellationRecoveryGuaranteed: false }),
    fetch: fetchImpl => (url, init = {}) => fetchImpl(url, { ...init,
      signal: AbortSignal.any([currentSignal(), ...(init.signal ? [init.signal] : [])]) }),
    close: () => { for (const timer of timers) clearTimeout(timer); for (const controller of controllers.values()) controller.abort() },
  }
}

export async function writeSecretCheckpoint(path, value) {
  const directory = dirname(path), temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const folder = await lstat(directory)
  check(folder.isDirectory() && !folder.isSymbolicLink())
  await chmod(directory, 0o700)
  const text = JSON.stringify(value, null, 2) + '\n'
  check(Buffer.byteLength(text) <= 2 * 1024 * 1024 && !/mikka1712s_[a-f0-9]{64}/.test(text))
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

const picked = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const digest = value => createHash('sha256').update(value).digest('hex')
const OBJECT_CATEGORIES = ['chunks', 'messages', 'checkpoint', 'artifact_versions', 'captures', 'capture_steps', 'run_definition']
const OBJECT_REASONS = new Set(['json_depth_limit', 'malformed_utf8', 'malformed_stream', 'unsupported_stream', 'stream_limit',
  'unclosed_stream', 'checkpoint_unavailable', 'patch_unavailable', 'gzip_unscanned', 'git_binary_unscanned',
  'unsupported_object_type', 'visual_content_unscanned', 'object_not_ready', 'byte_limit', 'object_type', 'object_size',
  'object_hash', 'object_read_failed', 'malformed_or_unread_body', 'chunk_sequence_gap', 'inventory_changed',
  'page_limit', 'object_limit', 'cursor', 'enumeration_failed', 'verification_failed', 'provenance_gap',
  'run_definition_unavailable', 'scope_unverified', 'run_not_ended', 'scope_or_inventory_changed', 'receipt_not_saved'])
const SCAN_STATES = ['incomplete', 'matched', 'no_match_in_text', 'no_match_in_complete_text', 'observed_zero']
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const reasons = value => {
  check(Array.isArray(value) && value.length <= OBJECT_REASONS.size && value.every(code => OBJECT_REASONS.has(code)))
  return [...value]
}

function objectProjection(object) {
  check(OBJECT_CATEGORIES.includes(object?.category) && UUID.test(object.id ?? '')
    && typeof object.cursor === 'string' && (UUID.test(object.cursor) || /^\d{1,20}$/.test(object.cursor))
    && (object.bytes === null || nonnegative(object.bytes)) && (object.sha256 === null || DIGEST.test(object.sha256 ?? ''))
    && typeof object.inventoryStable === 'boolean' && ['pending_verification', 'verified', 'incomplete'].includes(object.inventoryStatus)
    && SCAN_STATES.includes(object.scan?.status) && Array.isArray(object.scan.matchedGenerations)
    && object.scan.matchedGenerations.length <= 3 && object.scan.matchedGenerations.every(positive))
  const fields = {
    chunks: ['seq'], messages: ['sequence'], checkpoint: ['files', 'unavailable', 'patchPresent', 'takenAt', 'updatedAt'],
    artifact_versions: ['artifactId', 'version', 'kind', 'contentBytes', 'contentSha256', 'createdAt'],
    captures: ['kind', 'contentType', 'status', 'contentBytes', 'contentSha256', 'updatedAt'],
    capture_steps: ['captureId', 'atMs'], run_definition: [],
  }[object.category]
  const attributes = picked(object.attributes, fields)
  check(Object.keys(attributes).length === fields.length)
  for (const [key, value] of Object.entries(attributes)) {
    if (['seq', 'files', 'version', 'contentBytes', 'atMs'].includes(key)) check(value === null && key === 'contentBytes' || nonnegative(value))
    else if (key === 'sequence') check(typeof value === 'string' && /^\d{1,20}$/.test(value))
    else if (['unavailable', 'patchPresent'].includes(key)) check(typeof value === 'boolean')
    else if (['artifactId', 'captureId'].includes(key)) check(UUID.test(value ?? ''))
    else if (key === 'contentSha256') check(value === null || DIGEST.test(value ?? ''))
    else if (key === 'kind') check(['markdown', 'html', 'image', 'video', 'unknown'].includes(value))
    else if (key === 'contentType') check(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'unknown'].includes(value))
    else if (key === 'status') check(['recording', 'uploading', 'ready', 'failed', 'unknown'].includes(value))
    else check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value)
  }
  const measurement = value => {
    if (value === null || value === undefined) return null
    check(nonnegative(value.bytes) && (value.sha256 === null || DIGEST.test(value.sha256 ?? ''))
      && (value.verified === undefined || typeof value.verified === 'boolean'))
    return picked(value, ['bytes', 'sha256', 'verified'])
  }
  return { ...picked(object, ['category', 'id', 'cursor', 'bytes', 'sha256', 'inventoryStable', 'inventoryStatus']), attributes,
    content: measurement(object.content), ...(object.inflated ? { inflated: measurement(object.inflated) } : {}),
    scan: { status: object.scan.status, matchedGenerations: [...object.scan.matchedGenerations], reasons: reasons(object.scan.reasons) } }
}

/** One private metadata file per object, overwritten after inventory recheck.
 * The bounded journal keeps only a summary, never thousands of object bodies
 * or receipts. Paths are generated from this invocation's UUIDs, not payloads.
 */
export function createSecretEvidenceStore({ reportPath, sourceCommit, fixtureId, caseId, ownerId, workspaceId, botId, issueId, runId, generations },
  { writeCheckpoint = writeSecretCheckpoint } = {}) {
  check(SHA.test(sourceCommit ?? '') && [fixtureId, caseId, workspaceId, botId, issueId, runId].every(value => UUID.test(value ?? ''))
    && typeof ownerId === 'string' && ownerId.length > 0 && Array.isArray(generations) && generations.length > 0 && generations.length <= 3)
  const coveredGenerations = generations.map(entry => {
    check(positive(entry.generation) && DIGEST.test(entry.sha256 ?? '')
      && ['prepared', 'requested', 'acknowledged', 'outcome_unknown'].includes(entry.state)
      && entry.format === 'synthetic_task_secret_v1' && entry.byteLength === 75
      && Array.isArray(entry.encodings) && entry.encodings.length === 1 && entry.encodings[0] === 'utf8')
    return picked(entry, ['generation', 'sha256', 'state'])
  })
  const ownerHash = digest(ownerId).slice(0, 16), directory = `object-evidence/${caseId}`, files = new Map()
  const scope = { ownerHash, workspaceId, botId, issueId, runId }
  const context = { version: 1, kind: 'task-secret-object-evidence', sourceCommit, fixtureId, caseId, scope,
    canaries: { descriptor: { format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'] }, generations: coveredGenerations } }
  return {
    async saveObject(object) {
      const projected = objectProjection(object)
      check(projected.scan.matchedGenerations.every(generation => coveredGenerations.some(entry => entry.generation === generation)))
      const name = `${projected.category}-${projected.id}.json`, value = { ...context, object: projected }
      const encoded = JSON.stringify(value, null, 2) + '\n'
      check(Buffer.byteLength(encoded) <= 16 * 1024)
      await writeCheckpoint(join(dirname(reportPath), directory, name), value)
      files.set(name, { sha256: digest(encoded), bytes: Buffer.byteLength(encoded), inventoryStatus: projected.inventoryStatus })
    },
    async finish(result) {
      check(result?.scope?.ownerHash === digest(ownerId) && result.scope.workspaceId === workspaceId
        && result.scope.botId === botId && result.scope.issueId === issueId && result.scope.runId === runId
        && ['needs_collection', 'leak_detected'].includes(result.status)
        && JSON.stringify(result.canaries?.generations) === JSON.stringify(coveredGenerations)
        && JSON.stringify(result.serverEvidence?.coveredCategories) === JSON.stringify(OBJECT_CATEGORIES)
        && ['complete_text_scan', 'incomplete'].includes(result.serverEvidence.status)
        && Array.isArray(result.objects) && nonnegative(result.matchedObjects)
        && nonnegative(result.bytesRead) && nonnegative(result.inflatedBytes)
        && typeof result.inventoryStable === 'boolean' && Number.isFinite(Date.parse(result.finishedAt)))
      const categories = Object.fromEntries(OBJECT_CATEGORIES.map(category => {
        const value = result.categories?.[category]
        check(value && ['needs_collection', 'incomplete', 'collected', 'observed_zero'].includes(value.status)
          && SCAN_STATES.includes(value.scan) && ['observed', 'pages', 'verificationPages'].every(key => nonnegative(value[key]))
          && (value.manifestSha256 === null || DIGEST.test(value.manifestSha256 ?? '')))
        return [category, { ...picked(value, ['status', 'observed', 'pages', 'verificationPages', 'manifestSha256', 'scan']), reasons: reasons(value.reasons) }]
      }))
      const entries = [...files].sort(([a], [b]) => a.localeCompare(b))
      const metadataComplete = entries.length === result.objects.length && entries.every(([, entry]) => entry.inventoryStatus !== 'pending_verification')
      const summary = { version: 1, status: result.status, sourceCommit, fixtureId, caseId, scope,
        collectedAt: new Date(result.finishedAt).toISOString(), coveredGenerations, generationCoverage: 'all_generated_at_collection',
        serverStatus: metadataComplete ? result.serverEvidence.status : 'incomplete', coveredCategories: [...OBJECT_CATEGORIES],
        coverageGaps: ['coordinator_messages', 'coordinator_events_except_artifact_receipts', 'vm_transcript', 'visual_content'],
        fullNegativeEvidence: false, observedZeroMeans: 'no_rows_observed_not_feature_exercised', atomicSnapshot: false,
        inventoryStable: result.inventoryStable, matchedObjects: result.matchedObjects,
        bytesRead: result.bytesRead, inflatedBytes: result.inflatedBytes, categories, reasons: reasons(result.reasons),
        metadata: { directory, files: entries.length, bytes: entries.reduce((sum, [, entry]) => sum + entry.bytes, 0),
          manifestSha256: digest(JSON.stringify(entries)), complete: metadataComplete } }
      await writeCheckpoint(join(dirname(reportPath), directory, 'summary.json'), summary)
      return summary
    },
  }
}

const objectSummary = value => value ? picked(value, ['version', 'status', 'sourceCommit', 'fixtureId', 'caseId', 'scope',
  'collectedAt', 'coveredGenerations', 'generationCoverage', 'serverStatus', 'coveredCategories', 'coverageGaps',
  'fullNegativeEvidence', 'observedZeroMeans', 'atomicSnapshot', 'inventoryStable', 'matchedObjects', 'bytesRead', 'inflatedBytes',
  'categories', 'reasons', 'metadata']) : { status: 'needs_collection', reason: 'not_enumerated', fullNegativeEvidence: false }

/** A closed recovery/lookup projection, deliberately separate from tool output.
 * Seven-category receipts retain their remaining gaps; an empty list is never
 * evidence that the omitted Coordinator, VM or visual content was scanned.
 */
export function secretJournal(report) {
  return { version: 2, kind: 'task-secret-acceptance', sourceCommit: report.sourceCommit, fixtureId: report.fixtureId,
    driver: report.driver, jobStartSource: report.jobStartSource, mode: report.mode, startedAt: report.startedAt, checkpointAt: report.checkpointAt,
    ownerHash: report.ownerHash, workspaceId: report.workspaceId, originalWorkspaceId: report.originalWorkspaceId,
    budget: report.budget, resources: report.resources, canary: report.productionCanary.journal ?? null,
    cleanup: report.cleanup, recovery: report.recovery,
    objectEvidence: { status: 'needs_collection', persistedObjects: report.cases.some(item => item.objectEvidence?.metadata)
      ? 'see_bounded_case_receipts' : 'not_enumerated', runtimeObjects: 'not_enumerated',
      posthog: 'not_queried', fullNegativeEvidence: false },
    cases: report.cases.filter(item => item.caseId).map(item => ({ ...picked(item, ['caseId', 'harness', 'requestedModel',
      'phase', 'title', 'status', 'failure', 'createdAt', 'issueId', 'runId', 'botId', 'profileId', 'profileVersion', 'profileName',
      'requestTraceId', 'messageSubmittedAt', 'dispatchObservedAt', 'dispatchReturnedAt', 'runCreatedAt',
      'persistedRun', 'lastStatus', 'terminalObservedAt', 'cleanupStartedAt', 'cleanupFinishedAt', 'intents', 'cleanup', 'profileArchived']),
      sourceCommit: report.sourceCommit, workerSha: item.workerSha, workerSourceCommit: item.workerSourceCommit,
      template: item.machine?.template ?? null, nativePublicationCleanupConfirmed: item.native?.github.cleanup === true,
      syntheticGenerations: item.syntheticGenerations ?? [], objectEvidence: objectSummary(item.objectEvidence), objectCollection: 'needs_collection' })) }
}

/** Intent first, identity immediately after response, including validation
 * failures. Unknown writes remain visible and cannot authorize guessed cleanup.
 */
export async function secretMutation(record, kind, operation, capture, checkpoint, now = Date.now) {
  const intent = { id: randomUUID(), kind, state: 'requested', requestedAt: iso(now()) }
  record.intents ??= []; record.intents.push(intent); await checkpoint()
  try {
    const result = await operation(); capture(result)
    intent.state = 'responded'; intent.finishedAt = iso(now()); await checkpoint(); return result
  } catch (cause) {
    intent.state = 'outcome_unknown'; intent.finishedAt = iso(now())
    try { await checkpoint() } catch (persistenceCause) {
      intent.journalFailed = true
      throw new AggregateError([cause, persistenceCause], 'task_secrets_journal', { cause })
    }
    throw cause
  }
}

export function validateSecretJournal(value, options) {
  check(value?.version === 2 && value.kind === 'task-secret-acceptance' && value.sourceCommit === options.sourceCommit
    && SHA.test(value.sourceCommit) && UUID.test(value.fixtureId ?? '')
    && positive(value.driver?.runId) && positive(value.driver?.runAttempt)
    && value.driver.runId === options.driver?.runId && value.driver.runAttempt === options.driver?.runAttempt
    && positive(value.driver.jobId) && value.driver.jobId === options.driver?.jobId
    && value.jobStartSource === 'github_actions_job.started_at' && value.jobStartSource === options.jobStartSource
    && ['production_canary', 'execute', 'preflight'].includes(value.mode)
    && Number.isFinite(Date.parse(value.startedAt)) && Array.isArray(value.cases) && value.cases.length <= 4
    && value.budget?.jobStartedAt === options.jobStartedAt
    && !/mikka1712s_[a-f0-9]{64}/.test(JSON.stringify(value)))
  if (value.ownerHash) check(/^[a-f0-9]{16}$/.test(value.ownerHash))
  if (value.workspaceId) check(UUID.test(value.workspaceId))
  const ids = new Set(), runs = new Set()
  for (const item of value.cases) {
    check(UUID.test(item.caseId ?? '') && !ids.has(item.caseId) && ['claude_code', 'codex'].includes(item.harness)
      && item.sourceCommit === options.sourceCommit && item.title === `测试 1712 ${item.caseId} ${item.harness}`
      && ['issueId', 'runId', 'botId', 'profileId'].every(key => !item[key] || UUID.test(item[key]))
      && (!item.botId || item.botId === value.resources?.botId)
      && (!item.phase || ['revocation', 'fresh_claim'].includes(item.phase))
      && (!item.profileId || positive(item.profileVersion) && item.profileName === `测试1712 ${item.caseId} ${item.harness}`)
      && (!item.runId || item.issueId && !runs.has(item.runId))
      && (!item.requestTraceId || /^[a-f0-9]{32}$/.test(item.requestTraceId)))
    ids.add(item.caseId); if (item.runId) runs.add(item.runId)
  }
  const resources = value.resources ?? {}
  if (resources.botId) check(UUID.test(resources.botId) && resources.botName === `测试1712 ${value.fixtureId.slice(0, 8)}`)
  if (resources.fixture) {
    const fixture = resources.fixture
    check(!fixture.sandboxId || /^[A-Za-z0-9_-]{1,128}$/.test(fixture.sandboxId))
    check(fixture.metadata?.application === 'mikka-1712-secret-fixture' && fixture.metadata.acceptance === value.fixtureId
      && fixture.metadata.sourceCommit === value.sourceCommit && fixture.metadata.driverRunId === String(value.driver.runId)
      && fixture.metadata.driverRunAttempt === String(value.driver.runAttempt))
  }
  if (value.canary) {
    const canary = value.canary
    check(value.mode === 'production_canary' && canary.fixtureId === value.fixtureId && canary.sourceCommit === value.sourceCommit
      && canary.ownerHash === value.ownerHash && canary.name === `ACCEPTANCE_1712_${value.fixtureId.replaceAll('-', '').toUpperCase()}`
      && (!canary.id || UUID.test(canary.id)) && Array.isArray(canary.generations) && canary.generations.length <= 3
      && Array.isArray(canary.cases) && canary.cases.length <= 4
      && canary.generations.every((item, index) => item.generation === index + 1 && DIGEST.test(item.sha256 ?? '')
        && ['prepared', 'requested', 'acknowledged', 'outcome_unknown'].includes(item.state))
      && /^https:\/\/github\.com\/alexj11324\/Mikka\/(?:issues|pull)\/1752#issuecomment-[0-9]+$/.test(canary.window?.comment ?? '')
      && Number.isFinite(Date.parse(canary.window?.expiresAt))
      && Date.parse(canary.window.expiresAt) <= Date.parse(value.startedAt) + 45 * 60_000)
  }
  return value
}

export async function readSecretJournal(options) {
  const path = resolve(dirname(options.reportPath), 'canary-journal.json')
  let info
  try { info = await lstat(path) } catch (cause) { if (cause?.code === 'ENOENT') return null; throw cause }
  const folder = await lstat(dirname(path))
  check(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024 && (info.mode & 0o077) === 0
    && folder.isDirectory() && !folder.isSymbolicLink() && (folder.mode & 0o077) === 0)
  return validateSecretJournal(JSON.parse(await readFile(path, 'utf8')), options)
}
