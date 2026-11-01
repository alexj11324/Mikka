import { tool } from 'ai'
import { z } from 'zod'
import { definitionSchema, type Command } from './contract'

export function scheduleTools(execute: (command: Command) => Promise<unknown>) {
  const versioned = z.object({ scheduleId: z.uuid(), version: z.number().int().positive() }).strict()
  return {
    schedule_create: tool({ description: 'Persist a user-requested reminder, issue snapshot or explicitly scoped read-only Agent task. Returns the exact next UTC time, IANA timezone and authorization scope. External write tasks are unsupported.', inputSchema: z.object({ definition: definitionSchema }).strict(), execute: (input, options) => execute({ action: 'create', requestId: options.toolCallId, ...input }) }),
    schedule_list: tool({ description: 'List only this owner/workspace schedules and current versions.', inputSchema: z.object({}).strict(), execute: () => execute({ action: 'list' }) }),
    schedule_history: tool({ description: 'Read occurrence/operation IDs, outcomes, attempts, timestamps and errors.', inputSchema: z.object({ scheduleId: z.uuid() }).strict(), execute: input => execute({ action: 'history', ...input }) }),
    schedule_update: tool({ description: 'Replace a schedule definition using the latest version. Fences unexecuted occurrences.', inputSchema: versioned.extend({ definition: definitionSchema }), execute: input => execute({ action: 'update', ...input }) }),
    schedule_pause: tool({ description: 'Persistently pause; fence unexecuted occurrences.', inputSchema: versioned, execute: input => execute({ action: 'pause', ...input }) }),
    schedule_resume: tool({ description: 'Resume a paused schedule from its next future slot. Missed paused slots never run.', inputSchema: versioned, execute: input => execute({ action: 'resume', ...input }) }),
    schedule_cancel: tool({ description: 'Permanently cancel all future/unexecuted occurrences.', inputSchema: versioned, execute: input => execute({ action: 'cancel', ...input }) }),
  }
}
