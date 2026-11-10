import 'server-only'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import * as workspaceSchema from '@/lib/db/workspace-schema'
import * as teamSchema from '@/lib/db/team-schema'
import * as projectSchema from '@/lib/db/project-schema'
import * as teamEntitlementsSchema from '@/lib/db/team-entitlements-schema'
import * as governanceSchema from '@/lib/db/governance-schema'
import { runToFixpoint } from '@/lib/account/delete'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

/**
 * A workspace is the tenant (decision 2026-11-02-0231, T1, T5): deleting it
 * deletes every main-database row keyed by it. Tables are found by their
 * workspace column (WORKSPACE_COLUMNS) at run time, so a table added later is
 * covered without touching this file. Used by 删除工作区 and by account
 * deletion for the workspaces only that person belongs to.
 */
export const WORKSPACE_COLUMNS = ['workspaceId', 'workspace_id'] as const

const workspaceDatabaseTables = ([...Object.values(workspaceSchema), ...Object.values(teamSchema), ...Object.values(projectSchema), ...Object.values(teamEntitlementsSchema), ...Object.values(governanceSchema)] as unknown[])
  .filter((value): value is PgTable => is(value, PgTable)).map(table => getTableName(table))

/** Tables keyed by a workspace whose rows stay when it is deleted, and why. */
export const KEPT_WITH_WORKSPACE = new Map<string, string>([
  ['coding_review_sessions', 'revoked capability close target; removed only after gateway close or VM-gone acknowledgement'],
  // The workspace database (lib/workspace-db.ts) is cleaned in its own transaction; a test or preview database holds both.
  ...[...workspaceDatabaseTables, 'account_deletion_workspace_guards', 'hosted_legacy_workspaces', 'workspace_audit_exports']
    .map(table => [table, 'workspace database'] as [string, string]),
  // The person's model subscription belongs to their account (decision 2026-10-31-2225 rule 2); its custody is cleaned by the subscription worker when they disconnect it or delete their account.
  ...['byos_connections', 'byos_bindings', 'byos_secret_artifacts', 'byos_enrollment_transfers', 'byos_oauth_attempts']
    .map(table => [table, 'account-level model subscription'] as [string, string]),
  // A card claims the free allowance once; deleting a workspace never releases it (drizzle/20261030230000_hosted_usage.sql).
  ['hosted_card_claims', 'card claim'],
  // Unpaid hosted model usage and the free-usage window it counts towards.
  ['hosted_usage', 'billing and abuse evidence'],
  // Audit evidence: deleteWorkspaceRows records the deletion in workspace_deletions; lib/audit/retention.ts expires both.
  ['workspace_audit_events', 'kept 90 days after deletion; the audit-retention job removes them'],
  ['workspace_audit_retention', 'kept 90 days after deletion; the audit-retention job removes them'],
  // Append-only skill ledgers: triggers reject every DELETE.
  ['improvement_team_skill_metadata', 'append-only'],
  ['improvement_team_skill_reviews', 'append-only'],
])

type Query = Parameters<typeof runToFixpoint>[0]
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Every delete the workspace needs in the main database, in no particular order. */
export async function workspaceDeletionStatements(client: Query, workspaceId: string) {
  const { rows: keyed } = await client.query<{ table: string; column: string; type: string }>(
    `select c.table_name as "table", c.column_name as "column", c.data_type as type from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = any($1::text[])
     order by 1, 2`, [WORKSPACE_COLUMNS])
  const tables = keyed.filter(row => !KEPT_WITH_WORKSPACE.has(row.table))
  // Some tables keep the id as text.
  const keyColumn = new Map(tables.map(row => [row.table, `${ident(row.column)} = $1${row.type === 'uuid' ? '::uuid' : ''}`]))
  const nullableKey = new Map(tables.map(row => [row.table, `${ident(row.column)} IS NULL`]))
  // Rows elsewhere that point at the workspace's rows without ON DELETE CASCADE
  // (agent_runs → session_mailboxes, suggestion_executions → bot_subagents…) go first.
  const { rows: references } = await client.query<{ child: string; childColumn: string; parent: string; parentColumn: string }>(
    `select ch.relname as child, ca.attname as "childColumn", pa.relname as parent, pc.attname as "parentColumn"
     from pg_constraint k
     join pg_class ch on ch.oid = k.conrelid join pg_namespace n on n.oid = ch.relnamespace
     join pg_class pa on pa.oid = k.confrelid
     join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = k.conkey[1]
     join pg_attribute pc on pc.attrelid = k.confrelid and pc.attnum = k.confkey[1]
     where k.contype = 'f' and k.confdeltype in ('a', 'r') and array_length(k.conkey, 1) = 1 and n.nspname = current_schema()`)
  const statements: { table: string; text: string; values: unknown[] }[] = []
  for (const ref of references) {
    const parentKey = keyColumn.get(ref.parent)
    if (!parentKey || KEPT_WITH_WORKSPACE.has(ref.child)) continue
    // Newly tenant-keyed tables can still contain quarantined legacy rows.
    // Follow their existing parent only while their own tenant is unresolved;
    // a contradictory bound child must block deletion, never be swept away.
    const unresolved = nullableKey.get(ref.child)
    statements.push({ table: ref.child, values: [workspaceId],
      text: `delete from ${ident(ref.child)} where ${ident(ref.childColumn)} in (select ${ident(ref.parentColumn)} from ${ident(ref.parent)} where ${parentKey})${unresolved ? ` AND ${unresolved}` : ''}` })
  }
  for (const [table, key] of keyColumn) statements.push({ table, values: [workspaceId], text: `delete from ${ident(table)} where ${key}` })
  return statements
}

/**
 * Deletes every main-database row keyed by the workspace, in the caller's
 * transaction, and records when (workspace_deletions), so the audit-retention
 * job can expire its log 90 days later.
 */
export async function deleteWorkspaceRows(client: Query, workspaceId: string): Promise<void> {
  await runToFixpoint(client, await workspaceDeletionStatements(client, workspaceId))
  await client.query('insert into workspace_deletions (id) values ($1) on conflict (id) do nothing', [workspaceId])
  // Its audit events expire when the grace period ends, on the audit-retention due timer (#1371).
  armDueTimerAfterCommit(client, 'audit-retention')
}
