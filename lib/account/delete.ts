import 'server-only'
import type { PoolClient } from 'pg'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { getTableName, type Table } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import * as workspaceSchema from '@/lib/db/workspace-schema'
import * as teamSchema from '@/lib/db/team-schema'
import * as projectSchema from '@/lib/db/project-schema'

const { workspaces, workspaceMembers, workspaceInvitations } = workspaceSchema
const { teams, teamMembers, teamIssues, teamProjects, teamIssueCreateReceipts, teamIssuePromotionReceipts } = teamSchema
const { projects, projectEvents } = projectSchema

/**
 * 「删除账户」. What goes and what stays (docs/settings-backend/account.md):
 *
 * - Every row the person owns in the main database goes: found by its owner
 *   column (OWNER_COLUMNS) in every table, so a table added later is covered
 *   without touching this file. That is their Bots and threads, chats, tasks,
 *   memory, saved logins, model subscriptions, connections, devices, artifacts
 *   and captures, then the user row, whose foreign keys take sessions, sign-in
 *   accounts, OAuth grants, avatar and export links with it.
 * - A workspace only they belong to goes with them. In a workspace shared with
 *   others they lose their membership; the team's issues, projects and group
 *   chats stay for the team (their past group messages stay in those chats).
 *   If they are its only active admin, nothing is deleted: someone else has to
 *   be made admin first.
 * - Uploaded files in R2 are removed after the database commits.
 */

/** Columns that name the row's owner, in any table. */
export const OWNER_COLUMNS = ['userId', 'ownerId', 'owner_id', 'user_id'] as const

/** Tables the main transaction must not touch, and why. */
const SKIPPED = new Map<string, string>([
  // Workspace tables live in the workspace database (lib/workspace-db.ts), handled below under their own lock.
  ...[workspaces, workspaceMembers, workspaceInvitations, teams, teamMembers, teamIssues, teamProjects, teamIssueCreateReceipts, teamIssuePromotionReceipts, projects, projectEvents]
    .map(table => [getTableName(table as Table), 'workspace database'] as [string, string]),
  // Handled explicitly below: team issues in shared workspaces stay.
  ['issues', 'special'], ['issue_documents', 'special'], ['issue_versions', 'special'], ['issue_members', 'special'],
  ['conversations', 'special'],
  // Taken by the user row's foreign key.
  ['user', 'user row'],
  ['account_deletion_jobs', 'durable deletion receipt'],
  ['account_deletion_guards', 'restore suppression tombstone'],
])
/**
 * Append-only skill-evaluation ledgers: triggers reject every DELETE
 * (drizzle/20261029044007_self_improvement.sql). They hold evaluation
 * evidence, not the person's content, and cannot be removed here.
 */
const IMMUTABLE_PREFIX = 'improvement_'

export type AccountDeletion =
  | { ok: true }
  | { ok: false; soleAdminOf: string[] }
  | { ok: false; pending: true; id: string; stage: string }

export interface Plan {
  /** Workspaces only this person belongs to: they go entirely. */
  solo: string[]
  /** Workspaces shared with others: only the membership goes. */
  shared: string[]
  /** Team issues of shared workspaces: they stay. */
  keptIssueIds: string[]
  keptProjectIds: string[]
}

type WorkspaceTx = Pick<typeof workspaceDb, 'select' | 'delete'>

/** Checks, then deletes the account and everything it owns. The caller has verified the session and the typed email. */
export async function deleteAccount(userId: string, email: string, options: import('./deletion-jobs').AccountDeletionOptions = {}): Promise<AccountDeletion> {
  const { requestAccountDeletion, resumeAccountDeletion } = await import('./deletion-jobs')
  const requested = await requestAccountDeletion(userId, email, undefined, options)
  if (!requested.ok) return requested
  const job = await resumeAccountDeletion(requested.id, options)
  return job.stage === 'completed' ? { ok: true } : { ok: false, pending: true, id: job.id, stage: job.stage }
}

