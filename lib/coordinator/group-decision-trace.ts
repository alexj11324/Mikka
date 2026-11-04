import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { DecisionExecution } from './decide'
import type { GroupRoute, RoutingMember } from './group-routing'
import { getGroupDecisionPolicy } from './group-decision-policy'
import { DECISION_MODEL } from './decision'

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

export function createGroupDecisionTrace(members: readonly TraceMember[], contextMessageIds: string[]): GroupDecisionTrace {
  const snapshot = members.map(member => {
    const capability = member
    return { id: member.id, memberType: member.memberType ?? 'agent', roleDigest: digest(member.description),
      capabilityDigest: digest(capability.capabilities ?? []), executionAvailable: capability.executionAvailable === true }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return { schemaVersion: 1, policyVersion: getGroupDecisionPolicy().version, contextMessageIds: [...new Set(contextMessageIds)].slice(-10),
    memberVersion: digest(snapshot), members: snapshot, purpose: 'group-routing', action: null, reason: null, responders: [], execution: null,
    decisionLatencyMs: null, startedAt: new Date().toISOString(), finishedAt: null, taskFinishedAt:null, events: [], status: 'pending' }
}

export async function initializeGroupDecisionTrace(client: Client, messageId: string, members: readonly RoutingMember[], contextMessageIds: string[]) {
  await client.query('UPDATE group_turns SET trace=$2 WHERE "messageId"=$1', [messageId, JSON.stringify(createGroupDecisionTrace(members, contextMessageIds))])
}

export async function recordGroupDecisionRoute(client: Client, messageId: string, route: GroupRoute) {
  const execution = groupDecisionReceipt('execution' in route ? route.execution : undefined)
  const action = 'action' in route && typeof route.action === 'string' ? route.action : 'reply'
  const reason = 'reason' in route && typeof route.reason === 'string' && /^[a-z0-9_-]{1,80}$/i.test(route.reason) ? route.reason : null
  const policyVersion = 'policyVersion' in route && typeof route.policyVersion === 'string' ? getGroupDecisionPolicy(route.policyVersion).version : getGroupDecisionPolicy().version
  await client.query('UPDATE group_turns SET trace=trace || $2::jsonb WHERE "messageId"=$1', [messageId, JSON.stringify({
    purpose: route.by === 'mention' ? 'explicit-mention' : 'group-routing', action, reason, policyVersion, responders: [...route.responders], execution,
    decisionLatencyMs: execution ? Date.parse(execution.completedAt) - Date.parse(execution.startedAt) : null,
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
