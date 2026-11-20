import { taskRunSettingsSchema } from './task-run-settings'
import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from './issue-meta'

export const createOnlyCommand = z.strictObject({
  version: z.literal(1), intent: z.literal('create_only'), requestId: z.uuid(), workspaceId: z.uuid(),
  teamId: z.uuid().optional(), projectId: z.uuid().optional(), confirmAccess: z.boolean().optional(),
  title: z.string().trim().min(1).max(200),
  content: z.custom<JSONContent>(v => Boolean(v && typeof v === 'object' && JSON.stringify(v).length <= 250_000)),
  status: z.enum(ISSUE_STATUS_CODES), priority: z.enum(ISSUE_PRIORITY_CODES),
})
export type CreateOnlyCommand = z.input<typeof createOnlyCommand>

/** The Agent a dispatched task runs on (decision 2026-11-17-1800): the task keeps it for life. */
export const taskAgentSchema = z.enum(['claude_code', 'codex'])
export type TaskAgent = z.infer<typeof taskAgentSchema>

export const dispatchTaskIntent = z.strictObject({
  version: z.literal(1), intent: z.literal('create_and_dispatch'), teamId: z.uuid().optional(), projectId: z.uuid().optional(), description: z.string().trim().min(1).max(10_000),
  /** Required to dispatch: a command without it is refused with agentRequired. Optional here so stored commands still parse. */
  agent: taskAgentSchema.optional(),
  /** How the new thread is set up (an automation's Environment, model and effort, machine size, pin). */
  run: taskRunSettingsSchema.optional(),
})
export type DispatchTaskIntent = z.infer<typeof dispatchTaskIntent>

export const dispatchReceiptInput = z.strictObject({ workspaceId: z.uuid(), requestId: z.uuid(), botId: z.uuid().nullable() })
export type DispatchReceiptInput = z.infer<typeof dispatchReceiptInput>

export type DispatchedTaskReceipt = {
  version: 1; taskId: string; identifier: string; dispatch: { sourceEventId: string; botId: string }
}
