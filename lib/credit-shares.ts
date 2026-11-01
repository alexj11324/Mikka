import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { PaidResourceError } from '@/lib/abuse/policy'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'

/**
 * 我的点数也可用于这个团队 (decision 2026-10-31-2300 item 4, orchestration.md
 * § 7): a member opts in to let a team spend their credits, the balance of
 * their personal workspace, as with a card designation. The team's own balance
 * pays first; sharers' balances follow, oldest share first. Stopping it, or
 * leaving the team, ends it at once.
 */
type Query = Pick<Pool | PoolClient, 'query'>

export interface CreditShareView {
  /** The signed-in member shares their credits with this team. */
  mine: boolean
  /** A team workspace: the switch shows. */
  canShare: boolean
  /** Admins: who shares, by name, oldest first. Empty for members. */
  sharers: string[]
  admin: boolean
}

export async function creditShareView(actorId: string, workspaceId: string): Promise<CreditShareView> {
  const { workspace, membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  const admin = membership.role === 'admin'
  const team = workspace.kind === 'team'
  const { rows } = team
    ? await pool.query<{ userId: string; name: string | null }>(
      `SELECT s."userId",u.name FROM workspace_credit_shares s LEFT JOIN "user" u ON u.id=s."userId" WHERE s."workspaceId"=$1 ORDER BY s."sharedAt",s."userId"`, [workspaceId])
    : { rows: [] }
  return {
    mine: rows.some(row => row.userId === actorId),
    canShare: team,
    sharers: admin ? rows.flatMap(row => row.name ? [row.name] : []) : [],
    admin,
  }
}

/** Turns the member's own share on or off. A team only; any active member. */
export async function setOwnCreditShare(actorId: string, workspaceId: string, shared: boolean): Promise<CreditShareView> {
  const { workspace } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  if (workspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
  if (shared) await pool.query('INSERT INTO workspace_credit_shares ("workspaceId","userId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [workspaceId, actorId])
  else await removeCreditShare(pool, workspaceId, actorId)
  return creditShareView(actorId, workspaceId)
}

/** A member leaves or is suspended: their credits stop paying for the team at once. */
export async function removeCreditShare(query: Query, workspaceId: string, userId: string) {
  await query.query('DELETE FROM workspace_credit_shares WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, userId])
}

/**
 * The personal workspaces whose credits a team may spend, oldest share first:
 * only sharers who are still active members of the team. Never the team itself.
 */
export async function sharedCreditWorkspaces(workspaceId: string): Promise<string[]> {
  const { rows: shares } = await pool.query<{ userId: string }>('SELECT "userId" FROM workspace_credit_shares WHERE "workspaceId"=$1 ORDER BY "sharedAt","userId"', [workspaceId])
  if (!shares.length) return []
  const { rows } = await workspacePool.query<{ userId: string; personalId: string }>(
    `SELECT m."userId",p.id AS "personalId" FROM mikka_workspace_members m
     JOIN mikka_workspaces t ON t.id=m."workspaceId" AND t.kind='team'
     JOIN mikka_workspaces p ON p."userId"=m."userId" AND p.kind='personal'
     WHERE m."workspaceId"=$1 AND m.status='active' AND m."userId"=ANY($2::text[])`,
    [workspaceId, shares.map(share => share.userId)])
  const personal = new Map(rows.map(row => [row.userId, row.personalId]))
  return shares.flatMap(share => personal.has(share.userId) ? [personal.get(share.userId)!] : [])
}

/** The workspace has nothing to spend: a member's shared credits may pay instead (lib/credit-shares.ts). */
const EMPTY_BALANCE = new Set(['verification_required', 'free_allowance_used', 'points_exhausted'])
/**
 * Runs `attempt` against the workspace's own balance, then, while that is
 * empty, against each balance a member shared with it, oldest share first.
 * The first that admits pays; otherwise the workspace's own refusal stands.
 */
export async function withSharedCredits<T>(workspaceId: string, attempt: (payer: string) => Promise<T>): Promise<T> {
  try { return await attempt(workspaceId) } catch (error) {
    if (!(error instanceof PaidResourceError) || !EMPTY_BALANCE.has(error.code)) throw error
    for (const payer of await sharedCreditWorkspaces(workspaceId)) {
      try { return await attempt(payer) } catch (shared) {
        if (!(shared instanceof PaidResourceError) || !EMPTY_BALANCE.has(shared.code)) throw shared
      }
    }
    throw error
  }
}
