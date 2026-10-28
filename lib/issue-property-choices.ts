import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agents, issues } from '@/lib/db/schema'
import { issueVisibility } from '@/lib/issue-visibility'
import { readIssueMetadata } from '@/lib/issue-metadata'

/** A workspace task is not a directory into its owner's personal agents/tasks. */
export async function issuePropertyChoices(userId: string) {
  const availableAgents = await db.select({ id: agents.id, name: agents.name, harness: agents.harness }).from(agents).where(eq(agents.userId, userId))
  const rows = await db.select({ content: issues.content }).from(issues).where((await issueVisibility(userId)).predicate)
  return {
    agents: availableAgents,
    labels: [...new Map(rows.flatMap(row => readIssueMetadata(row.content).labels).map(label => [label.name, label])).values()],
  }
}
