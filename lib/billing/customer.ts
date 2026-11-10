import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { stripePost, type StripeConfig } from './stripe'

/** Reuse the existing points/verification customer. Racing requests bind one durable account. */
export async function ensureBillingCustomer(workspaceId: string, config: StripeConfig, fetchImpl: typeof fetch) {
  const prior = (await pool.query<{ id: string }>(`
    SELECT "stripeCustomerId" AS id FROM workspace_billing WHERE "workspaceId"=$1 AND "stripeCustomerId" IS NOT NULL
    UNION ALL SELECT "customerId" AS id FROM hosted_verifications WHERE "workspaceId"=$1 AND "customerId" IS NOT NULL
    UNION ALL SELECT "customerId" AS id FROM hosted_setup_intents WHERE "workspaceId"=$1
    LIMIT 1`, [workspaceId])).rows[0]
  const customer = prior ?? await stripePost<{ id: string }>(config, 'customers', { metadata: { workspaceId } }, fetchImpl, `points-customer:${workspaceId}`)
  const id = z.string().regex(/^cus_[A-Za-z0-9_]+$/).parse(customer.id)
  const binding = (await pool.query<{ id: string }>(`
    INSERT INTO workspace_billing ("workspaceId", "stripeCustomerId") VALUES ($1,$2)
    ON CONFLICT ("workspaceId") DO UPDATE SET "stripeCustomerId"=coalesce(workspace_billing."stripeCustomerId",excluded."stripeCustomerId")
    RETURNING "stripeCustomerId" AS id`, [workspaceId, id])).rows[0]
  return z.string().regex(/^cus_[A-Za-z0-9_]+$/).parse(binding.id)
}
