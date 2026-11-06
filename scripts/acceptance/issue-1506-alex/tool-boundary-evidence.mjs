// Offline classification of root-collected content-free production metadata.
// Never queries production and never substitutes timing estimates for body logs.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { validateFixtureReceipt } from './coordinator-fixtures.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const REF = /^[0-9a-f]{12}$/
const RUN = /^wrun_[A-Za-z0-9_-]{1,160}$/
const ownerRef = createHash('sha256').update(ALEX_OWNER_ID).digest('hex').slice(0, 12)
const time = value => Number.isSafeInteger(value) && value >= 0
const fail = code => { throw new Error(code) }

export function classifyToolBoundary(observation, evidence, fixtureReceipt) {
  const fixtures = validateFixtureReceipt(fixtureReceipt, { ready: true })
  const fixture = fixtures.fixtures.find(row => row.key === observation?.fixture?.key)
  const scope = evidence?.scope
  if (!fixture || observation.fixture.botId !== fixture.botId || observation.fixture.runKey !== fixtures.runKey ||
    !SHA.test(observation.applicationSha ?? '') || !RUN.test(observation.workflowRunId ?? '') ||
    !new RegExp('^' + observation.workflowRunId + ':\\d+$').test(observation.streamId ?? '') ||
    !REF.test(observation.triggerCallRef ?? '') || !['observe', 'before_tool', 'during_tool'].includes(observation.requestedCase) ||
    !['observed', 'failed'].includes(observation.status) ||
    evidence?.schemaVersion !== 1 || scope?.ownerRef !== ownerRef || scope.workspaceId !== fixtures.workspace.id ||
    scope.botId !== fixture.botId || scope.applicationSha !== observation.applicationSha ||
    scope.workflowRunId !== observation.workflowRunId || scope.streamId !== observation.streamId) fail('boundary_scope_mismatch')
  const execution = evidence.execution
  if (!UUID.test(execution?.id ?? '') || execution.executionKey !== observation.streamId ||
    !['running', 'completed', 'failed'].includes(execution.status) || execution.webSearchAllowed !== true ||
    !time(evidence.auditReadAt) || !Array.isArray(evidence.audit) || evidence.audit.length > 100 ||
    !Array.isArray(evidence.toolTimings) || evidence.toolTimings.length > 10 ||
    !Array.isArray(evidence.stopTimings) || evidence.stopTimings.length > 10) fail('boundary_evidence_invalid')
  const report = { schemaVersion: 1, issue: 1506, acceptanceIssue: 1490, phase: 'tool-boundary-classification',
    status: 'not_covered', sampleCount: 1, ...(UUID.test(observation.sampleId ?? '') ? { sampleId: observation.sampleId } : {}), requestedCase: observation.requestedCase,
    applicationSha: observation.applicationSha, workflowRunId: observation.workflowRunId, streamId: observation.streamId,
    botId: fixture.botId, executionId: execution.id, callRef: observation.triggerCallRef,
    classification: 'unverified', requestedBoundaryMatched: false, clientObservationStatus: observation.status,
    overallAcceptance: 'requires_final_side_effect_and_provider_review' }
  const uncovered = reason => ({ ...report, reason })
  if (execution.status !== 'completed' || !time(execution.finishedAt) || evidence.auditReadAt < execution.finishedAt)
    return uncovered('execution_not_final')
  for (const row of evidence.audit) if (!['tool_started', 'tool_finished'].includes(row.kind) ||
    !REF.test(row.callRef ?? '') || row.tool !== 'web_search' || !time(row.at) || row.at > evidence.auditReadAt ||
    row.kind === 'tool_finished' && !['ok', 'error', 'stopped', 'approval_pending'].includes(row.outcome)) fail('boundary_evidence_invalid')
  const audit = evidence.audit.filter(row => row.callRef === report.callRef)
  if (audit.length !== evidence.audit.length) return uncovered('additional_tool_calls')
  const starts = audit.filter(row => row.kind === 'tool_started'), finishes = audit.filter(row => row.kind === 'tool_finished')
  if (starts.length !== 1 || finishes.length !== 1) return uncovered('exact_immutable_audit_pair_missing')
  if (finishes[0].at < starts[0].at) fail('boundary_evidence_invalid')
  report.auditOutcome = finishes[0].outcome
  report.audit = { startedAt: starts[0].at, finishedAt: finishes[0].at, readAt: evidence.auditReadAt }
  const stops = evidence.stopTimings
  for (const row of stops) if (row.msg !== 'coordinator_stop_timing' || row.workflowRunId !== report.workflowRunId ||
    row.outcome !== 'accepted' || !time(row.requestedAt) || !time(row.acknowledgedAt) ||
    row.requestedAt > row.acknowledgedAt || row.acknowledgedAt > evidence.auditReadAt) fail('boundary_evidence_invalid')
  if (stops.length !== 1) return uncovered('single_server_stop_interval_missing')
  report.stop = { requestedAt: stops[0].requestedAt, acknowledgedAt: stops[0].acknowledgedAt }
  const bodies = evidence.toolTimings
  for (const row of bodies) if (row.msg !== 'coordinator_tool_timing' || row.workflowRunId !== report.workflowRunId ||
    row.callRef !== report.callRef || row.tool !== 'web_search' || !/^step_[A-Za-z0-9_-]{1,160}$/.test(row.stepId ?? '') ||
    !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !time(row.startedAt) || !time(row.endedAt) || row.startedAt > row.endedAt ||
    !['ok', 'unavailable', 'threw'].includes(row.outcome)) fail('boundary_evidence_invalid')
  if (finishes[0].outcome === 'stopped') {
    if (bodies.length) fail('boundary_evidence_conflict')
    report.classification = 'before_tool'
    report.proof = 'immutable_post_audit_stopped_outcome_skipped_body'
  } else {
    if (bodies.length !== 1 || bodies[0].attempt !== 1) return uncovered('single_body_attempt_missing')
    const body = bodies[0]
    if (body.endedAt > evidence.auditReadAt) return uncovered('audit_precedes_tool_terminal')
    if ((body.outcome === 'ok' ? 'ok' : 'error') !== finishes[0].outcome) fail('boundary_evidence_conflict')
    report.body = { stepId: body.stepId, attempt: body.attempt, startedAt: body.startedAt, endedAt: body.endedAt, outcome: body.outcome }
    if (body.startedAt < report.stop.requestedAt && report.stop.acknowledgedAt < body.endedAt) {
      report.classification = 'during_tool'; report.proof = 'entire_server_stop_interval_strictly_inside_real_body_interval'
    } else if (body.endedAt <= report.stop.requestedAt) {
      report.classification = 'after_tool'; return uncovered('stop_after_tool_finished')
    } else if (report.stop.acknowledgedAt <= body.startedAt) {
      report.classification = 'before_body_interval'; return uncovered('body_began_after_stop_delivery_requires_review')
    } else return uncovered('interval_boundary_ambiguous')
  }
  if (observation.status !== 'observed' || observation.stop?.acknowledged !== true || observation.termination !== 'eof')
    return uncovered('client_stop_observation_failed')
  if (observation.sample?.attempts !== 1 || observation.sample.countedEvenIfBoundaryMissed !== true ||
    observation.sample.plannedDelayMs !== (observation.requestedCase === 'during_tool' ? 600 : 0))
    return uncovered('sampling_plan_missing')
  if (observation.sample?.delayCancelledByFailure) return uncovered('planned_sample_interrupted')
  report.requestedBoundaryMatched = observation.requestedCase === 'observe' || observation.requestedCase === report.classification
  if (!report.requestedBoundaryMatched) return uncovered('observed_other_boundary')
  report.status = 'covered'; return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [observation, evidence, fixture] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')))
    console.log(JSON.stringify(classifyToolBoundary(observation, evidence, fixture)))
  } catch (error) {
    const codes = ['boundary_scope_mismatch', 'boundary_evidence_invalid', 'boundary_evidence_conflict', 'fixture_receipt_invalid']
    console.log(JSON.stringify({ issue: 1506, phase: 'tool-boundary-classification', status: 'rejected',
      error: codes.includes(error?.message) ? error.message : 'boundary_input_invalid' })); process.exitCode = 1
  }
}
