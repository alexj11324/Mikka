import 'server-only'
import type { PoolClient } from 'pg'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { getTableName, type Table } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import * as workspaceSchema from '@/lib/db/workspace-schema'
import * as teamSchema from '@/lib/db/team-schema'
import * as projectSchema from '@/lib/db/project-schema'
import { organizationMembers } from '@/lib/db/governance-schema'
import { GovernanceError } from '@/lib/governance/errors'
import { lockAccountOrganizationOwnership } from '@/lib/governance/organization-ownership'
import { enqueueOrganizationAudit } from '@/lib/governance/audit'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { workspaceListScopesBeforeChange, workspaceListScopeChanged, workspaceListChanged } from '@/lib/live/lists'

const { workspaces, workspaceMembers, workspaceInvitations } = workspaceSchema
const { teams, teamMembers, teamIssues, teamProjects, teamIssueCreateReceipts, teamIssuePromotionReceipts } = teamSchema
const { projects, projectEvents, projectMembers, projectTasks } = projectSchema

/**
 * 「删除账户」. What goes and what stays (docs/settings-backend/account.md):
 *
 * - Every row the person owns in the main database goes: found by its owner
 *   column (OWNER_COLUMNS) in every table, so a table added later is covered
 *   without touching this file. That is their chats, tasks, memory, saved
 *   logins, model subscriptions, connections, devices, artifacts and captures,
 *   their Coordinator and every bot outside a shared workspace with its
 *   threads, then the user row, whose foreign keys take sessions, sign-in
 *   accounts, OAuth grants, avatar and export links with it.
 * - A workspace only they belong to goes with them, with every main-database
 *   row keyed by it (lib/workspace-rows.ts). In a workspace shared with
 *   others they lose their membership; the team's issues, projects and group
 *   chats stay for the team (their past group messages stay in those chats).
 *   If they are its only active admin, nothing is deleted: someone else has to
 *   be made admin first.
 * - Their bots in a shared workspace are handled as when a member leaves
 *   (releaseDepartingMember, decision 2026-11-02-0231): each is paused for an
 *   admin to take over (已暂停的 Bot), and its threads stay with it (KEPT_THREAD_TABLES).
 *   Its owner becomes NULL, 「待接管」, which matches nobody until takeOverBot
 *   writes the new owner. The rows bound to the old owner (desktops, cloud
 *   runtimes, run bindings, agent kit, background tasks) go first, as on a transfer.
 * - Uploaded files in R2 are removed after the database commits, except those
 *   of the threads that stay.
 */

/** Columns that name the row's owner, in any table. */
export const OWNER_COLUMNS = ['userId', 'ownerId', 'owner_id', 'user_id'] as const

/** Tables the main transaction must not touch, and why. */
const SKIPPED = new Map<string, string>([
  // Workspace tables live in the workspace database (lib/workspace-db.ts), handled below under their own lock.
  ...[workspaces, workspaceMembers, workspaceInvitations, teams, teamMembers, teamIssues, teamProjects, teamIssueCreateReceipts, teamIssuePromotionReceipts, projects, projectEvents, projectMembers, projectTasks]
    .map(table => [getTableName(table as Table), 'workspace database'] as [string, string]),
  ['mikka_task_identifier_aliases', 'workspace history, removed only with its workspace'],
  // Handled explicitly below: team issues in shared workspaces stay.
  ['issues', 'special'], ['issue_documents', 'special'], ['issue_versions', 'special'], ['issue_members', 'special'],
  ['conversations', 'special'],
  // Taken by the user row's foreign key.
  ['user', 'user row'],
  ['account_deletion_jobs', 'durable deletion receipt'],
  ['account_deletion_guards', 'restore suppression tombstone'],
  // Org configuration belongs to the Org; userId records only its creator.
  // The original Auth FK clears that attribution when the user row is deleted.
  ['enterprise_sso_provider', 'organization configuration'],
  // The SCIM directory is Org-owned. Its original FK clears the account link;
  // pending delivery then records pending_link without recreating membership.
  ['enterprise_scim_user', 'organization directory'],
  ['mikka_organization_members', 'workspace database'],
  ['resource_access_policies', 'authority follows retained source rows; source deletion triggers retire it'],
  ['resource_access_events', 'append-only access audit; contains no content or credential values'],
])
/**
 * Append-only skill-evaluation ledgers: triggers reject every DELETE
 * (drizzle/20261029044007_self_improvement.sql). They hold evaluation
 * evidence, not the person's content, and cannot be removed here.
 */
