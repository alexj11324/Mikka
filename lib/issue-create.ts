import { z } from 'zod'
import type { JSONContent } from '@tiptap/core'
import { db } from '@/lib/db'
import { issueVersions, issues } from '@/lib/db/schema'
import { allocateIssueNumbers } from '@/lib/issue-numbering'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { issueView } from '@/lib/task-identifier-server'
import type { ActivityActor } from '@/lib/activity-actor'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '@/lib/issue-meta'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const createIssueSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.custom<JSONContent>(value => !!value && typeof value === 'object' && (value as JSONContent).type === 'doc' && JSON.stringify(value).length <= 250000),
  status: z.enum(ISSUE_STATUS_CODES),
  priority: z.enum(ISSUE_PRIORITY_CODES),
})

/** `actor` is who issue history records as creating it, decided by the caller on the server. */
export async function createIssueForUserInTransaction(tx: Transaction, userId: string, input: unknown, actor: ActivityActor, options?: { id: string; linearSyncBlocked: boolean }) {
  const parsed = createIssueSchema.safeParse(input)
  if (!parsed.success) return null
  const id = options?.id ?? crypto.randomUUID()
  const number = await allocateIssueNumbers(tx, userId)
  const metadata = { ...readIssueMetadata({ type: 'doc' }), number }
  const [issue] = await tx.insert(issues).values({
    ...parsed.data,
    content: withIssueMetadata(parsed.data.content, metadata),
    id,
    userId,
    revision: 1,
    linearSyncBlocked: options?.linearSyncBlocked ?? false,
  }).returning()
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
  return issueView(issue, tx)
}
