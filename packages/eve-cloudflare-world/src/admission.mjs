import {
  CreateEventSchema, EventSchema, HookSchema, WorkflowRunSchema, eventIdToSlot,
  DEFAULT_TIMESTAMP_THRESHOLD_FUTURE_MS, isStepEventType, isTerminalWorkflowRunStatus, slotToEventId,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM, ulidToDate, workflowRunIdSchema,
} from '@workflow/world'
import { applyAttributeChanges, validateAttributeChanges } from '@workflow/world/attributes-validation'
import { START_HOOK_CANDIDATE_MAX_AGE_MS, startHookId } from '@workflow/world/start-hook.js'
import { initializeCatalog } from './catalog.mjs'
import { changeStep, changeWait, initializeExecution } from './execution.mjs'
import { decodeRecord, encodeRecord, fail, first } from './records.mjs'

const MAX_RETENTION_MS = 30 * 86_400_000

export function initializeWorldStorage(storage) {
  initializeExecution(storage)
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS world_runs (
    run_id TEXT PRIMARY KEY, status TEXT NOT NULL, record BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS world_events (
    run_id TEXT NOT NULL, slot INTEGER NOT NULL, record BLOB NOT NULL, PRIMARY KEY(run_id,slot)
  );
  CREATE TABLE IF NOT EXISTS world_hooks (
    token TEXT PRIMARY KEY, hook_id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL, retain_until INTEGER, record BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS world_hooks_run ON world_hooks(run_id);
  CREATE TABLE IF NOT EXISTS world_start_admissions (
    run_id TEXT PRIMARY KEY, token TEXT NOT NULL, conflicting_run TEXT, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS world_start_decision_age ON world_start_admissions(recorded_at)`)
  initializeCatalog(storage)
  const eventColumns = storage.sql.exec('PRAGMA table_info(world_events)').toArray().map(row => row.name)
  if (!eventColumns.includes('correlation_id')) {
    storage.sql.exec('ALTER TABLE world_events ADD COLUMN correlation_id TEXT')
    storage.sql.exec('ALTER TABLE world_events ADD COLUMN indexed_event INTEGER NOT NULL DEFAULT 0')
  }
  storage.sql.exec(`CREATE INDEX IF NOT EXISTS world_events_correlation ON world_events(run_id,correlation_id,slot);
    CREATE INDEX IF NOT EXISTS world_events_uncatalogued ON world_events(run_id,indexed_event);
    CREATE TABLE IF NOT EXISTS world_attribute_writes (run_id TEXT NOT NULL, correlation TEXT NOT NULL, PRIMARY KEY(run_id,correlation));
    CREATE TABLE IF NOT EXISTS world_hook_resumes (
      run_id TEXT NOT NULL, resume_id TEXT NOT NULL, hook_id TEXT NOT NULL, digest TEXT, slot INTEGER NOT NULL,
      PRIMARY KEY(run_id,resume_id)
    )`)
}


export function readRun(storage, runId) {
  const row = first(storage.sql.exec('SELECT record FROM world_runs WHERE run_id=?', runId))
  return row ? decodeRecord(row.record) : null
}

function readHook(storage, column, value, now) {
  const row = first(storage.sql.exec(`SELECT h.record FROM world_hooks h JOIN world_runs r ON r.run_id=h.run_id
    WHERE h.${column}=? AND (r.status NOT IN ('completed','failed','cancelled') OR h.retain_until>?)`, value, now))
  return row ? decodeRecord(row.record) : null
}

export const readHookByToken = (storage, token, now = Date.now()) => readHook(storage, 'token', token, now)
export const readHookById = (storage, hookId, now = Date.now()) => readHook(storage, 'hook_id', hookId, now)

export function readEvent(storage, runId, slot) {
  const row = first(storage.sql.exec('SELECT record FROM world_events WHERE run_id=? AND slot=?', runId, slot))
  return row ? decodeRecord(row.record) : null
}

export function listEvents(storage, runId, { limit = 20, sortOrder = 'asc', cursor } = {}, correlationId) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid event page size')
  const ascending = sortOrder === 'asc'
  const slot = cursor == null ? (ascending ? 0 : Number.MAX_SAFE_INTEGER) : eventIdToSlot(cursor)
  if (slot === null) throw new RangeError('Invalid event cursor')
  let filter = ''
  const args = [runId, slot]
  if (correlationId !== undefined) {
    // A rollback can add pre-index events. Read and index those rows
    // once before applying a correlation filter to this run.
    for (;;) {
      const old = storage.sql.exec('SELECT slot,record FROM world_events WHERE run_id=? AND indexed_event=0 LIMIT 100', runId).toArray()
      if (!old.length) break
      for (const row of old) storage.sql.exec('UPDATE world_events SET correlation_id=?,indexed_event=1 WHERE run_id=? AND slot=?',
        decodeRecord(row.record).correlationId ?? null, runId, row.slot)
    }
    filter = ' AND correlation_id=?'
    args.push(correlationId)
  }
  const rows = storage.sql.exec(`SELECT slot,record FROM world_events WHERE run_id=? AND slot ${ascending ? '>' : '<'} ?${filter}
    ORDER BY slot ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, ...args, limit + 1).toArray()
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  return { data: page.map(row => decodeRecord(row.record)), hasMore, cursor: hasMore ? slotToEventId(page.at(-1).slot) : null }
}

function appendEvent(storage, runId, request, now) {
  const { slot } = first(storage.sql.exec('SELECT COALESCE(MAX(slot),0)+1 AS slot FROM world_events WHERE run_id=?', runId))
  const event = EventSchema.parse({ ...request, runId, eventId: slotToEventId(slot), createdAt: new Date(now) })
  storage.sql.exec('INSERT INTO world_events(run_id,slot,record,correlation_id,indexed_event) VALUES(?,?,?,?,1)',
    runId, slot, encodeRecord(event), event.correlationId ?? null)
  return event
}

function saveRun(storage, values) {
  const run = WorkflowRunSchema.parse(values)
  storage.sql.exec(`INSERT INTO world_runs(run_id,status,record,created_ms,workflow_name) VALUES(?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,record=excluded.record,created_ms=excluded.created_ms,workflow_name=excluded.workflow_name`,
    run.runId, run.status, encodeRecord(run), run.createdAt.getTime(), run.workflowName)
  return run
}

function cleanReleasedToken(storage, token, now) {
  storage.sql.exec(`DELETE FROM world_hooks WHERE token=? AND (retain_until IS NULL OR retain_until<=?)
    AND EXISTS (SELECT 1 FROM world_runs r WHERE r.run_id=world_hooks.run_id AND r.status IN ('completed','failed','cancelled'))`, token, now)
}

function saveHook(storage, runId, hookId, fields, specVersion, now) {
  const hook = HookSchema.parse({ ...fields, hookId, runId, specVersion, createdAt: new Date(now),
    ownerId: '', projectId: '', environment: '', isWebhook: fields.isWebhook ?? false, isSystem: fields.isSystem ?? false })
  storage.sql.exec('INSERT INTO world_hooks(token,hook_id,run_id,retain_until,record,created_ms) VALUES(?,?,?,?,?,?)',
    hook.token, hookId, runId, fields.tokenRetentionUntil?.getTime() ?? null, encodeRecord(hook), hook.createdAt.getTime())
  return hook
}

function startRun(storage, runId, request, now) {
  const fields = request.eventData
  const hook = fields?.startHook
  const minted = ulidToDate(runId.slice('wrun_'.length))?.getTime()
  if (minted === undefined || minted > now + DEFAULT_TIMESTAMP_THRESHOLD_FUTURE_MS) return fail(400, 'INVALID_RUN_ID')
  const expired = now - minted > START_HOOK_CANDIDATE_MAX_AGE_MS
  if (hook && (hook.tokenRetentionUntil?.getTime() > now + MAX_RETENTION_MS || (request.eventType === 'run_created' && expired))) {
    return fail(400, 'START_HOOK_ADMISSION_REJECTED', { reason: expired ? 'expired' : 'invalid' })
  }
  const prior = first(storage.sql.exec('SELECT token,conflicting_run FROM world_start_admissions WHERE run_id=?', runId))
  if (prior && hook) {
    if (prior.token !== hook.token) return fail(400, 'START_HOOK_ADMISSION_REJECTED', { reason: 'token_mismatch' })
    if (prior.conflicting_run) return fail(409, 'HOOK_CONFLICT', { conflictingRunId: prior.conflicting_run, token: hook.token })
  }
  let run = readRun(storage, runId)
  let event = null
  if (run && request.eventType === 'run_created' && !(hook && prior)) return fail(409, 'ENTITY_CONFLICT')
  if (!run) {
    if (!fields?.workflowName || !fields.deploymentId || !Object.hasOwn(fields, 'input')) return fail(404, 'RUN_NOT_FOUND')
    if (hook && expired) return fail(400, 'START_HOOK_ADMISSION_REJECTED', { reason: 'expired' })
    let receipt
    if (hook) {
      const sql = storage.sql
      sql.exec(`DELETE FROM world_start_admissions WHERE run_id IN (SELECT run_id FROM world_start_admissions
        WHERE recorded_at<? ORDER BY recorded_at LIMIT 100)`, now - START_HOOK_CANDIDATE_MAX_AGE_MS - 3_600_000)
      cleanReleasedToken(storage, hook.token, now)
      const owner = readHookByToken(storage, hook.token, now)
      sql.exec('INSERT INTO world_start_admissions(run_id,token,conflicting_run,recorded_at) VALUES(?,?,?,?)',
        runId, hook.token, owner?.runId ?? null, now)
      // The refusal is a result, so its transaction commits before the client throws.
      if (owner) return fail(409, 'HOOK_CONFLICT', { token: hook.token, conflictingRunId: owner.runId })
      const hookId = startHookId(runId)
      saveHook(storage, runId, hookId, hook, request.specVersion, now)
      receipt = { token: hook.token, hookId, ...(hook.tokenRetentionUntil ? { tokenRetentionUntil: hook.tokenRetentionUntil } : {}) }
    }
    const createdAt = new Date(now)
    run = saveRun(storage, { ...fields, runId, status: 'pending', startHook: receipt, specVersion: request.specVersion, createdAt, updatedAt: createdAt })
    event = appendEvent(storage, runId, { ...request, eventType: 'run_created', eventData: {
      ...fields, ...(receipt ? { startHook: { ...hook, ...receipt } } : {}),
    } }, now)
  }
  if (request.eventType === 'run_started' && run.status === 'pending') {
    const startedAt = new Date(now)
    run = saveRun(storage, { ...run, status: 'running', startedAt, updatedAt: startedAt })
    event = appendEvent(storage, runId, { eventType: 'run_started', specVersion: request.specVersion }, now)
  } else if (request.eventType === 'run_started' && isTerminalWorkflowRunStatus(run.status)) {
    return fail(410, 'RUN_EXPIRED')
  }
  if (!event && request.eventType === 'run_created') event = readEvent(storage, runId, 1)
  return { ok: true, run, ...(event ? { event } : {}), replayed: Boolean(prior) }
}

function changeHook(storage, runId, request, now, params) {
  const { eventType, eventData, correlationId: hookId, specVersion } = request
  if (eventType === 'hook_created') {
    if (hookId === startHookId(runId) || eventData.tokenRetentionUntil?.getTime() > now + MAX_RETENTION_MS) return fail(400, 'INVALID_HOOK')
    const prior = readHookById(storage, hookId, now)
    if (prior) return fail(409, 'ENTITY_CONFLICT')
    const { token } = eventData
    cleanReleasedToken(storage, token, now)
    const owner = readHookByToken(storage, token, now)
    if (owner) {
      const victim = eventData.force ? readRun(storage, owner.runId) : undefined
      const compatible = victim && victim.specVersion >= SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
      if (!compatible) {
        const conflict = { token, conflictingRunId: owner.runId, ...(eventData.force ? { forceDeclined: 'victim-spec-version' } : {}) }
        return { ok: true, event: appendEvent(storage, runId, { eventType: 'hook_conflict', correlationId: hookId, specVersion, eventData: conflict }, now) }
      }
      storage.sql.exec('DELETE FROM world_hooks WHERE hook_id=?', owner.hookId)
      appendEvent(storage, owner.runId, { eventType: 'hook_disposed', correlationId: owner.hookId, specVersion: victim.specVersion,
        eventData: { token, forceClaimedBy: { runId, hookId } } }, now)
    }
    const hook = saveHook(storage, runId, hookId, eventData, specVersion, now)
    return { ok: true, hook, event: appendEvent(storage, runId, request, now) }
  }
  const hook = readHookById(storage, hookId, now)
  if (!hook || hook.runId !== runId || (eventData?.token && eventData.token !== hook.token)) return fail(404, 'HOOK_NOT_FOUND')
  if (eventType === 'hook_received' && params?.resumeId) {
    const event = appendEvent(storage, runId, { ...request, resumeId: params.resumeId }, now)
    storage.sql.exec('INSERT INTO world_hook_resumes(run_id,resume_id,hook_id,digest,slot) VALUES(?,?,?,?,?)',
      runId, params.resumeId, hookId, params.resumePayloadDigest ?? null, eventIdToSlot(event.eventId))
    return { ok: true, event, hook }
  }
  if (eventType === 'hook_disposed') storage.sql.exec('DELETE FROM world_hooks WHERE hook_id=?', hookId)
  return { ok: true, hook, event: appendEvent(storage, runId, request, now) }
}

const terminal = { run_completed: 'completed', run_failed: 'failed', run_cancelled: 'cancelled' }

/** One transaction owns the admission, token, run and event slots of a World
 * namespace, including both logs when a forced claim moves a token. */
export function applyWorldEvent(storage, runId, request, now = Date.now(), params) {
  if (!workflowRunIdSchema.safeParse(runId).success) return fail(400, 'INVALID_RUN_ID')
  const parsed = CreateEventSchema.safeParse(request)
  if (!parsed.success) return request?.eventData?.startHook
    ? fail(400, 'START_HOOK_ADMISSION_REJECTED', { reason: 'invalid' }) : fail(400, 'INVALID_EVENT')
  const event = parsed.data
  return storage.transactionSync(() => {
    if (event.eventType === 'run_created' || event.eventType === 'run_started') return startRun(storage, runId, event, now)
    if (['hook_created', 'hook_disposed', 'hook_received'].includes(event.eventType)) {
      const run = first(storage.sql.exec('SELECT status FROM world_runs WHERE run_id=?', runId))
      if (!run) return fail(404, 'RUN_NOT_FOUND')
      if (event.eventType === 'hook_received' && params?.resumeId) {
        const prior = first(storage.sql.exec('SELECT hook_id,digest,slot FROM world_hook_resumes WHERE run_id=? AND resume_id=?', runId, params.resumeId))
        if (prior) {
          if (prior.hook_id !== event.correlationId || (prior.digest && params.resumePayloadDigest && prior.digest !== params.resumePayloadDigest)) {
            return fail(409, 'ENTITY_CONFLICT')
          }
          return { ok: true, event: readEvent(storage, runId, prior.slot) }
        }
      }
      if (isTerminalWorkflowRunStatus(run.status)) return fail(410, 'RUN_EXPIRED')
      return changeHook(storage, runId, event, now, params)
    }
    const run = readRun(storage, runId)
    if (!run) return fail(404, 'RUN_NOT_FOUND')
    if (isStepEventType(event.eventType)) return changeStep(storage, run, event, now, appendEvent)
    if (event.eventType === 'wait_created' || event.eventType === 'wait_completed') return changeWait(storage, run, event, now, appendEvent)
    if (isTerminalWorkflowRunStatus(run.status)) return fail(410, 'RUN_EXPIRED')
    if (event.eventType === 'attr_set') {
      try {
        validateAttributeChanges(event.eventData.changes, { existingKeys: Object.keys(run.attributes ?? {}),
          allowReservedAttributes: event.eventData.allowReservedAttributes === true })
      } catch { return fail(400, 'INVALID_ATTRIBUTES') }
      if (event.correlationId) {
        const claimed = storage.sql.exec('INSERT OR IGNORE INTO world_attribute_writes(run_id,correlation) VALUES(?,?)', runId, event.correlationId)
        if (!claimed.rowsWritten) return fail(409, 'ENTITY_CONFLICT')
      }
      const attributes = applyAttributeChanges(run.attributes, event.eventData.changes)
      const updated = saveRun(storage, { ...run, attributes, updatedAt: new Date(now) })
      return { ok: true, run: updated, event: appendEvent(storage, runId, event, now) }
    }
    if (!Object.hasOwn(terminal, event.eventType)) return fail(501, 'UNSUPPORTED_EVENT')
    storage.sql.exec('DELETE FROM world_waits WHERE run_id=?', runId)
    const completedAt = new Date(now)
    const updated = saveRun(storage, { ...run, ...event.eventData, status: terminal[event.eventType], updatedAt: completedAt, completedAt })
    storage.sql.exec('DELETE FROM world_hooks WHERE run_id=? AND (retain_until IS NULL OR retain_until<=?)', runId, now)
    return { ok: true, run: updated, event: appendEvent(storage, runId, event, now) }
  })
}
