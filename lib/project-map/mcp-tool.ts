import { z } from 'zod'
import { runDecisionCatalogueSchema } from '@mikka/protocol/device'
import { recordDecisionSchema } from './contracts'

/** The HTTP MCP handler and a task's initial claim advertise one definition.
 * This metadata grants no authority; record_decision still uses its run token
 * and the existing server-side writer checks when the tool is actually called. */
export const RECORD_DECISION_TOOL = {
  title: 'Record a project decision',
  description: 'Record a meaningful choice, change of direction, stopped route, merge or human confirmation in this Mikka task. Explain alternatives, reasons and original Mikka evidence. Keep a stable idempotencyKey for exact retries. This stores the decision only in Mikka, never in the code repository.',
  inputSchema: recordDecisionSchema,
  annotations: { idempotentHint: true as const },
}

// Match the installed MCP server's input/2020-12 conversion. The real MCP
// tools/list regression compares the complete result, including defaults and
// required fields, so an SDK serialization change cannot silently diverge.
export const RUN_DECISION_CATALOGUE = runDecisionCatalogueSchema.parse({
  version: 1,
  tool: { name: 'record_decision', ...RECORD_DECISION_TOOL,
    inputSchema: z.toJSONSchema(recordDecisionSchema, { target: 'draft-2020-12', io: 'input' }) },
})
