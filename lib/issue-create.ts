import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { issueVersions, issues } from '@/lib/db/schema'
import { allocateIssueNumbers } from '@/lib/issue-numbering'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { issueView } from '@/lib/task-identifier-server'
import type { ActivityActor } from '@/lib/activity-actor'
import { readableIssueContentOnServer as readableIssueContent } from '@/lib/issue-editor-schema-snapshot'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import { issueListChanged } from './live/lists'
import { scheduleShortTitle } from './short-title-schedule'
import { requireTaskWorkspace } from './task-workspace'
import { registerTaskResourceAccess } from './task-resource-registration'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const createIssueSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // Same schema the issue editor uses: content it cannot render would open read-only, so reject it at creation.
  content: z.custom<JSONContent>(value => !!value && typeof value === 'object' && JSON.stringify(value).length <= 250000 && readableIssueContent(value) !== null).transform(value => readableIssueContent(value) as JSONContent),
  status: z.enum(ISSUE_STATUS_CODES),
  priority: z.enum(ISSUE_PRIORITY_CODES),
})

/** `actor` is who issue history records as creating it, decided by the caller on the server. */
export async function createIssueForUserInTransaction(tx: Transaction, userId: string, input: unknown, actor: ActivityActor, options: { workspaceId: string; id?: string; linearSyncBlocked?: boolean; deriveShortTitle?: boolean }) {
  const parsed = createIssueSchema.safeParse(input)
  if (!parsed.success) return null
  const workspace = await requireTaskWorkspace(userId, options.workspaceId)
  const id = options?.id ?? crypto.randomUUID()
  const number = await allocateIssueNumbers(tx, userId)
  const metadata = { ...readIssueMetadata({ type: 'doc' }), number }
  const [issue] = await tx.insert(issues).values({
    ...parsed.data,
    content: withIssueMetadata(parsed.data.content, metadata),
    id,
    userId,
    workspaceId: workspace.id,
    ownershipState: 'bound',
    scope: workspace.kind === 'personal' ? 'personal' : 'workspace',
    scopeSetBy: 'user',
    linearSyncPolicy: 'disabled',
    revision: 1,
    linearSyncBlocked: options.linearSyncBlocked ?? true,
  }).returning()
  await registerTaskResourceAccess(tx, { id, ownerId: userId, workspaceId: workspace.id, workspaceKind: workspace.kind })
  await tx.insert(issueVersions).values({
    id: crypto.randomUUID(),
    issueId: id,
    userId,
    revision: issue.revision,
    title: issue.title,
    content: issue.content,
    status: issue.status,
    priority: issue.priority,
    ...actor,
  })
  await issueListChanged(tx, id)
  // A short title for the lists, written once after this commits (lib/short-title-schedule.ts).
  if (options.deriveShortTitle !== false) scheduleShortTitle(tx, id, userId)
  return issueView(issue, tx)
}