const IMMUTABLE_PREFIX = 'improvement_'

/**
 * A kept thread's own rows, which stay with it. Any other row the person owns
 * that points at a kept thread still goes: run tokens, computer bindings and
 * thread machines are their credentials and machines, not the thread.
 */
const KEPT_THREAD_TABLES = ['run_messages', 'run_checkpoints', 'run_captures', 'run_publications', 'artifacts', 'agent_tool_approvals', 'coordinator_events',
  'coding_workspace_bindings', 'coding_workspace_snapshots', 'coding_workspace_checkpoint_reviews'] as const
const KEPT_FACTORY_TABLES = ['factory_evidence_reads', 'factory_approvals', 'factory_approval_controls',
  'factory_monitor_incidents', 'factory_monitor_observations', 'factory_merges', 'factory_deliverable_acceptances',
  'factory_questions', 'factory_spec_approvals'] as const

/** Kept tenant history is independent of a Bot or a former membership.
 * These ids retain data only; every credential and execution lease still goes. */
export interface KeptThreads { bots: string[]; runs: string[]; agents: string[]; artifacts: string[]; factoryTasks: string[]; events: string[]; mailboxes: string[] }
type TaskRetention = Pick<Plan, 'solo' | 'shared' | 'keptIssueIds'>

export async function keptThreads(client: Pick<PoolClient, 'query'>, userId: string, plan: TaskRetention): Promise<KeptThreads> {
  const bots = (await client.query<{ id: string }>(
    `select b.id from bots b where b."ownerId" = $1 and not (b."workspaceId" = any($2::uuid[]))
     and not exists (select 1 from coordinator_bots cb where cb."botId" = b.id) order by b.id`, [userId, plan.solo])).rows.map(row => row.id)
  // Task rows are already locked by freezeTaskRetention. A departed member's
  // bound tenant still owns their history; the membership list is not provenance.
  const runs = (await client.query<{ id: string; agentId: string }>(
    `select r.id,r."agentId" from agent_runs r
     where r."issueId" = any($2::uuid[])
        or (r."userId" = $1 and r."workspaceId" is not null and not (r."workspaceId" = any($3::uuid[]))
          and not exists (select 1 from coordinator_bots cb where cb."botId" = r."botId"))
        or r."botId" = any($4::uuid[])
     order by r.id for update of r`, [userId, plan.keptIssueIds, plan.solo, bots])).rows
  const runIds = runs.map(row => row.id)
  const artifacts = (await client.query<{ id: string }>(
    `select a.id from artifacts a where a."userId" = $1 and (
       a."runId" = any($2::uuid[]) or a."issueId" = any($3::uuid[])
       or (a."workspaceId" is not null and not (a."workspaceId" = any($4::uuid[]))))
     order by a.id for update of a`, [userId, runIds, plan.keptIssueIds, plan.solo])).rows.map(row => row.id)
  const factoryTasks = (await client.query<{ id: string }>(
    `select t.id from factory_tasks t where t."userId" = $1 and (
       t."issueId" = any($2::uuid[]) or (t."workspaceId" is not null and not (t."workspaceId" = any($3::uuid[]))))
     order by t.id`, [userId, plan.keptIssueIds, plan.solo])).rows.map(row => row.id)
  const events = runIds.length || factoryTasks.length ? (await client.query<{ id: string }>(
    `select e.id from coordinator_events e where e."userId"=$1 and (
       e."runId"=any($2::uuid[])
       or e.id in (select "sourceEventId" from factory_tasks where id=any($3::uuid[]))
       or e.id in (select unnest(array["sourceEventId","escalationEventId","answerSourceEventId"])
         from factory_questions where "taskId"=any($3::uuid[]))) order by e.id`, [userId, runIds, factoryTasks])).rows.map(row => row.id) : []
  // A mailbox is a history parent, not an execution credential. Preserve the
  // parents referenced by retained runs/messages, then disable their wake path.
  const mailboxes = runIds.length ? (await client.query<{ id: string }>(
    `select m.id from session_mailboxes m where m."userId"=$1 and (
       m."latestRunId"=any($2::uuid[])
       or m.id in (select "mailboxId" from agent_runs where id=any($2::uuid[]))
       or m.id in (select unnest(array["mailboxId","senderMailboxId"]) from run_messages where "runId"=any($2::uuid[])))
     order by m.id for update of m`, [userId, runIds])).rows.map(row => row.id) : []
  return { bots, runs: runIds, agents: [...new Set(runs.map(row => row.agentId))], artifacts, factoryTasks, events, mailboxes }
}

