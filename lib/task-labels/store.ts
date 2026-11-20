import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { WorkspaceTaskLabel, WorkspaceTaskLabelsView } from '@mikka/protocol/task-labels'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { requireWorkspace } from '@/lib/workspace-access'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { enterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'
import { GovernanceError } from '@/lib/governance/errors'
import { activityActor } from '@/lib/activity-actor'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { persistIssueMetadata } from '@/lib/issue-metadata-store'
import { workspaceListChanged } from '@/lib/live/lists'
import { createTaskLabelInput, mergeTaskLabelsInput, updateTaskLabelInput } from './input'
import { issueLabelRefs, workspaceIssueLabels } from './schema'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

export class TaskLabelConflict extends Error {
  constructor(readonly detail: 'name_taken' | 'changed') { super(detail); this.name = 'TaskLabelConflict' }
}

function databaseConflict(error: unknown): TaskLabelConflict | null {
  for (let cause: unknown = error; cause && typeof cause === 'object'; cause = (cause as { cause?: unknown }).cause) {
    const value = cause as { constraint?: string; code?: string }
    if (value.constraint === 'workspace_issue_labels_name_key') return new TaskLabelConflict('name_taken')
    if (value.code === '55P03' || value.code === '40P01' || value.code === '40001') return new TaskLabelConflict('changed')
  }
  return null
}

/** Shared by task property pickers after they admit the workspace. Unused labels are still selectable. */
export async function taskLabelsInWorkspace(executor: Reader, workspaceId: string): Promise<WorkspaceTaskLabel[]> {
  return executor.select({ id: workspaceIssueLabels.id, name: workspaceIssueLabels.name, color: workspaceIssueLabels.color })
    .from(workspaceIssueLabels).where(eq(workspaceIssueLabels.workspaceId, workspaceId)).orderBy(asc(workspaceIssueLabels.name), asc(workspaceIssueLabels.id))
}

async function inWorkspace<T>(reader: EnterpriseReader, workspaceId: string, admin: boolean,
  work: (tx: Transaction, canManage: boolean) => Promise<T>): Promise<T> {
  z.uuid().parse(workspaceId)
  const userId = typeof reader === 'string' ? reader : reader.id
  try {
    return await withTaskWorkspace(reader, workspaceId, async (_workspace, membership) => {
      const { membership: current } = await requireWorkspace(membership, workspaceId, userId, admin,
        typeof reader === 'string' ? undefined : reader[enterprisePrincipal])
      return db.transaction(tx => work(tx, current.role === 'admin'))
    })
  } catch (error) { throw databaseConflict(error) ?? error }
}

const view = async (tx: Reader, workspaceId: string, canManage: boolean): Promise<WorkspaceTaskLabelsView> =>
  ({ workspaceId, source: 'workspace', labels: await taskLabelsInWorkspace(tx, workspaceId), canManage })

export async function readWorkspaceTaskLabels(reader: EnterpriseReader, workspaceId: string): Promise<WorkspaceTaskLabelsView> {
  return inWorkspace(reader, workspaceId, false, (tx, canManage) => view(tx, workspaceId, canManage))
}

async function lockedLabels(tx: Transaction, workspaceId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  const rows = await tx.select().from(workspaceIssueLabels).where(and(eq(workspaceIssueLabels.workspaceId, workspaceId), inArray(workspaceIssueLabels.id, unique)))
    .orderBy(asc(workspaceIssueLabels.id)).for('update', { noWait: true })
  if (rows.length !== unique.length) throw new GovernanceError('not_found')
  return new Map(rows.map(row => [row.id, row]))
}

async function changed(tx: Transaction, workspaceId: string) {
  await workspaceListChanged(tx, workspaceId, ['workspace_settings', 'issue_list'])
}

export async function createWorkspaceTaskLabel(reader: EnterpriseReader, workspaceId: string, raw: unknown) {
  const input = createTaskLabelInput.parse(raw)
  return inWorkspace(reader, workspaceId, true, async tx => {
    const [label] = await tx.insert(workspaceIssueLabels).values({ workspaceId, ...input }).returning({ id: workspaceIssueLabels.id, name: workspaceIssueLabels.name, color: workspaceIssueLabels.color })
    await changed(tx, workspaceId)
    return { ...await view(tx, workspaceId, true), label }
  })
}

/** One admin edit versions every affected task through its existing metadata writer.
 * The database resolves IDs to canonical snapshots and updates refs for every writer,
 * including raw imports. Historical issue_versions are never rewritten. */
async function rewriteTasks(tx: Transaction, workspaceId: string, id: string, userId: string, replacement?: string | null) {
  const tasks = await tx.select({ issue: issues }).from(issues).innerJoin(issueLabelRefs, eq(issueLabelRefs.issueId, issues.id))
    .where(and(eq(issues.workspaceId, workspaceId), eq(issueLabelRefs.workspaceId, workspaceId), eq(issueLabelRefs.labelId, id)))
    .orderBy(asc(issues.id)).for('update', { of: issues })
  for (const { issue } of tasks) {
    const metadata = readIssueMetadata(issue.content)
    const ids = metadata.labelIds ?? []
    const labelIds = replacement === undefined ? ids : [...new Set(ids.flatMap(value => value === id ? replacement ? [replacement] : [] : [value]))]
    const saved = await persistIssueMetadata(tx, issue, { ...metadata, labelIds }, activityActor(userId))
    if (!saved) throw new TaskLabelConflict('changed')
  }
}

export async function updateWorkspaceTaskLabel(reader: EnterpriseReader, workspaceId: string, id: string, raw: unknown) {
  z.uuid().parse(id)
  const input = updateTaskLabelInput.parse(raw)
  return inWorkspace(reader, workspaceId, true, async tx => {
    await lockedLabels(tx, workspaceId, [id])
    const [label] = await tx.update(workspaceIssueLabels).set({ ...input, updatedAt: new Date() }).where(eq(workspaceIssueLabels.id, id))
      .returning({ id: workspaceIssueLabels.id, name: workspaceIssueLabels.name, color: workspaceIssueLabels.color })
    await rewriteTasks(tx, workspaceId, id, typeof reader === 'string' ? reader : reader.id)
    await changed(tx, workspaceId)
    return { ...await view(tx, workspaceId, true), label }
  })
}

export async function deleteWorkspaceTaskLabel(reader: EnterpriseReader, workspaceId: string, id: string) {
  z.uuid().parse(id)
  return inWorkspace(reader, workspaceId, true, async tx => {
    await lockedLabels(tx, workspaceId, [id])
    await rewriteTasks(tx, workspaceId, id, typeof reader === 'string' ? reader : reader.id, null)
    await tx.delete(workspaceIssueLabels).where(eq(workspaceIssueLabels.id, id))
    await changed(tx, workspaceId)
    return { ...await view(tx, workspaceId, true), deletedId: id }
  })
}

export async function mergeWorkspaceTaskLabels(reader: EnterpriseReader, workspaceId: string, id: string, raw: unknown) {
  z.uuid().parse(id)
  const { targetId } = mergeTaskLabelsInput.parse(raw)
  if (id === targetId) throw new GovernanceError('invalid_request')
  return inWorkspace(reader, workspaceId, true, async tx => {
    await lockedLabels(tx, workspaceId, [id, targetId])
    await rewriteTasks(tx, workspaceId, id, typeof reader === 'string' ? reader : reader.id, targetId)
    await tx.delete(workspaceIssueLabels).where(eq(workspaceIssueLabels.id, id))
    await changed(tx, workspaceId)
    return { ...await view(tx, workspaceId, true), mergedId: id, targetId }
  })
}
