import { tool } from 'ai'
import { z } from 'zod'
import { definitionSchema, scheduleHistoryInput, scheduleListInput, type Command } from './contract'

export function scheduleTools(execute: (command: Command) => Promise<unknown>) {
  const versioned = z.object({ scheduleId: z.uuid(), version: z.number().int().positive() }).strict()
  return {
    schedule_create: tool({ description: 'Persist a user-requested workspace automation: a reminder, an issue snapshot, an explicitly scoped read-only Agent task, or dispatch_task, which hands a Bot (botId null: the Coordinator) a request as a new task at each run, as the schedule\'s creator, optionally on GitHub, Linear or Slack events or a webhook besides its timing. Supports one-shot, interval, daily and five-field cron timing. Returns the exact next UTC time, IANA timezone and authorization scope. Work that changes code or external systems uses dispatch_task.', inputSchema: z.object({ definition: definitionSchema }).strict(), execute: (input, options) => execute({ action: 'create', requestId: options.toolCallId, ...input }) }),
    schedule_list: tool({ description: 'List schedules visible in this workspace, including legacy owner-only schedules owned by this conversation. Pass scheduleId to read one visible schedule and its full definition. Pass deleted=true for recoverable deleted schedules. Pass nextCursor back as cursor to continue a list.', inputSchema: scheduleListInput, execute: input => execute({ action: 'list', ...input }) }),
    schedule_history: tool({ description: 'Read occurrence/operation IDs, outcomes, attempts, timestamps and errors. Pass batches to list webhook batches, request counts, payload bytes and first/last receipt times, optionally filtered by status. Continue with nextCursor as batches.cursor.', inputSchema: scheduleHistoryInput, execute: input => execute({ action: 'history', ...input }) }),
    schedule_update: tool({ description: 'Replace a schedule definition using the latest version. Fences unexecuted occurrences.', inputSchema: versioned.extend({ definition: definitionSchema }), execute: input => execute({ action: 'update', ...input }) }),
    schedule_pause: tool({ description: 'Persistently pause; fence unexecuted occurrences.', inputSchema: versioned, execute: input => execute({ action: 'pause', ...input }) }),
    schedule_resume: tool({ description: 'Resume a paused schedule from its next future slot. Missed paused slots never run.', inputSchema: versioned, execute: input => execute({ action: 'resume', ...input }) }),
    schedule_cancel: tool({ description: 'Permanently cancel all future/unexecuted occurrences.', inputSchema: versioned, execute: input => execute({ action: 'cancel', ...input }) }),
  }
}