/** The rows of `table` that stay, as a condition on $2. */
function keptCondition(table: string, kept: KeptThreads): { sql: string; ids: string[] } | null {
  if (table === 'bots') return { sql: 'id = any($2::uuid[])', ids: kept.bots }
  if (table === 'agent_runs') return { sql: 'id = any($2::uuid[])', ids: kept.runs }
  if (table === 'agents') return { sql: 'id = any($2::uuid[])', ids: kept.agents }
  if (table === 'artifacts') return { sql: 'id = any($2::uuid[])', ids: kept.artifacts }
  if (table === 'run_capture_steps') return { sql: '"captureId" in (select id from run_captures where "runId" = any($2::uuid[]))', ids: kept.runs }
  if (table === 'factory_tasks') return { sql: 'id = any($2::uuid[])', ids: kept.factoryTasks }
  if ((KEPT_FACTORY_TABLES as readonly string[]).includes(table)) return { sql: '"taskId" = any($2::uuid[])', ids: kept.factoryTasks }
  if (table === 'coordinator_events') return { sql: 'id = any($2::uuid[])', ids: kept.events }
  if (table === 'session_mailboxes') return { sql: 'id = any($2::uuid[])', ids: kept.mailboxes }
  if (table === 'operation_ledger') return { sql: '"runId"::text = any($2::text[]) or binding->>\'executionRunId\' = any($2::text[])', ids: kept.runs }
  if ((KEPT_THREAD_TABLES as readonly string[]).includes(table)) return { sql: '"runId" is not null and "runId" = any($2::uuid[])', ids: kept.runs }
  return null
}

export type AccountDeletion =
  | { ok: true; receipt?: { id: string; warnings: string[] } }
  | { ok: false; soleAdminOf: string[] }
  | { ok: false; pending: true; id: string; stage: string }

export interface Plan {
  /** Workspaces only this person belongs to: they go entirely. */
  solo: string[]
  /** Workspaces shared with others: only the membership goes. */
  shared: string[]
  /** Frozen from persisted APP task tenancy under row locks before deletion. */
  keptIssueIds: string[]
  keptProjectIds: string[]
}
/** Durable deletion receipts written before Project v2 do not carry this field. */
type CompatiblePlan = Omit<Plan, 'keptProjectIds'> & { keptProjectIds?: string[] }

type WorkspaceTx = Pick<typeof workspaceDb, 'select' | 'delete' | 'execute' | 'update'>

async function retainedWorkspaceProjects(wtx: WorkspaceTx, userId: string, solo: string[], shared: string[]) {
  return (await wtx.select({ id: projects.id }).from(projects)
    .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(or(
      // Quarantine is not proof of personal ownership. Keep its repair evidence
      // inaccessible until a trusted assignment decides the tenant lifecycle.
      and(isNull(projects.workspaceId), eq(projects.userId, userId)),
      and(eq(workspaces.kind, 'team'), solo.length ? sql`not (${workspaces.id} = any(${sql.param(solo)}::uuid[]))` : undefined,
        sql`(${projects.userId} = ${userId} or ${projects.workspaceId} = any(${sql.param(shared)}::uuid[]))`),
    ))).map(row => row.id)
}

/** Old journals may contain an explicitly empty Team-derived Project set.
 * Reconcile it while the Workspace boundary is held, before opening APP, and
 * retain every prior keep decision without expanding the deletion set. */
export async function freezeProjectRetention(wtx: WorkspaceTx, userId: string, plan: CompatiblePlan): Promise<Plan> {
  const keptProjectIds = [...new Set([
    ...(plan.keptProjectIds ?? []), ...await retainedWorkspaceProjects(wtx, userId, plan.solo, plan.shared),
  ])].sort()
  if (keptProjectIds.length && plan.solo.length) {
    const [conflict] = await wtx.select({ id: projects.id }).from(projects)
      .where(and(inArray(projects.id, keptProjectIds), inArray(projects.workspaceId, plan.solo))).limit(1)
    if (conflict) throw new Error('accountDeletionProjectRetentionChanged')
  }
  return { ...plan, keptProjectIds }
}

