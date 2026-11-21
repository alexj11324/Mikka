import { taskRunSettingsSchema } from './task-run-settings-schema'
import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from './issue-meta'
import { labelSchema } from './issue-metadata'

/** Who the new task is assigned to (Capy's Assignee): a workspace member, or one of the person's Bots. A Bot is
 * stored as the task's delegate (lib/issue-metadata.ts) and is woken with the assignment (lib/task-create-properties.ts, issueAssignedEvent in lib/coordinator-events.ts). */
export const createAssigneeSchema = z.strictObject({ kind: z.enum(['user', 'bot']), id: z.string().min(1).max(128) })
export type CreateAssignee = z.infer<typeof createAssigneeSchema>

/** Access (Capy's Everyone at <workspace> / Only specific people). `members` keeps the task private to its owner and
 * grants the listed active members content access through resource_access_grants. */
export const createAccessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace') }),
  z.strictObject({ kind: z.literal('members'), memberIds: z.array(z.string().min(1).max(128)).max(200) }),
])
export type CreateAccess = z.infer<typeof createAccessSchema>

export const createOnlyCommand = z.strictObject({
  version: z.literal(1), intent: z.literal('create_only'), requestId: z.uuid(), workspaceId: z.uuid(),
  teamId: z.uuid().optional(), projectId: z.uuid().optional(), confirmAccess: z.boolean().optional(),
  title: z.string().trim().min(1).max(200),
  content: z.custom<JSONContent>(v => Boolean(v && typeof v === 'object' && JSON.stringify(v).length <= 250_000)),
  status: z.enum(ISSUE_STATUS_CODES), priority: z.enum(ISSUE_PRIORITY_CODES),
  /** The create window's properties. Absent ones leave the task as before: unassigned, no due date, no labels,
   * visible to the workspace. Files go up after the receipt through the task's own attachments route. */
  assignee: createAssigneeSchema.nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  labels: z.array(labelSchema).max(12).optional(),
  labelIds: z.array(z.uuid()).max(12).optional(),
  access: createAccessSchema.optional(),
}).refine(value => value.labels === undefined || value.labelIds === undefined)
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
