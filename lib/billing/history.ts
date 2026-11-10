import 'server-only'
import { pool } from '@/lib/db'
import { FREE_ALLOWANCE_MICRO_USD, MICRO_USD_PER_POINT } from '@/lib/abuse/policy'
import { ensureLegacyVerification, hostedUsage } from '@/lib/abuse/runtime'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'

export type { CreditTransaction, CreditBillingView } from './contract'
import type { CreditTransaction, CreditBillingView } from './contract'

/** The same remaining allowance and purchased balance used to admit hosted calls. */
export async function workspaceCreditBillingView(actorId: string, workspaceId: string): Promise<CreditBillingView> {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
  await ensureLegacyVerification(workspaceId)
  return readCreditBillingAccount(workspaceId)
}

/** Internal metadata read; callers must hold fresh billing authority for this account. */
export async function readCreditBillingAccount(workspaceId: string): Promise<CreditBillingView> {
  const balance = await hostedUsage.balance(workspaceId)
  const { rows } = await pool.query<Omit<CreditTransaction, 'date'> & { date: Date }>(
    `SELECT id::text AS id,"createdAt" AS date,CASE WHEN reason='refund' THEN 'refund' WHEN reason='subscription' THEN 'subscription' ELSE 'topup' END AS type,
      points,"amountCents",currency,"stripeFeeCents",'succeeded' AS status,"receiptUrl"
    FROM workspace_credit_grants WHERE "workspaceId"=$1 AND ((bucket='purchased' AND reason IN ('purchase','refund')) OR (bucket='plan' AND reason IN ('subscription','refund')))
    UNION ALL
    SELECT 'verification:' || v."workspaceId",v."verifiedAt",'verification',$2::int,0,'usd',NULL,'succeeded',NULL
    FROM hosted_verifications v JOIN hosted_allowances a ON a."workspaceId"=v."workspaceId"
    WHERE v."workspaceId"=$1
    ORDER BY date DESC,id DESC LIMIT 50`,
    [workspaceId, FREE_ALLOWANCE_MICRO_USD / MICRO_USD_PER_POINT],
  )
  return {
    balancePoints: (balance.free + balance.plan + balance.purchased) / MICRO_USD_PER_POINT,
    transactions: rows.map(row => ({ ...row, date: row.date.toISOString() })),
  }
}