/** Checks, then deletes the account and everything it owns. The caller has verified the session and the typed email. */
export async function deleteAccount(userId: string, email: string, options: import('./deletion-jobs').AccountDeletionOptions = {}): Promise<AccountDeletion> {
  const { requestAccountDeletion, resumeAccountDeletion } = await import('./deletion-jobs')
  const requested = await requestAccountDeletion(userId, email, undefined, options)
  if (!requested.ok) return requested
  const job = await resumeAccountDeletion(requested.id, options)
  if (job.stage === 'cancelled' && job.blockedReasons.includes('last_owner')) throw new GovernanceError('last_owner')
  if (job.stage === 'completed') return job.warnings.length ? { ok: true, receipt: { id: job.id, warnings: job.warnings } } : { ok: true }
  return { ok: false, pending: true, id: job.id, stage: job.stage }
}

export async function planWorkspaces(wtx: WorkspaceTx, userId: string, appTarget?: Pick<PoolClient, 'query'>): Promise<Plan | { soleAdminOf: string[] }> {
  const memberships = await wtx.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers).where(eq(workspaceMembers.userId, userId))
  const owned = await wtx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, userId))
  const ids = [...new Set([...memberships.map(row => row.workspaceId), ...owned.map(row => row.id)])].sort()
  if (!ids.length) return { solo: [], shared: [], keptIssueIds: [], keptProjectIds: await retainedWorkspaceProjects(wtx, userId, [], []) }
  // Same lock order as role changes (lib/workspace-access.ts requireWorkspace): the workspace row first.
  const locked = await wtx.select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind, ownerId: workspaces.userId }).from(workspaces).where(inArray(workspaces.id, ids)).orderBy(workspaces.id).for('update')
  const others = await wtx.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers).where(and(inArray(workspaceMembers.workspaceId, ids), ne(workspaceMembers.userId, userId)))
  const solo: string[] = [], shared: string[] = [], soleAdminOf: string[] = []
  for (const workspace of locked) {
    const rest = others.filter(row => row.workspaceId === workspace.id)
    // Migrated Personal peers are retained as suspended history. They cannot
    // administer the owner's tenant, or turn it into a shared workspace.
    if (workspace.kind === 'personal' && workspace.ownerId === userId) {
      if (rest.some(row => row.status === 'active')) soleAdminOf.push(workspace.name)
      else solo.push(workspace.id)
      continue
    }
    if (!rest.length) { solo.push(workspace.id); continue }
    shared.push(workspace.id)
    const mine = memberships.find(row => row.workspaceId === workspace.id)
    const anotherAdmin = rest.some(row => row.role === 'admin' && row.status === 'active')
    if (mine?.role === 'admin' && mine.status === 'active' && !anotherAdmin) soleAdminOf.push(workspace.name)
  }
  if (soleAdminOf.length) return { soleAdminOf }
  // Task ownership is in APP, not a Team link. Freeze that retention set only
  // after these Workspace locks and the APP task row locks have been acquired.
  const keptIssueIds: string[] = []
  // A creator's projects remain in every surviving shared tenant, including
  // ungrouped projects and workspaces they already left before deleting the account.
  const keptProjectIds = await retainedWorkspaceProjects(wtx, userId, solo, shared)
  return { solo, shared, keptIssueIds, keptProjectIds }
}

/** The deletion guard already fences new subject-owned writes. Freeze every
 * affected task under APP row locks after the Workspace plan has been locked.
 * Only a bound tenant explicitly in solo is deleted: a former membership,
 * provider scope or creator cannot turn a Shared/pending task into personal data.
 * A restore journal's prior keep decision is never silently discarded. */
async function localResourceAcl(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  // A historical restore target may predate resource ACLs and deliberately
  // use search_path=<isolated schema>,public. Never fall through into the
  // live schema's authority or audit rows while replaying deletion there.
  return (await client.query<{ present: boolean }>(`select exists(select 1 from information_schema.tables
    where table_schema=current_schema() and table_name='resource_access_policies') as present`)).rows[0]?.present === true
}

