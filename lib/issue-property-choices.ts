import 'server-only'
import type { db } from '@/lib/db'
import type { IssueReader } from '@/lib/issue-visibility'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { taskLabelsInWorkspace } from '@/lib/task-labels/store'

/** The admitted workspace's reusable label entities, including labels not assigned to a visible task yet. */
export async function issuePropertyChoices(reader: IssueReader, workspaceId: string, tx: Pick<typeof db, 'select'>) {
  await requireTaskWorkspace(reader, workspaceId)
  const labelRecords = await taskLabelsInWorkspace(tx, workspaceId)
  return { labelRecords, labels: labelRecords.map(({ name, color }) => ({ name, color })) }
}
