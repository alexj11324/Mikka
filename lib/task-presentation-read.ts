import 'server-only'
import { and, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { teamIssues } from '@/lib/db/team-schema'
import { readFactoryFlowStates } from '@/lib/factory/public-flow'
import { factoryScopeAllows } from '@/lib/factory/scope'
import type { FactoryTask } from '@/lib/factory/store'
import { ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import type { BlockRun } from '@/lib/task-blocked'
import { taskPresentationsInput, type TaskPresentationsInput } from '@/lib/task-presentation-input'
import { taskPresentation, type TaskPresentation } from '@/lib/task-presentation'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { workspaceDb } from '@/lib/workspace-db'

type Reader = Exclude<IssueReader, string>
export type TaskPresentations = { version: 1; workspaceId: string; items: Record<string, TaskPresentation> }

/** Binding a selected tenant must retain the authenticated non-enumerable
 * principal, including native sessions. Never replace a token's own pin. */
export function scopedTaskPresentationReader(reader: Reader, workspaceId: string): Reader {
  const scope = taskReaderScope(reader)
  if (scope.workspaceId && scope.workspaceId !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(reader),
    [tokenWorkspace]: { value: workspaceId },
  }) as Reader
}

/** Only the canonical visibility predicate admits rows. Workspace membership
 * is held by the caller, so its existing authorization path borrows that lease. */
async function taskRows(reader: Reader, workspaceId: string, ids: readonly string[]) {
  if (!ids.length) return []
  const visibility = await issueVisibility(reader, false, workspaceId, db, { onlyIssueIds: ids, withTeamLinks: false })
  const rows = await db.select({ id: issues.id, userId: issues.userId, workspaceId: issues.workspaceId,
    ownershipState: issues.ownershipState, scope: issues.scope, scopeVersion: issues.scopeVersion,
    status: issues.status, content: issueAttrsContent }).from(issues)
    .where(and(inArray(issues.id, [...ids]), visibility.predicate))
  // Preserve the legacy JSON-null mikka/orvilo tombstone check as issueForUser.
  return rows.map(row => ({ ...row, metadata: readIssueMetadata(row.content) })).filter(row => !row.metadata.deletedAt)
}

type FactoryStateRow = Pick<FactoryTask, 'id' | 'issueId' | 'userId' | 'workspaceId' | 'stage' | 'status'> & { sourceAllowed: boolean }

/** One bounded read for a visible list. APP reads share a read-only snapshot;
 * live tenant membership stays locked through its commit in the separate WS DB.
 * Neither full task bodies nor private Run/Factory payloads are selected. */
export async function readTaskPresentations(user: Reader, input: TaskPresentationsInput): Promise<TaskPresentations> {
  const parsed = taskPresentationsInput.parse(input)
  const { workspaceId } = parsed
  const wanted = [...new Set(parsed.issueIds)]
  const reader = scopedTaskPresentationReader(user, workspaceId)
  return withTaskWorkspace(reader, workspaceId, async () => {
    if (!wanted.length) return { version: 1, workspaceId, items: {} }
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const items = await withDatabaseClient(client, async () => {
        const tasks = await taskRows(reader, workspaceId, wanted)
        const taskIds = new Set(tasks.map(task => task.id))
        const dependencyIds = [...new Set(tasks.flatMap(task => task.metadata.blockedByIds))].filter(id => !taskIds.has(id))
        const dependencies = await taskRows(reader, workspaceId, dependencyIds)
        const rows = [...tasks, ...dependencies]
        // These two tables may be in different databases. Pair exact IDs in
        // memory; a malformed Team link never changes a Task's canonical tenant.
        const links = rows.length ? await workspaceDb.select({ issueId: teamIssues.issueId, workspaceId: teamIssues.workspaceId })
          .from(teamIssues).where(inArray(teamIssues.issueId, rows.map(row => row.id))) : []
        const linked = new Map(links.map(link => [link.issueId, link.workspaceId]))
        const readable = (row: typeof rows[number]) => !linked.has(row.id) || linked.get(row.id) === row.workspaceId
        const visible = tasks.filter(readable)
        if (!visible.length) return {}
        const ids = visible.map(task => task.id)
        const byId = new Map(visible.map(task => [task.id, task]))
        const status = new Map(rows.filter(readable).map(task => [task.id, task.status]))
        const { rows: runs } = await client.query<BlockRun & { issueId: string }>(`
          SELECT DISTINCT ON ("issueId") "issueId",id AS "runId",status,outcome
          FROM agent_runs WHERE "issueId"=ANY($1::uuid[]) AND "userId"=$2 AND "workspaceId"=$3
          ORDER BY "issueId","createdAt" DESC,id DESC`, [ids, reader.id, workspaceId])
        const runByIssue = new Map(runs.map(run => [run.issueId, run]))
        // Select the newest row first; a rejected source must not resurrect an
        // older Factory state. This is the same source/user-message/Bot proof as
        // the Factory reader, with the canonical Bot tenant checked explicitly.
        const { rows: factories } = await client.query<FactoryStateRow>(`
          SELECT DISTINCT ON (t."issueId") t.id,t."issueId",t."userId",t."workspaceId",t.stage,t.status,
            EXISTS(SELECT 1 FROM coordinator_events e WHERE e.id=t."sourceEventId" AND e."userId"=t."userId"
              AND e.kind='user_message' AND e."botId" IS NOT DISTINCT FROM t."botId"
              AND (e."issueId" IS NULL OR e."issueId"=t."issueId")
              AND (t."botId" IS NULL OR EXISTS(SELECT 1 FROM bots b WHERE b.id=t."botId"
                AND b."ownerId"=t."userId" AND b."workspaceId"=t."workspaceId"))) AS "sourceAllowed"
          FROM factory_tasks t WHERE t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND t."workspaceId"=$3
          ORDER BY t."issueId",t."updatedAt" DESC,t.id DESC`, [ids, reader.id, workspaceId])
        const authorized = factories.filter(task => task.sourceAllowed && factoryScopeAllows(task, byId.get(task.issueId)))
        const flows = await readFactoryFlowStates(client, authorized)
        const flowByIssue = new Map(authorized.map(task => [task.issueId, flows.get(task.id)]))
        return Object.fromEntries(visible.map(task => [task.id, taskPresentation({
          status: z.enum(ISSUE_STATUS_CODES).parse(task.status), metadata: task.metadata,
        }, runByIssue.get(task.id), flowByIssue.get(task.id) ?? null,
        id => !['done', 'canceled', 'duplicate'].includes(status.get(id) ?? 'todo'))]))
      })
      await client.query('COMMIT')
      return { version: 1, workspaceId, items }
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  })
}
