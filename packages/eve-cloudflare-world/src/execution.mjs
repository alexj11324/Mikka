import { isChildEntityCreationEvent, isTerminalStepStatus, isTerminalWorkflowRunStatus, SPEC_VERSION_SINGLE_ORCHESTRATOR, StepSchema, WaitSchema } from '@workflow/world'
import { decodeRecord, encodeRecord, fail, first } from './records.mjs'

export function initializeExecution(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS world_steps (
    run_id TEXT NOT NULL, step_id TEXT NOT NULL, created INTEGER NOT NULL, record BLOB NOT NULL,
    PRIMARY KEY(run_id, step_id)
  );
  CREATE INDEX IF NOT EXISTS world_steps_created ON world_steps(run_id,created,step_id);
  CREATE TABLE IF NOT EXISTS world_waits (
    run_id TEXT NOT NULL, wait_id TEXT NOT NULL, record BLOB NOT NULL, PRIMARY KEY(run_id,wait_id)
  )`)
}

export function readStep(storage, runId, stepId) {
  const row = first(storage.sql.exec('SELECT record FROM world_steps WHERE run_id=? AND step_id=?', runId, stepId))
  return row ? decodeRecord(row.record) : null
}

export function listSteps(storage, runId, { limit = 20, sortOrder = 'desc', cursor } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !['asc', 'desc'].includes(sortOrder)) throw new RangeError('Invalid step page')
  let where = 'run_id=?'
  const args = [runId]
  if (cursor != null) {
    const marker = first(storage.sql.exec('SELECT created FROM world_steps WHERE run_id=? AND step_id=?', runId, cursor))
    if (!marker) throw new RangeError('Invalid step cursor')
    where += sortOrder === 'asc' ? ' AND (created,step_id)>(?,?)' : ' AND (created,step_id)<(?,?)'
    args.push(marker.created, cursor)
  }
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC'
  const rows = storage.sql.exec(`SELECT step_id,record FROM world_steps WHERE ${where}
    ORDER BY created ${order},step_id ${order} LIMIT ?`, ...args, limit + 1).toArray()
  const data = rows.slice(0, limit).map(row => decodeRecord(row.record))
  const hasMore = rows.length > limit
  return { data, hasMore, cursor: hasMore ? data.at(-1).stepId : null }
}

function saveStep(storage, data) {
  const step = StepSchema.parse(data)
  storage.sql.exec(`INSERT INTO world_steps(run_id,step_id,created,record) VALUES(?,?,?,?)
    ON CONFLICT(run_id,step_id) DO UPDATE SET record=excluded.record`,
    step.runId, step.stepId, step.createdAt.getTime(), encodeRecord(step))
  return step
}

export function changeStep(storage, run, request, now, append) {
  const { eventType, correlationId: stepId, specVersion } = request
  const fields = request.eventData ?? {}
  const { runId } = run
  const time = new Date(now)
  const creating = isChildEntityCreationEvent(request)
  const lazy = creating && eventType === 'step_started'
  let step = readStep(storage, runId, stepId)
  if (creating && step) return fail(409, 'ENTITY_CONFLICT')
  if (!creating && !step) return fail(404, 'STEP_NOT_FOUND')
  if (isTerminalWorkflowRunStatus(run.status)) {
    if (creating) return fail(409, 'ENTITY_CONFLICT')
    if (step.status !== 'running' || eventType === 'step_started') return fail(410, 'RUN_EXPIRED')
  }
  if (step && isTerminalStepStatus(step.status)) return fail(409, 'ENTITY_CONFLICT')
  if (creating) {
    step = { runId, stepId, stepName: fields.stepName, input: fields.input, status: 'pending',
      attempt: 0, createdAt: time, updatedAt: time, specVersion: specVersion ?? run.specVersion }
    if (lazy && run.specVersion < SPEC_VERSION_SINGLE_ORCHESTRATOR) {
      // Spec 8 replays the input from the synthetic create, followed by start.
      // The two event slots and materialized owner commit in one transaction.
      append(storage, runId, { eventType: 'step_created', correlationId: stepId, specVersion,
        eventData: { input: fields.input, stepName: fields.stepName } }, now)
      const { input, ...withoutInput } = fields
      request = { ...request, eventData: withoutInput }
    }
  }
  switch (eventType) {
    case 'step_created': break
    case 'step_started':
      if (step.retryAfter?.getTime() > now) return fail(425, 'TOO_EARLY', { retryAfter: Math.ceil((step.retryAfter.getTime() - now) / 1000) })
      step = { ...step, status: 'running', startedAt: step.startedAt ?? time, attempt: step.attempt + 1, retryAfter: undefined }
      break
    case 'step_retrying':
      step = { ...step, status: 'pending', error: fields.error, retryAfter: fields.retryAfter }
      break
    case 'step_completed':
      step = { ...step, status: 'completed', output: fields.result, completedAt: time }
      break
    case 'step_failed':
      step = { ...step, status: 'failed', error: fields.error, completedAt: time }
      break
    default: return fail(400, 'INVALID_EVENT')
  }
  return { ok: true, step: saveStep(storage, { ...step, updatedAt: time }), event: append(storage, runId, request, now),
    ...(lazy ? { stepCreated: true } : {}) }
}

export function changeWait(storage, run, request, now, append) {
  const { eventType, correlationId: waitId } = request
  const { runId } = run
  const time = new Date(now)
  const existing = first(storage.sql.exec('SELECT record FROM world_waits WHERE run_id=? AND wait_id=?', runId, waitId))
  let wait
  if (eventType === 'wait_created') {
    if (existing || isTerminalWorkflowRunStatus(run.status)) return fail(409, 'ENTITY_CONFLICT')
    wait = { waitId: runId + '-' + waitId, runId, status: 'waiting', resumeAt: request.eventData.resumeAt,
      createdAt: time, updatedAt: time, specVersion: request.specVersion ?? run.specVersion }
  } else {
    if (!existing) return fail(404, 'WAIT_NOT_FOUND')
    wait = decodeRecord(existing.record)
    if (wait.status === 'completed') return fail(409, 'ENTITY_CONFLICT')
    wait = { ...wait, status: 'completed', completedAt: time, updatedAt: time }
  }
  wait = WaitSchema.parse(wait)
  storage.sql.exec(`INSERT INTO world_waits(run_id,wait_id,record) VALUES(?,?,?)
    ON CONFLICT(run_id,wait_id) DO UPDATE SET record=excluded.record`, runId, waitId, encodeRecord(wait))
  return { ok: true, wait, event: append(storage, runId, request, now) }
}