export async function freezeTaskRetention(client: Pick<PoolClient, 'query'>, userId: string, plan: Plan): Promise<Plan> {
  // Match content writers: Workspace authority is already held, then ACL,
  // then Factory/Task rows. Revoking subject grants later cannot invert this
  // order against an in-flight edit of a retained shared Task.
  if (await localResourceAcl(client)) await client.query(`select p.kind,p.id from resource_access_policies p where p."ownerId"=$1
    or exists(select 1 from resource_access_grants g where g."resourceKind"=p.kind and g."resourceId"=p.id and g."subjectKind"='account' and g."subjectId"=$1)
    or (p.kind='task' and (p.id=any($2::uuid[])
      or exists(select 1 from issue_documents d where d."issueId"=p.id and d."userId"=$1)
      or exists(select 1 from issue_versions v where v."issueId"=p.id and v."userId"=$1)
      or exists(select 1 from issue_members m where m."issueId"=p.id and m."userId"=$1)
      or exists(select 1 from agent_runs r where r."issueId"=p.id and r."userId"=$1)
      or exists(select 1 from artifacts a where a."issueId"=p.id and a."userId"=$1)
      or exists(select 1 from factory_tasks f where f."issueId"=p.id and f."userId"=$1)))
    order by p.kind,p.id for update of p`, [userId, plan.keptIssueIds])
  // Factory writers lock their task before the issue and run. The subject's
  // durable write barrier prevents new rows while this ordered set is held.
  await client.query('select id from factory_tasks where "userId"=$1 order by id for update', [userId])
  const { rows } = await client.query<{ id: string; workspaceId: string | null; ownershipState: string }>(
    `select i.id,i."workspaceId",i."ownershipState" from issues i
     where i."userId"=$1
        or exists (select 1 from issue_documents d where d."issueId"=i.id and d."userId"=$1)
        or exists (select 1 from issue_versions v where v."issueId"=i.id and v."userId"=$1)
        or exists (select 1 from issue_members m where m."issueId"=i.id and m."userId"=$1)
        or exists (select 1 from agent_runs r where r."issueId"=i.id and r."userId"=$1)
        or exists (select 1 from artifacts a where a."issueId"=i.id and a."userId"=$1)
        or exists (select 1 from factory_tasks t where t."issueId"=i.id and t."userId"=$1)
        or i.id=any($2::uuid[])
     order by i.id for update of i`, [userId, plan.keptIssueIds])
  const solo = new Set(plan.solo), kept = new Set(plan.keptIssueIds)
  for (const row of rows) {
    const deleting = row.ownershipState === 'bound' && row.workspaceId !== null && solo.has(row.workspaceId)
    if (!deleting) kept.add(row.id)
    else if (kept.has(row.id)) throw new Error('accountDeletionTaskRetentionChanged')
  }
  return { ...plan, keptIssueIds: [...kept].sort() }
}

export async function deleteWorkspaceData(wtx: WorkspaceTx, userId: string, emailHash: string, plan: CompatiblePlan) {
  const retained = await freezeProjectRetention(wtx, userId, plan)
  const previousLists = await Promise.all([...plan.solo, ...plan.shared].map(async id => ({ id, scopes: await workspaceListScopesBeforeChange(wtx, id) })))
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
    const soloProjects = wtx.select({ id: projects.id }).from(projects).where(inArray(projects.workspaceId, plan.solo))
    await wtx.delete(projectEvents).where(inArray(projectEvents.projectId, soloProjects))
    await wtx.delete(projects).where(inArray(projects.workspaceId, plan.solo))
    await wtx.delete(workspaces).where(inArray(workspaces.id, plan.solo))
  }
  await wtx.delete(projectMembers).where(eq(projectMembers.userId, userId))
  await wtx.update(projects).set({ leadUserId: null }).where(eq(projects.leadUserId, userId))
  await wtx.delete(teamMembers).where(eq(teamMembers.userId, userId))
  await wtx.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId))
  await wtx.delete(workspaceInvitations).where(and(sql`encode(sha256(convert_to(lower(${workspaceInvitations.email}), 'UTF8')), 'hex') = ${emailHash}`, eq(workspaceInvitations.status, 'pending')))
  const kept = retained.keptProjectIds
  const deletedProjects = wtx.select({ id: projects.id }).from(projects)
    .where(kept.length ? and(eq(projects.userId, userId), sql`not (${projects.id} = any(${sql.param(kept)}::uuid[]))`) : eq(projects.userId, userId))
  // Activity belongs to its Project. Authorship alone must not erase another
  // member's shared project history when the author removes their account.
  await wtx.delete(projectEvents).where(inArray(projectEvents.projectId, deletedProjects))
  await wtx.delete(projects).where(kept.length ? and(eq(projects.userId, userId), sql`not (${projects.id} = any(${sql.param(kept)}::uuid[]))`) : eq(projects.userId, userId))
  for (const previous of previousLists) await workspaceListScopeChanged(wtx, previous.id, previous.scopes)
  // Canonical Workspace membership is cleaned here, including split-store
  // retries after the APP user has gone. Historical Org audit rows stay.
  await lockAccountOrganizationOwnership(wtx, userId)
  const removed = await wtx.delete(organizationMembers).where(eq(organizationMembers.userId, userId)).returning({ organizationId: organizationMembers.organizationId })
  for (const { organizationId } of removed) await enqueueOrganizationAudit(wtx, {
    organizationId, actorId: userId, action: 'organization.member_removed', targetId: userId, metadata: { reason: 'account_deletion' },
  })
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Statement { table: string; text: string; values: unknown[] }

