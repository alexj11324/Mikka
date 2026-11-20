import 'server-only'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, workspaceIssueStates } from '@/lib/db/schema'
import { WorkspaceError } from '@/lib/workspace-access'
import { workspaceListChanged } from '@/lib/live/lists'
import type { ActivityActor } from '@/lib/activity-actor'
import type { IssueStatus } from '@/lib/issue-meta'
import { issueStateType, type CreateIssueStateInput, type DeleteIssueStateInput, type IssueStateIcon, type IssueStateView, type ReorderIssueStatesInput, type SetDefaultIssueStateInput, type UpdateIssueStateInput } from '@/lib/issue-states'
import type { MarkTone } from '@/lib/state-mark'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Executor = typeof db | Transaction

const POSITION_STEP = 1000

/** Seeds the seven built-in states the first time a workspace is read (the migration seeded workspaces with tasks). */
export async function ensureIssueStates(executor: Executor, workspaceId: string): Promise<void> {
  await executor.execute(sql`select mikka_ensure_issue_states(${workspaceId}::uuid)`)
}

/** The workspace's states in their order, with how many tasks each holds. */
export async function listIssueStates(executor: Executor, workspaceId: string): Promise<IssueStateView[]> {
  await ensureIssueStates(executor, workspaceId)
  const counts = executor.select({ stateId: issues.stateId, count: sql<number>`count(*)::int`.as('count') }).from(issues)
    .where(eq(issues.workspaceId, workspaceId)).groupBy(issues.stateId).as('counts')
  const rows = await executor.select({
    id: workspaceIssueStates.id, name: workspaceIssueStates.name, icon: workspaceIssueStates.icon, color: workspaceIssueStates.color,
    category: workspaceIssueStates.category, type: workspaceIssueStates.type, isDefault: workspaceIssueStates.isDefault,
    position: workspaceIssueStates.position, taskCount: sql<number>`coalesce(${counts.count}, 0)`,
  }).from(workspaceIssueStates).leftJoin(counts, eq(counts.stateId, workspaceIssueStates.id))
    .where(eq(workspaceIssueStates.workspaceId, workspaceId)).orderBy(asc(workspaceIssueStates.position), asc(workspaceIssueStates.createdAt))
  return rows.map(row => ({ ...row, icon: row.icon as IssueStateIcon, color: row.color as MarkTone, category: row.category as IssueStatus, taskCount: Number(row.taskCount) }))
}

async function lockedState(tx: Transaction, workspaceId: string, id: string) {
  const [state] = await tx.select().from(workspaceIssueStates)
    .where(and(eq(workspaceIssueStates.workspaceId, workspaceId), eq(workspaceIssueStates.id, id))).for('update')
  if (!state) throw new WorkspaceError('issueStateNotFound')
  return state
}

const NAME_TAKEN = 'workspace_issue_states_name_idx'
function isNameTaken(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === 'object'; current = (current as { cause?: unknown }).cause) {
    if ((current as { constraint?: string }).constraint === NAME_TAKEN) return true
  }
  return false
}

async function changed(tx: Transaction, workspaceId: string, tasksMoved = false) {
  await workspaceListChanged(tx, workspaceId, tasksMoved ? ['workspace_settings', 'issue_list'] : ['workspace_settings'])
}

async function write<T>(workspaceId: string, body: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async tx => {
      await ensureIssueStates(tx, workspaceId)
      // One writer per workspace's state list at a time, so positions and defaults stay consistent.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-states:${workspaceId}`}, 0))`)
      return body(tx)
    })
  } catch (error) {
    if (isNameTaken(error)) throw new WorkspaceError('issueStateNameTaken', { cause: error })
    throw error
  }
}

/** New state at the end of its type's group (Open or Closed). Never the default; set that separately. */
export async function createIssueState(input: CreateIssueStateInput): Promise<{ id: string }> {
  return write(input.workspaceId, async tx => {
    const type = issueStateType(input.category)
    const [last] = await tx.select({ position: sql<number>`coalesce(max(${workspaceIssueStates.position}), 0)` }).from(workspaceIssueStates)
      .where(and(eq(workspaceIssueStates.workspaceId, input.workspaceId), eq(workspaceIssueStates.type, type)))
    const [created] = await tx.insert(workspaceIssueStates).values({
      workspaceId: input.workspaceId, name: input.name, icon: input.icon, color: input.color, category: input.category, type,
      position: Number(last?.position ?? 0) + POSITION_STEP,
    }).returning({ id: workspaceIssueStates.id })
    await changed(tx, input.workspaceId)
    return created
  })
}

