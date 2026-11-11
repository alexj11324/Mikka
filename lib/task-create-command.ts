import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from './issue-meta'

export const createOnlyCommand = z.strictObject({
  version: z.literal(1), intent: z.literal('create_only'), requestId: z.uuid(), workspaceId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  content: z.custom<JSONContent>(v => Boolean(v && typeof v === 'object' && JSON.stringify(v).length <= 250_000)),
  status: z.enum(ISSUE_STATUS_CODES), priority: z.enum(ISSUE_PRIORITY_CODES),
})
export type CreateOnlyCommand = z.input<typeof createOnlyCommand>