/** Object references are captured in the same transaction that removes their rows. */
export async function accountStorageKeys(client: Pick<PoolClient, 'query'>, userId: string, plan: TaskRetention): Promise<{ keys: string[]; notBefore: Date }> {
  // Use the same retained rows as the owner sweep, including files attached
  // directly to a retained task without an intervening Bot or run.
  const { runs, artifacts } = await keptThreads(client, userId, plan)
  const { rows } = await client.query<{ key: string; expiresAt: Date | null }>(
    `select v."storageKey" as key,NULL::timestamptz as "expiresAt" from artifact_versions v join artifacts a on a.id=v."artifactId" where a."userId"=$1 and v."storageKey" is not null and not (a.id = any($3::uuid[]))
     union all select "storageKey","expiresAt" from run_captures where "userId"=$1 and "storageKey" is not null and not ("runId" is not null and "runId" = any($2::uuid[]))
     union all select p."storageKey",NULL from run_capture_posters p join run_captures c on c.id=p."captureId" where c."userId"=$1 and not (c."runId" = any($2::uuid[]))
     union all select 'capture-uploads/' || "userId" || '/runs/' || "runId" || '/captures/' || id || '.' ||
       CASE "contentType" WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' WHEN 'video/mp4' THEN 'mp4' WHEN 'video/webm' THEN 'webm' END,"expiresAt"
       from run_captures where "userId"=$1 AND source='local' AND "expiresAt" IS NOT NULL and not ("runId" is not null and "runId" = any($2::uuid[]))
     union all select "storageKey",NULL from user_avatars where "userId"=$1 and "storageKey" is not null
     union all select "storageKey",NULL from chat_attachments where "userId"=$1 and "storageKey" is not null
     union all select "uploadKey","uploadExpiresAt" from chat_attachments where "userId"=$1 and "uploadKey" is not null
     union all select "storageKey","notBefore" from chat_attachment_retirements where "userId"=$1
     union all select "storageKey",NULL from account_storage_retirements where "userId"=$1`, [userId, runs, artifacts])
  return { keys: [...new Set(rows.map(row => row.key).filter((key): key is string => Boolean(key)))], notBefore: new Date(Math.max(Date.now(), ...rows.map(row => row.expiresAt?.getTime() ?? 0))) }
}