export async function updateIssueState(input: UpdateIssueStateInput): Promise<void> {
  await write(input.workspaceId, async tx => {
    await lockedState(tx, input.workspaceId, input.id)
    const values = Object.fromEntries(Object.entries({ name: input.name, icon: input.icon, color: input.color }).filter(([, value]) => value !== undefined))
    if (!Object.keys(values).length) return
    await tx.update(workspaceIssueStates).set({ ...values, updatedAt: new Date() }).where(eq(workspaceIssueStates.id, input.id))
    await changed(tx, input.workspaceId, true)
  })
}

/** `ids` is the whole list in its new order; a list that is not exactly the workspace's states is refused. */
export async function reorderIssueStates(input: ReorderIssueStatesInput): Promise<void> {
  await write(input.workspaceId, async tx => {
    const current = await tx.select({ id: workspaceIssueStates.id }).from(workspaceIssueStates).where(eq(workspaceIssueStates.workspaceId, input.workspaceId))
    const known = new Set(current.map(row => row.id))
    if (new Set(input.ids).size !== input.ids.length || input.ids.length !== known.size || input.ids.some(id => !known.has(id))) throw new WorkspaceError('issueStateNotFound')
    await tx.execute(sql`update workspace_issue_states s set position = o.n * ${POSITION_STEP}, updated_at = now()
      from unnest(${sql.param(input.ids)}::uuid[]) with ordinality as o(id, n) where s.id = o.id and s.workspace_id = ${input.workspaceId}::uuid`)
    await changed(tx, input.workspaceId, true)
  })
}

/** Makes the state its category's default: where automatic moves and status-only writes land. */
export async function setDefaultIssueState(input: SetDefaultIssueStateInput): Promise<void> {
  await write(input.workspaceId, async tx => {
    const state = await lockedState(tx, input.workspaceId, input.id)
    if (state.isDefault) return
    await tx.update(workspaceIssueStates).set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(workspaceIssueStates.workspaceId, input.workspaceId), eq(workspaceIssueStates.category, state.category), eq(workspaceIssueStates.isDefault, true)))
    await tx.update(workspaceIssueStates).set({ isDefault: true, updatedAt: new Date() }).where(eq(workspaceIssueStates.id, input.id))
    await changed(tx, input.workspaceId)
  })
}

/**
 * Capy's MoveAndDelete: every task in the state moves to `moveTo` (each move versioned for `actor`), then the
 * state is deleted. A category's default cannot be deleted: make another state the default first.
 */
export async function deleteIssueState(input: DeleteIssueStateInput, actor: ActivityActor): Promise<{ moved: number }> {
  return write(input.workspaceId, async tx => {
    if (input.id === input.moveTo) throw new WorkspaceError('issueStateMoveTargetInvalid')
    const state = await lockedState(tx, input.workspaceId, input.id)
    if (state.isDefault) throw new WorkspaceError('issueStateDefaultLocked')
    const target = await lockedState(tx, input.workspaceId, input.moveTo)
    const moved = await tx.execute<{ issueId: string }>(sql`with moved as (
      update issues set state_id = ${target.id}::uuid, status = ${target.category}, revision = revision + 1, "updatedAt" = now()
      where "workspaceId" = ${input.workspaceId}::uuid and state_id = ${state.id}::uuid
      returning id, "userId", revision, title, content, status, priority
    )
    insert into issue_versions (id, "issueId", "userId", revision, title, content, status, priority, actor_type, actor_id)
    select gen_random_uuid(), id, "userId", revision, title, content, status, priority, ${actor.actorType}, ${actor.actorId} from moved
    returning "issueId"`)
    await tx.delete(workspaceIssueStates).where(and(eq(workspaceIssueStates.id, state.id), ne(workspaceIssueStates.isDefault, true)))
    await changed(tx, input.workspaceId, true)
    return { moved: moved.rows.length }
  })
}

/** A state of the workspace, or null; for writers that take a state id from the client. */
export async function readIssueState(executor: Executor, workspaceId: string, id: string): Promise<{ id: string; category: IssueStatus } | null> {
  const [state] = await executor.select({ id: workspaceIssueStates.id, category: workspaceIssueStates.category }).from(workspaceIssueStates)
    .where(and(eq(workspaceIssueStates.workspaceId, workspaceId), eq(workspaceIssueStates.id, id))).limit(1)
  return state ? { id: state.id, category: state.category as IssueStatus } : null
}
