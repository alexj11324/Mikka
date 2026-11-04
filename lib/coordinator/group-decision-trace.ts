import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { DecisionExecution } from './decide'
import type { GroupRoute, RoutingMember } from './group-routing'
import { getGroupDecisionPolicy, GROUP_POLICY_VERSIONS, type GroupPolicyVersion } from './group-decision-policy'
import { DECISION_MODEL } from './decision'
import { GROUP_DECISION_PROTOCOL, GROUP_MAX_ROUTING_DECISIONS, GROUP_RETAINED_DECISIONS, groupDecisionFailures, groupDecisionPhases, groupDecisionTotals, type GroupDecisionFailure, type GroupDecisionStep } from './group-decision-chain'

type Client = Pick<PoolClient, 'query'>
type TraceMember = RoutingMember & { capabilities?: unknown; executionAvailable?: boolean }
export type GroupTraceEvent = {
  id: string
  type: 'wake' | 'generate' | 'silent' | 'publish' | 'private_publish' | 'delegate' | 'task_result'
  memberId?: string
  taskId?: string
  runId?: string
  outcome?: 'started' | 'succeeded' | 'blocked' | 'failed' | 'stopped'
  contentDigest?: string
}
export type GroupDecisionTrace = {
  schemaVersion: 1
  policyVersion: string
  contextMessageIds: string[]
  memberVersion: string
  members: { id: string; memberType: string; roleDigest: string; capabilityDigest: string; executionAvailable: boolean }[]
  purpose: 'group-routing' | 'explicit-mention'
  action: string | null
  reason: string | null
  responders: string[]
  execution: DecisionExecution | null
  /** Compatibility execution is the first request of the current routing
   * attempt. Retained decisions also include failed earlier routing attempts;
   * correction, contribution and generation calls are outside this scope. */
  executionPhase?: GroupDecisionStep['phase'] | null
  decisionProtocol?: typeof GROUP_DECISION_PROTOCOL
  decisions?: GroupDecisionStep[]
  decisionsOmitted?: number
  decisionFailure?: GroupDecisionFailure | null
  decisionLatencyMs: number | null
  startedAt: string
  finishedAt: string | null
  /** The task's confirmed result, separate from the short group intake turn. */
  taskFinishedAt?: string | null
  events: GroupTraceEvent[]
  status: 'pending' | 'complete' | 'blocked' | 'failed' | 'stopped'
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : undefined

/** An allowlist prevents provider objects, role text and credentials from being
 * copied into diagnostics even when an adapter accidentally adds extra fields. */
export function groupDecisionReceipt(receipt: DecisionExecution | undefined): DecisionExecution | null {
  if (!receipt || receipt.modelId !== DECISION_MODEL || !token(receipt.executionId) || !token(receipt.providerGenerationId) || !/^[a-f0-9]{64}$/.test(receipt.requestDigest) || !Array.isArray(receipt.imageDigests)) return null
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return {
    executionId: receipt.executionId, modelId: receipt.modelId, providerGenerationId: receipt.providerGenerationId,
    startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(), requestDigest: receipt.requestDigest,
    imageDigests: receipt.imageDigests.filter(value => /^[a-f0-9]{64}$/.test(value)).slice(0, 8),
    vision: receipt.vision === 'image-input-submitted' ? 'image-input-submitted' : 'no-image-input',
  }
}

export function groupDecisionSteps(steps: readonly GroupDecisionStep[] | undefined): GroupDecisionStep[] {
  if (!Array.isArray(steps)) return []
  return steps.flatMap(step => {
    if (!step || !token(step.id) || !groupDecisionPhases.includes(step.phase) || !Number.isSafeInteger(step.index) || step.index < 0 || step.index >= GROUP_MAX_ROUTING_DECISIONS || !['complete','invalid_decision','unavailable'].includes(step.status)) return []
    const receipt = groupDecisionReceipt(step.receipt ?? undefined)
    return [{id:step.id,phase:step.phase,index:step.index,status:receipt?step.status:'unavailable',failure:groupDecisionFailures.includes(step.failure!)?step.failure:null,receipt,
      ...(step.policyVersion && GROUP_POLICY_VERSIONS.includes(step.policyVersion) ? {policyVersion:step.policyVersion}:{}),
      ...(step.decisionCostUsd === null || typeof step.decisionCostUsd === 'number' && Number.isFinite(step.decisionCostUsd) && step.decisionCostUsd >= 0 ? {decisionCostUsd:step.decisionCostUsd}:{})} as GroupDecisionStep]
  }).slice(-GROUP_RETAINED_DECISIONS)
}

/** Retain a genuine historical primary receipt without guessing its questions.
 * The protocol/phase label distinguishes this from a new sequential chain. */
export function traceDecisionSteps(trace: Pick<GroupDecisionTrace,'decisions'|'execution'|'status'>) {
  if (Array.isArray(trace.decisions) && trace.decisions.length) return groupDecisionSteps(trace.decisions)
  const receipt=groupDecisionReceipt(trace.execution ?? undefined)
  return receipt ? [{id:receipt.executionId,phase:'legacy_primary' as const,index:0,status:trace.status==='complete'?'complete' as const:'invalid_decision' as const,failure:null,receipt}] : []
}

/** Cost is read by provider generation, never inferred from route validity.
 * A NULL component or an unsettled/missing row is an unknown whole call. */
export async function priceGroupDecisions(client: Client, steps: readonly GroupDecisionStep[]) {
  const ids=[...new Set(steps.flatMap(step=>step.receipt?[step.receipt.providerGenerationId]:[]))]
  if (!ids.length) return steps.map(step=>({...step,decisionCostUsd:null}))
  const {rows}=await client.query<{generationId:string;amount:number|null}>(`SELECT "generationId",
    CASE WHEN bool_and(state='settled' AND "costMicroUsd" IS NOT NULL) THEN sum("costMicroUsd")::float8 ELSE NULL END AS amount
    FROM hosted_usage WHERE "generationId"=ANY($1::text[]) AND model=$2 GROUP BY "generationId"`,[ids,DECISION_MODEL])
  const costs=new Map(rows.map(row=>[row.generationId,row.amount==null?null:row.amount/1_000_000]))
  return steps.map(step=>({...step,decisionCostUsd:step.receipt?costs.get(step.receipt.providerGenerationId)??null:null}))
}

/** A retry appends its genuine chain instead of erasing paid failed attempts.
 * Diagnostics stay bounded; omitted calls make total cost explicitly partial. */
export async function recordGroupDecisionSteps(client: Client, messageId: string, steps: readonly GroupDecisionStep[], failure?: GroupDecisionFailure, policyVersion?: GroupPolicyVersion) {
  const safe=groupDecisionSteps(steps)
  const version=policyVersion===undefined?safe[0]?.policyVersion:getGroupDecisionPolicy(policyVersion).version
  if (!safe.length && !failure && !version) return
  await client.query(`WITH merged AS (
    SELECT t."messageId",COALESCE(t.trace->'decisions','[]'::jsonb) || COALESCE((SELECT jsonb_agg(e)
      FROM jsonb_array_elements($2::jsonb) e WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.trace->'decisions','[]'::jsonb)) old WHERE old->>'id'=e->>'id')),'[]'::jsonb) AS entries
    FROM group_turns t WHERE t."messageId"=$1 FOR UPDATE
  ) UPDATE group_turns t SET trace=t.trace || jsonb_build_object(
    'decisions',COALESCE((SELECT jsonb_agg(e ORDER BY ord) FROM jsonb_array_elements(m.entries) WITH ORDINALITY x(e,ord)
      WHERE ord>GREATEST(0,jsonb_array_length(m.entries)-$3)),'[]'::jsonb),
    'decisionsOmitted',COALESCE((t.trace->>'decisionsOmitted')::integer,0)+GREATEST(0,jsonb_array_length(m.entries)-$3),
    'decisionFailure',$4::text) || $5::jsonb
    FROM merged m WHERE t."messageId"=m."messageId"`,[messageId,JSON.stringify(safe),GROUP_RETAINED_DECISIONS,failure??null,
      JSON.stringify({...(safe[0]?.index===0?{execution:safe[0].receipt,executionPhase:safe[0].phase}:{}),...(version?{policyVersion:version}:{})}),
  ])
}

export function createGroupDecisionTrace(members: readonly TraceMember[], contextMessageIds: string[]): GroupDecisionTrace {
  const snapshot = members.map(member => {
    const capability = member
    return { id: member.id, memberType: member.memberType ?? 'agent', roleDigest: digest(member.description),
      capabilityDigest: digest(capability.capabilities ?? []), executionAvailable: capability.executionAvailable === true }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return { schemaVersion: 1, policyVersion: getGroupDecisionPolicy().version, contextMessageIds: [...new Set(contextMessageIds)].slice(-10),
    memberVersion: digest(snapshot), members: snapshot, purpose: 'group-routing', action: null, reason: null, responders: [], execution: null,
    executionPhase:null,decisionProtocol:GROUP_DECISION_PROTOCOL,decisions:[],decisionsOmitted:0,decisionFailure:null,
    decisionLatencyMs: null, startedAt: new Date().toISOString(), finishedAt: null, taskFinishedAt:null, events: [], status: 'pending' }
}

export async function initializeGroupDecisionTrace(client: Client, messageId: string, members: readonly RoutingMember[], contextMessageIds: string[]) {
  await client.query(`UPDATE group_turns SET trace=$2::jsonb || jsonb_build_object(
    'decisions',COALESCE(trace->'decisions',CASE WHEN trace->'execution' IS NOT NULL AND trace->'execution'<>'null'::jsonb
      THEN jsonb_build_array(jsonb_build_object('id',trace->'execution'->>'executionId','phase','legacy_primary','index',0,'policyVersion',trace->>'policyVersion','status','invalid_decision','failure',null,'receipt',trace->'execution')) ELSE '[]'::jsonb END),
    'decisionsOmitted',COALESCE(trace->'decisionsOmitted','0'::jsonb)) WHERE "messageId"=$1`, [messageId, JSON.stringify(createGroupDecisionTrace(members, contextMessageIds))])
}

export async function recordGroupDecisionRoute(client: Client, messageId: string, route: GroupRoute) {
  const execution = groupDecisionReceipt('execution' in route ? route.execution : undefined)
  const action = 'action' in route && typeof route.action === 'string' ? route.action : 'reply'
  const reason = 'reason' in route && typeof route.reason === 'string' && /^[a-z0-9_-]{1,80}$/i.test(route.reason) ? route.reason : null
  const policyVersion = 'policyVersion' in route && typeof route.policyVersion === 'string' ? getGroupDecisionPolicy(route.policyVersion).version : getGroupDecisionPolicy().version
  const decisions=groupDecisionSteps(route.decisions)
  if (!decisions.length && execution) decisions.push({id:execution.executionId,phase:'legacy_primary',index:0,policyVersion,status:'complete',failure:null,receipt:execution})
  await recordGroupDecisionSteps(client,messageId,decisions)
  await client.query('UPDATE group_turns SET trace=trace || $2::jsonb WHERE "messageId"=$1', [messageId, JSON.stringify({
    purpose: route.by === 'mention' ? 'explicit-mention' : 'group-routing', action, reason, policyVersion, responders: [...route.responders], execution,
    executionPhase:decisions[0]?.phase ?? (execution?'legacy_primary':null),
    decisionLatencyMs: decisions.length ? groupDecisionTotals(decisions).decisionLatencyMs : execution ? Date.parse(execution.completedAt) - Date.parse(execution.startedAt) : null,
  })])
}

/** Use the same transaction as the event being counted (notably publication).
 * Event IDs make a retried receipt a no-op without pretending a replay occurred. */
export async function recordGroupTraceEvent(client: Client, messageId: string, event: GroupTraceEvent) {
  const safe: GroupTraceEvent = { id: event.id, type: event.type,
    ...(token(event.memberId) ? { memberId: event.memberId } : {}), ...(token(event.taskId) ? { taskId: event.taskId } : {}),
    ...(token(event.runId) ? { runId: event.runId } : {}), ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.contentDigest && /^[a-f0-9]{64}$/.test(event.contentDigest) ? { contentDigest: event.contentDigest } : {}) }
  if (!token(safe.id)) throw new Error('invalid_group_trace_event')
  await client.query(`UPDATE group_turns SET trace=jsonb_set(trace,'{events}',COALESCE(trace->'events','[]'::jsonb) || $2::jsonb)
    WHERE "messageId"=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(trace->'events','[]'::jsonb)) e WHERE e->>'id'=$3)`,
  [messageId, JSON.stringify([safe]), safe.id])
}

export async function finishGroupDecisionTrace(client: Client, messageId: string, status: GroupDecisionTrace['status']) {
  await client.query(`UPDATE group_turns SET trace=trace || jsonb_build_object('status',$2::text,'finishedAt',now()) WHERE "messageId"=$1`, [messageId, status])
}
