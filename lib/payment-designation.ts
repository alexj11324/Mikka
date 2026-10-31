import 'server-only'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'

/** A released card keeps paying this long, so the team is never cut off at once (decision 2026-10-31-2225). */
export const PAYMENT_GRACE_DAYS = 7

export interface PaymentDesignationView {
  /** The signed-in member's card pays for this team. */
  mine: boolean
  /** Whose card pays, by name, for admins; null when none or for members. */
  payerName: string | null
  /** Set while a released card is in its grace period: when it stops paying. */
  graceUntil: string | null
  /** The member has a verified card to offer. */
  canDesignate: boolean
  admin: boolean
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const audit = (tx: Tx, workspaceId: string, actor: { id: string; name: string }, change: 'designated' | 'released') =>
  recordAudit(tx, { workspaceId, actor: { type: 'user', id: actor.id, name: actor.name }, action: 'billing.payment_method_changed', target: { type: 'member', id: actor.id, label: actor.name },
    metadata: change === 'released' ? { change, graceDays: PAYMENT_GRACE_DAYS } : { change } })

/** The member verified a card on a workspace they own (their own card), the same evidence as per-person verification. */
async function hasOwnVerifiedCard(userId: string) {
  const owned = (await workspacePool.query<{ id: string }>('SELECT id FROM mikka_workspaces WHERE "userId"=$1', [userId])).rows.map(row => row.id)
  if (!owned.length) return false
  return Boolean((await pool.query(`SELECT 1 FROM hosted_verifications WHERE "workspaceId"=ANY($1::uuid[]) AND "customerId" IS NOT NULL`, [owned])).rowCount)
}

export async function paymentDesignation(actorId: string, workspaceId: string): Promise<PaymentDesignationView> {
  const { workspace, membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  const admin = membership.role === 'admin'
  const { rows: [row] } = await pool.query<{ userId: string; graceUntil: Date | null }>(
    'SELECT "userId","graceUntil" FROM workspace_payment_designations WHERE "workspaceId"=$1 AND ("releasedAt" IS NULL OR "graceUntil">now())', [workspaceId])
  let payerName: string | null = null
  // From the account: a payer who left has no membership row any more, and admins still need to know whose card it is.
  if (row && admin) payerName = (await pool.query<{ name: string }>('SELECT name FROM "user" WHERE id=$1', [row.userId])).rows[0]?.name ?? null
  return {
    mine: row?.userId === actorId && !row.graceUntil,
    payerName,
    graceUntil: admin || row?.userId === actorId ? row?.graceUntil?.toISOString() ?? null : null,
    canDesignate: workspace.kind === 'team' && await hasOwnVerifiedCard(actorId),
    admin,
  }
}

/** 由我的卡支付这个团队: a member offers their own verified card; one designation per team. */
export async function designateOwnCard(actor: { id: string; name: string }, workspaceId: string): Promise<PaymentDesignationView> {
  const { workspace } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actor.id))
  if (workspace.kind !== 'team' || !(await hasOwnVerifiedCard(actor.id))) throw new WorkspaceError('validationGeneric')
  await db.transaction(async tx => {
    const { rowCount } = await tx.execute(sql`INSERT INTO workspace_payment_designations ("workspaceId","userId") VALUES (${workspaceId},${actor.id})
      ON CONFLICT ("workspaceId") DO UPDATE SET "userId"=EXCLUDED."userId","designatedAt"=now(),"releasedAt"=NULL,"graceUntil"=NULL
      WHERE workspace_payment_designations."userId"=EXCLUDED."userId" OR workspace_payment_designations."releasedAt" IS NOT NULL`)
    // Another member's card already pays (or is still in its grace period).
    if (!rowCount) throw new WorkspaceError('workspacePaymentTaken')
    await audit(tx, workspaceId, actor, 'designated')
  })
  return paymentDesignation(actor.id, workspaceId)
}

/**
 * The member stops paying, or leaves: the card is released with a grace period
 * instead of an instant cut-off, and admins see when it stops on 计费.
 */
export async function releasePaymentDesignation(workspaceId: string, userId: string, actor: { id: string; name: string } = { id: userId, name: userId }) {
  return db.transaction(async tx => {
    const { rowCount } = await tx.execute(sql`UPDATE workspace_payment_designations SET "releasedAt"=now(),"graceUntil"=now()+make_interval(days => ${PAYMENT_GRACE_DAYS})
      WHERE "workspaceId"=${workspaceId} AND "userId"=${userId} AND "releasedAt" IS NULL`)
    if (rowCount) await audit(tx, workspaceId, actor, 'released')
    return Boolean(rowCount)
  })
}
