import { z } from 'zod'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'

const changes = {
  status: z.enum(ISSUE_STATUS_CODES).optional(),
  priority: z.enum(ISSUE_PRIORITY_CODES).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  assigneeUserId: z.string().trim().min(1).max(200).nullable().optional().describe('A person who already has access to this task; null unassigns. Never an execution identity.'),
}

export const createIssueInput = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(50_000).optional(), ...changes }).strict()
export const updateIssueInput = z.object({ issueId: z.uuid(), title: z.string().trim().min(1).max(200).optional(), ...changes }).strict()
export type CreateIssueInput = z.infer<typeof createIssueInput>
export type UpdateIssueInput = z.infer<typeof updateIssueInput>