export async function planWorkspaces(wtx: WorkspaceTx, userId: string): Promise<Plan | { soleAdminOf: string[] }> {
  const memberships = await wtx.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers).where(eq(workspaceMembers.userId, userId))
  const owned = await wtx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, userId))
  const ids = [...new Set([...memberships.map(row => row.workspaceId), ...owned.map(row => row.id)])].sort()
  if (!ids.length) return { solo: [], shared: [], keptIssueIds: [], keptProjectIds: [] }
  // Same lock order as role changes (lib/workspace-access.ts requireWorkspace): the workspace row first.
  const locked = await wtx.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, ids)).orderBy(workspaces.id).for('update')
  const others = await wtx.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers).where(and(inArray(workspaceMembers.workspaceId, ids), ne(workspaceMembers.userId, userId)))
  const solo: string[] = [], shared: string[] = [], soleAdminOf: string[] = []
  for (const workspace of locked) {
    const rest = others.filter(row => row.workspaceId === workspace.id)
    if (!rest.length) { solo.push(workspace.id); continue }
    shared.push(workspace.id)
    const mine = memberships.find(row => row.workspaceId === workspace.id)
    const anotherAdmin = rest.some(row => row.role === 'admin' && row.status === 'active')
    if (mine?.role === 'admin' && mine.status === 'active' && !anotherAdmin) soleAdminOf.push(workspace.name)
  }
  if (soleAdminOf.length) return { soleAdminOf }
  const keptIssueIds = shared.length
    ? (await wtx.select({ id: teamIssues.issueId }).from(teamIssues).where(inArray(teamIssues.workspaceId, shared))).map(row => row.id) : []
  const keptProjectIds = shared.length
    ? [...new Set((await wtx.select({ id: teamProjects.projectId }).from(teamProjects).where(inArray(teamProjects.workspaceId, shared))).map(row => row.id))] : []
  return { solo, shared, keptIssueIds, keptProjectIds }
}

export async function deleteWorkspaceData(wtx: WorkspaceTx, userId: string, emailHash: string, plan: Plan) {
  if (plan.solo.length) {
    const soloTeams = wtx.select({ id: teams.id }).from(teams).where(inArray(teams.workspaceId, plan.solo))
    await wtx.delete(teamMembers).where(inArray(teamMembers.teamId, soloTeams))
    await wtx.delete(teamIssues).where(inArray(teamIssues.workspaceId, plan.solo))
    await wtx.delete(teamProjects).where(inArray(teamProjects.workspaceId, plan.solo))
    await wtx.delete(teamIssueCreateReceipts).where(inArray(teamIssueCreateReceipts.workspaceId, plan.solo))
    await wtx.delete(teamIssuePromotionReceipts).where(inArray(teamIssuePromotionReceipts.workspaceId, plan.solo))
    await wtx.delete(teams).where(inArray(teams.workspaceId, plan.solo))
    await wtx.delete(workspaceInvitations).where(inArray(workspaceInvitations.workspaceId, plan.solo))
    await wtx.delete(workspaceMembers).where(inArray(workspaceMembers.workspaceId, plan.solo))
    await wtx.delete(workspaces).where(inArray(workspaces.id, plan.solo))
  }
  await wtx.delete(teamMembers).where(eq(teamMembers.userId, userId))
  await wtx.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId))
  await wtx.delete(workspaceInvitations).where(and(sql`encode(sha256(convert_to(lower(${workspaceInvitations.email}), 'UTF8')), 'hex') = ${emailHash}`, eq(workspaceInvitations.status, 'pending')))
  const kept = plan.keptProjectIds
  await wtx.delete(projectEvents).where(kept.length ? and(eq(projectEvents.userId, userId), sql`not (${projectEvents.projectId} = any(${kept}::uuid[]))`) : eq(projectEvents.userId, userId))
  await wtx.delete(projects).where(kept.length ? and(eq(projects.userId, userId), sql`not (${projects.id} = any(${kept}::uuid[]))`) : eq(projects.userId, userId))
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Statement { table: string; text: string; values: unknown[] }

/** Object references are captured in the same transaction that removes their rows. */
export async function accountStorageKeys(client: Pick<PoolClient, 'query'>, userId: string): Promise<{ keys: string[]; notBefore: Date }> {
  const { rows } = await client.query<{ key: string; expiresAt: Date | null }>(
    `select v."storageKey" as key,NULL::timestamptz as "expiresAt" from artifact_versions v join artifacts a on a.id=v."artifactId" where a."userId"=$1 and v."storageKey" is not null
     union all select "storageKey","expiresAt" from run_captures where "userId"=$1 and "storageKey" is not null
     union all select 'capture-uploads/' || "userId" || '/runs/' || "runId" || '/captures/' || id || '.' ||
       CASE "contentType" WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' WHEN 'video/mp4' THEN 'mp4' WHEN 'video/webm' THEN 'webm' END,"expiresAt"
       from run_captures where "userId"=$1 AND source='local' AND "expiresAt" IS NOT NULL
     union all select "storageKey",NULL from user_avatars where "userId"=$1 and "storageKey" is not null
     union all select "storageKey",NULL from account_storage_retirements where "userId"=$1`, [userId])
  return { keys: [...new Set(rows.map(row => row.key).filter((key): key is string => Boolean(key)))], notBefore: new Date(Math.max(Date.now(), ...rows.map(row => row.expiresAt?.getTime() ?? 0))) }
}

