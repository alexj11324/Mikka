import { z } from 'zod'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'

const confirmAccess = z.boolean().optional().describe('Only to replay a call that returned error accessChangeConfirmationRequired: the call would change who can read the task, and this confirms it.')
const changes = {
  confirmAccess,
  status: z.enum(ISSUE_STATUS_CODES).optional(),
  priority: z.enum(ISSUE_PRIORITY_CODES).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  assigneeUserId: z.string().trim().min(1).max(200).nullable().optional().describe('A person who already has access to this task; null unassigns. Never an execution identity.'),
}

export const createIssueInput = z.object({
  title: z.string().trim().min(1).max(200), body: z.string().max(50_000).optional(), ...changes,
  teamId: z.uuid().optional().describe('Only after create_issue returned issueTeamRequired: the id of the team the person chose among its teams. Otherwise omit; the task goes to this workspace\'s team on its own.'),
}).strict()
export const updateIssueInput = z.object({ issueId: z.uuid(), title: z.string().trim().min(1).max(200).optional(), ...changes }).strict()
export type CreateIssueInput = z.infer<typeof createIssueInput>
export type UpdateIssueInput = z.infer<typeof updateIssueInput>
