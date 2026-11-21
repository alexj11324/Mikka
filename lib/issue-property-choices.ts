import 'server-only'
import type { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { readIssueMetadata } from '@/lib/issue-metadata'

/** Task property choices never expose the owner's hidden execution identities. Labels live in attrs; the body is not read. */
export async function issuePropertyChoices(reader: IssueReader, workspaceId: string, tx: Pick<typeof db, 'select'>) {
  const visibility = await issueVisibility(reader, false, workspaceId, tx)
  const rows = await tx.select({ content: issueAttrsContent }).from(issues).where(visibility.predicate)
  return {
    labels: [...new Map(rows.flatMap(row => readIssueMetadata(row.content).labels).map(label => [label.name, label])).values()],
  }
}
