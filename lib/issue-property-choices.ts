import 'server-only'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueVisibility } from '@/lib/issue-visibility'
import { readIssueMetadata } from '@/lib/issue-metadata'

/** Task property choices never expose the owner's hidden execution identities. */
export async function issuePropertyChoices(userId: string) {
  const rows = await db.select({ content: issues.content }).from(issues).where((await issueVisibility(userId)).predicate)
  return {
    labels: [...new Map(rows.flatMap(row => readIssueMetadata(row.content).labels).map(label => [label.name, label])).values()],
  }
}