export async function deleteMainAccountData(client: PoolClient, userId: string, plan: CompatiblePlan): Promise<void> {
  const kept = await keptThreads(client, userId, plan)
  if (kept.mailboxes.length) await client.query('update session_mailboxes set disabled=true,"wakeBudget"=0 where id=any($1::uuid[]) and "userId"=$2', [kept.mailboxes, userId])
  // Nobody is left to run their unfinished threads; they stay as stopped.
  if (kept.runs.length) await client.query(`update agent_runs set status = 'stopped', "stopRequestedAt" = coalesce("stopRequestedAt", now()), "finishedAt" = coalesce("finishedAt", now()), "leaseExpiresAt" = null, "updatedAt" = now()
    where id = any($1::uuid[]) and "userId" = $2 and status = any($3::text[])`, [kept.runs, userId, [...UNFINISHED_RUN_STATUSES]])
  // Historical publication receipts stay with the task. Unfinished work loses
  // its approval and lease before the account and its provider credentials go.
  if (kept.runs.length) await client.query(`update run_publications set status='blocked',"errorCode"='issue_unavailable',
    "pushApproved"=false,"leaseToken"=null,"leaseExpiresAt"=null,"updatedAt"=now()
    where "runId"=any($1::uuid[]) and "userId"=$2 and status not in ('published','blocked','skipped')`, [kept.runs, userId])
  if (kept.runs.length) {
    await client.query(`update agent_tool_approvals set status='cancelled',"decidedAt"=coalesce("decidedAt",now())
      where "runId"=any($1::uuid[]) and "userId"=$2 and status in ('pending','approved')`, [kept.runs, userId])
    // Preserve the ledger's last observed state, including executing/uncertain:
    // an invoked external action may have happened. The account deletion guard
    // intentionally rejects ledger updates; removing pending_actions, sessions
    // and run tokens below ends authority without rewriting historical evidence.
  }
  if (kept.factoryTasks.length) {
    await client.query(`insert into factory_events("taskId","eventId",request,result)
      select t.id,g."jobId",jsonb_build_object('kind','account_deletion'),
        jsonb_build_object('previousStatus',t.status,'status','revoked')
      from factory_tasks t join account_deletion_guards g on g."subjectId"=t."userId"
      where t.id=any($1::uuid[]) and t."userId"=$2 and t.status in ('pending','running','waiting')
      on conflict ("taskId","eventId") do nothing`, [kept.factoryTasks, userId])
    await client.query(`update factory_tasks set status='revoked',revision=revision+1,reason='Account deleted',"updatedAt"=now()
      where id=any($1::uuid[]) and "userId"=$2 and status in ('pending','running','waiting')`, [kept.factoryTasks, userId])
    await client.query(`update factory_attempts set status='revoked',reason='Account deleted',"finishedAt"=coalesce("finishedAt",now())
      where "taskId"=any($1::uuid[]) and status in ('pending','running','waiting')`, [kept.factoryTasks])
    await client.query(`update factory_approvals set "revokedAt"=coalesce("revokedAt",now())
      where "taskId"=any($1::uuid[]) and "userId"=$2`, [kept.factoryTasks, userId])
    await client.query(`update factory_questions set status='cancelled',revision=revision+1,reason='Account deleted',"updatedAt"=now()
      where "taskId"=any($1::uuid[]) and "userId"=$2 and status in ('open','waiting_user','answered','resuming','blocked')`, [kept.factoryTasks, userId])
    // Reserved publication may already be in provider IO. Its durable request
    // survives; revoking the task/approval fences all later writes.
    await client.query(`update factory_publications set status='uncertain'
      where "taskId"=any($1::uuid[]) and status='reserved'`, [kept.factoryTasks])
  }
  if (kept.events.length) await client.query(`update coordinator_events set
    "botId"=case when "botId" in (select id from bots where "ownerId"=$1 and not (id=any($3::uuid[]))) then null else "botId" end,
    "deliveredAt"=coalesce("deliveredAt",now()),"wakeLeaseUntil"=null
    where id=any($2::uuid[]) and "userId"=$1`, [userId, kept.events, kept.bots])
  // Subject grants end with the account; private retained source rows never
  // become shared or readable by an administrator through this cleanup.
  if (await localResourceAcl(client)) {
    await client.query('delete from resource_access_grants where "subjectKind"=\'account\' and "subjectId"=$1', [userId])
    await client.query('delete from resource_access_policies where kind=\'project\' and "ownerId"=$1 and not (id=any($2::uuid[]))', [userId, plan.keptProjectIds])
  }
  const statements = await deletionStatements(client, userId, plan, kept)
  // Complete child deletes before attempting their execution/task parents.
  // A guarded workspace also rejects the implicit UPDATE from SET NULL FKs
  // (Artifact/decision/mailbox -> Run, decision -> Factory/Task, machine -> device).
  // Keep the existing row predicates; this changes dependency order only.
  const parentOrder = ['factory_tasks', 'agent_runs', 'agents', 'bots', 'device_repos', 'devices', 'issues']
  await runToFixpoint(client, statements.filter(statement => !parentOrder.includes(statement.table)))
  await runToFixpoint(client, statements.filter(statement => parentOrder.includes(statement.table))
    .sort((left, right) => parentOrder.indexOf(left.table) - parentOrder.indexOf(right.table)))
  // As when a member leaves (releaseDepartingMember): paused until an admin takes the bot over, now with no owner (「待接管」).
  // After the sweep: the owner-bound rows that reference (id, workspaceId, ownerId) are gone. Their shares and card designation went with it.
  if (kept.bots.length) await client.query('update bots set "ownerId" = null, "archivedAt" = coalesce("archivedAt", now()), "updatedAt" = now() where id = any($1::uuid[])', [kept.bots])
  // A workspace only they belong to goes with them: every row keyed by it, whoever wrote it.
  const { deleteWorkspaceRows } = await import('@/lib/workspace-rows')
  for (const workspaceId of plan.solo) await deleteWorkspaceRows(client, workspaceId)
  await client.query('delete from "user" where id=$1', [userId])
  for (const workspaceId of plan.shared) await workspaceListChanged(client, workspaceId, ['workspace_settings', 'issue_list', 'bot_list', 'group_list'])
}

