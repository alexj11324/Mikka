import { sql } from 'drizzle-orm'
import type { CompactRunFailure } from './run-failure-view'
export { readCompactRunFailure, type CompactRunFailure } from './run-failure-view'
import { agentRuns } from './db/schema'

/** List reads transfer only the closed diagnostic fields. The provider text
 * and cause chain never leave PostgreSQL for a list or teammate projection. */
export const runFailureBrief = sql<CompactRunFailure | null>`case
  when jsonb_typeof(${agentRuns.failureDetails})='object' and ${agentRuns.failureDetails}->>'schemaVersion'='1'
  then jsonb_build_object(
    'schemaVersion', ${agentRuns.failureDetails}->'schemaVersion',
    'code', ${agentRuns.failureDetails}->'code',
    'category', ${agentRuns.failureDetails}->'category',
    'runId', ${agentRuns.failureDetails}->'runId',
    'occurredAt', ${agentRuns.failureDetails}->'occurredAt',
    'appVersion', ${agentRuns.failureDetails}->'appVersion'
  ) || jsonb_strip_nulls(jsonb_build_object(
    'detail', ${agentRuns.failureDetails}->'detail',
    'provider', ${agentRuns.failureDetails}->'provider',
    'status', ${agentRuns.failureDetails}->'status',
    'recovery', ${agentRuns.failureDetails}->'recovery'
  )) end`
