import type { CoordinatorRuntime } from '@mikka/protocol/coordinator'
import { beginPreparedAgentExecution } from './agent-kit-steps'
import { prepareTurn } from './steps'

/** One durable preparation for a hosted execution; its frozen snapshot owns the prompt and tools. */
export async function prepareHostedAgentRound(userId: string, botId: string, holder: string, round: number, selected: Extract<CoordinatorRuntime, { harness: 'ai_sdk' }>, mailboxEnabled: boolean, scheduledRead: boolean, enabled: boolean, sourceEventId?: string) {
  'use step'
  const started = Date.now()
  const execution = await beginPreparedAgentExecution(userId, botId, holder, round, selected, enabled, sourceEventId)
  // Without an execution snapshot, model selection keeps its own durable checkpoint.
  if (!execution) return { kind: 'disabled' as const }
  if (execution.snapshot.runtime.harness !== selected.harness) throw new Error('agent_runtime_changed')
  const hosted = execution.snapshot.runtime
  const begun = Date.now()
  const prepared = await prepareTurn(userId, botId, holder, {
    snapshot: execution.snapshot, executionId: execution.id, mailboxEnabled,
    runtime: scheduledRead ? null : hosted,
  })
  // Node body times for this successful attempt only, separate from the
  // Workflow event-clock span (which also includes dispatch and any retries).
  return { kind: 'ready' as const, execution, hosted, prepared, bodyMs: { begin: Math.max(0, begun - started), prepare: Math.max(0, Date.now() - begun) } }
}