export async function deleteMainAccountData(client: PoolClient, userId: string, plan: Plan): Promise<void> {
  await runToFixpoint(client, await deletionStatements(client, userId, plan))
  await client.query('delete from "user" where id=$1', [userId])
}

/** Every delete the account needs in the main database, in no particular order. */
export async function deletionStatements(client: Pick<PoolClient, 'query'>, userId: string, plan: Pick<Plan, 'shared' | 'keptIssueIds'>): Promise<Statement[]> {
  const { rows: owned } = await client.query<{ table: string; column: string }>(
    `select c.table_name as "table", c.column_name as "column" from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = any($1::text[])
     order by 1, 2`, [OWNER_COLUMNS])
  const ownedTables = owned.filter(row => !SKIPPED.has(row.table) && !row.table.startsWith(IMMUTABLE_PREFIX))
  const ownerColumn = new Map(ownedTables.map(row => [row.table, row.column]))
  // Rows elsewhere that point at the person's rows without ON DELETE CASCADE
  // (byos_native_runs → byos_bindings, factory_publications → factory_approvals…)
  // would stop those deletes; they go first.
  const { rows: references } = await client.query<{ child: string; childColumn: string; parent: string; parentColumn: string }>(
    `select ch.relname as child, ca.attname as "childColumn", pa.relname as parent, pc.attname as "parentColumn"
     from pg_constraint k
     join pg_class ch on ch.oid = k.conrelid join pg_namespace n on n.oid = ch.relnamespace
     join pg_class pa on pa.oid = k.confrelid
     join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = k.conkey[1]
     join pg_attribute pc on pc.attrelid = k.confrelid and pc.attnum = k.confkey[1]
     where k.contype = 'f' and k.confdeltype in ('a', 'r') and array_length(k.conkey, 1) = 1 and n.nspname = current_schema()`)
  const statements: Statement[] = []
  for (const ref of references) {
    const parentOwner = ownerColumn.get(ref.parent)
    if (!parentOwner || ownerColumn.has(ref.child) || SKIPPED.has(ref.child) || ref.child.startsWith(IMMUTABLE_PREFIX)) continue
    statements.push({
      table: ref.child, values: [userId],
      text: `delete from ${ident(ref.child)} where ${ident(ref.childColumn)} in (select ${ident(ref.parentColumn)} from ${ident(ref.parent)} where ${ident(parentOwner)} = $1)`,
    })
  }
  for (const { table, column } of ownedTables) statements.push({ table, values: [userId], text: `delete from ${ident(table)} where ${ident(column)} = $1` })
  const kept = plan.keptIssueIds
  statements.push(
    { table: 'issue_documents', values: [userId, kept], text: 'delete from issue_documents where "userId" = $1 and not ("issueId" = any($2::uuid[]))' },
    { table: 'issue_versions', values: [userId, kept], text: 'delete from issue_versions where "userId" = $1 and not ("issueId" = any($2::uuid[]))' },
    { table: 'issue_members', values: [userId, kept], text: 'delete from issue_members where ("userId" = $1 and not ("issueId" = any($2::uuid[]))) or "memberId" = $1' },
    { table: 'issues', values: [userId, kept], text: 'delete from issues where "userId" = $1 and not (id = any($2::uuid[]))' },
    { table: 'conversation_members', values: [userId], text: `delete from conversation_members where "memberType" = 'user' and "memberId" = $1` },
    {
      // A group chat in a shared workspace stays while anyone else is in it.
      table: 'conversations', values: [userId, plan.shared],
      text: `delete from conversations c where c."createdBy" = $1 and not (
        c.kind = 'group' and c."workspaceId" = any($2::uuid[])
        and exists (select 1 from conversation_members m where m."conversationId" = c.id and m."memberType" = 'user' and m."memberId" <> $1 and m."leftAt" is null))`,
    },
  )
  return statements
}

/**
 * Runs the deletes until none is left. A delete that still has rows pointing
 * at it (a foreign key without ON DELETE CASCADE) waits for the next pass,
 * after the rows that point at it are gone. A pass that clears nothing means
 * something outside this account holds on to it: the whole deletion stops.
 */
export async function runToFixpoint(client: Pick<PoolClient, 'query'>, statements: Statement[]): Promise<void> {
  let pending = statements
  while (pending.length) {
    const blocked: Statement[] = []
    for (const statement of pending) {
      await client.query('savepoint account_delete_step')
      try {
        await client.query(statement.text, statement.values)
        await client.query('release savepoint account_delete_step')
      } catch (error) {
        await client.query('rollback to savepoint account_delete_step')
        if ((error as { code?: string }).code !== '23503') throw error
        blocked.push(statement)
      }
    }
    if (blocked.length === pending.length) throw new Error(`account deletion blocked by references into: ${[...new Set(blocked.map(item => item.table))].join(', ')}`)
    pending = blocked
  }
}