/** Every delete the account needs in the main database, in no particular order. */
export async function deletionStatements(client: Pick<PoolClient, 'query'>, userId: string, plan: CompatiblePlan, threads?: KeptThreads): Promise<Statement[]> {
  const keptRows = threads ?? await keptThreads(client, userId, plan)
  const retainedProjects = plan.keptProjectIds ?? await retainedWorkspaceProjects(workspaceDb, userId, plan.solo, plan.shared)
  /** The person's rows of `table`, minus those that stay; `$1` is the person. */
  const ownedRows = (table: string, column: string) => {
    // Authorship is historical identity. It cannot erase a surviving tenant's
    // decision/source or a kept task's published spelling during owner cleanup.
    const keep = table === 'project_decisions'
      ? { sql: '"projectId" = any($2::uuid[])', ids: retainedProjects }
      : table === 'project_decision_sources'
        ? { sql: '"decisionId" in (select id from project_decisions where "projectId" = any($2::uuid[]))', ids: retainedProjects }
        : table === 'task_identifier_aliases'
          ? { sql: '"issueId" = any($2::uuid[])', ids: plan.keptIssueIds }
          : keptCondition(table, keptRows)
    return keep
      ? { where: `${ident(column)} = $1 and not (${keep.sql})`, values: [userId, keep.ids] }
      : { where: `${ident(column)} = $1`, values: [userId] }
  }
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
    const parentRows = ownedRows(ref.parent, parentOwner)
    statements.push({
      table: ref.child, values: parentRows.values,
      text: `delete from ${ident(ref.child)} where ${ident(ref.childColumn)} in (select ${ident(ref.parentColumn)} from ${ident(ref.parent)} where ${parentRows.where})`,
    })
  }
  for (const { table, column } of ownedTables) {
    const rows = ownedRows(table, column)
    // Run.mailboxId is NO ACTION while mailbox.latestRunId is SET NULL.
    // Remove only the already eligible rows together, so the statement-end FK
    // check sees both gone without an UPDATE to either guarded parent.
    if (table === 'session_mailboxes' && ownerColumn.has('agent_runs')) continue
    if (table === 'agent_runs' && ownerColumn.has('session_mailboxes')) {
      const mailbox = ownedRows('session_mailboxes', ownerColumn.get('session_mailboxes')!)
      statements.push({ table, values: [...rows.values, keptRows.mailboxes],
        text: `with removed_mailboxes as (delete from session_mailboxes where ${mailbox.where.replaceAll('$2', '$3')} returning id)
          delete from ${ident(table)} where ${rows.where}` })
      continue
    }
    statements.push({ table, values: rows.values, text: `delete from ${ident(table)} where ${rows.where}` })
  }
  const kept = plan.keptIssueIds
  statements.push(
    { table: 'issue_documents', values: [userId, kept], text: 'delete from issue_documents where "userId" = $1 and not ("issueId" = any($2::uuid[]))' },
    { table: 'issue_versions', values: [userId, kept], text: 'delete from issue_versions where "userId" = $1 and not ("issueId" = any($2::uuid[]))' },
    { table: 'issue_members', values: [userId, kept], text: 'delete from issue_members where ("userId" = $1 and not ("issueId" = any($2::uuid[]))) or "memberId" = $1' },
    { table: 'issues', values: [userId, kept], text: 'delete from issues where "userId" = $1 and not (id = any($2::uuid[]))' },
    // Public links the person made to a kept thread's files close with their account.
    { table: 'artifact_shares', values: [userId], text: 'delete from artifact_shares where "createdBy" = $1' },
    { table: 'run_capture_shares', values: [userId], text: 'delete from run_capture_shares where "createdBy" = $1' },
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
