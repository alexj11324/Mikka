import 'server-only'
import { z } from 'zod'
import { authTrustedOrigins, resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { pool } from '@/lib/db'
import { MICRO_USD_PER_POINT } from '@/lib/abuse/policy'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { POINTS_PURCHASE_AMOUNTS } from './points'
import { stripeConfig, stripePost, StripeRequestError } from './stripe'

type Env = Readonly<Record<string, string | undefined>>

/** Admin-only; the browser supplies dollars, never points, price IDs or redirect URLs. */
export async function pointsPurchaseUrl(actorId: string, workspaceId: string, amount: number, locale: string, fetchImpl: typeof fetch = fetch, env: Env = process.env): Promise<{ url: string }> {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
  z.number().refine(value => (POINTS_PURCHASE_AMOUNTS as readonly number[]).includes(value)).parse(amount)
  const config = stripeConfig(env)
  const origin = resolveAppOrigin(env)
  if (!config?.webhookSecret || !origin) throw new WorkspaceError('billingNotConfigured')
  const [trustedOrigin] = authTrustedOrigins({ BETTER_AUTH_URL: origin, NODE_ENV: env.NODE_ENV, CI: env.CI })
  const back = new URL(withBasePath(`${locale === 'en' ? '/en' : ''}/settings`), trustedOrigin)
  back.searchParams.set('section', 'billing')
  back.searchParams.set('workspace', workspaceId)
  const metadata = { workspaceId, points: String(amount * 1_000_000 / MICRO_USD_PER_POINT), purpose: 'points_purchase' }
  try {
    const prior = (await pool.query<{ id: string }>(`
      SELECT "stripeCustomerId" AS id FROM workspace_billing WHERE "workspaceId"=$1 AND "stripeCustomerId" IS NOT NULL
      UNION ALL SELECT "customerId" AS id FROM hosted_verifications WHERE "workspaceId"=$1 AND "customerId" IS NOT NULL
      UNION ALL SELECT "customerId" AS id FROM hosted_setup_intents WHERE "workspaceId"=$1
      LIMIT 1`, [workspaceId])).rows[0]
    const customer = prior ?? await stripePost<{ id: string }>(config, 'customers', { metadata: { workspaceId } }, fetchImpl, `points-customer:${workspaceId}`)
    const binding = (await pool.query<{ id: string }>(`
      INSERT INTO workspace_billing ("workspaceId", "stripeCustomerId") VALUES ($1,$2)
      ON CONFLICT ("workspaceId") DO UPDATE SET "stripeCustomerId"=coalesce(workspace_billing."stripeCustomerId",excluded."stripeCustomerId")
      RETURNING "stripeCustomerId" AS id`, [workspaceId, customer.id])).rows[0]
    back.searchParams.set('topup', 'success')
    const successUrl = `${back.href}&session_id={CHECKOUT_SESSION_ID}`
    back.searchParams.set('topup', 'cancelled')
    const session = await stripePost<{ url: string }>(config, 'checkout/sessions', {
      mode: 'payment', customer: binding.id, client_reference_id: workspaceId,
      line_items: [{ price_data: { currency: 'usd', unit_amount: amount * 100, product_data: { name: 'Mikka points' } }, quantity: 1 }],
      metadata, payment_intent_data: { metadata },
      success_url: successUrl, cancel_url: back.href,
    }, fetchImpl)
    const url = z.url().parse(session.url)
    if (new URL(url).origin !== 'https://checkout.stripe.com') throw new WorkspaceError('billingProviderFailed')
    return { url }
  } catch (error) {
    if (error instanceof StripeRequestError || (error as Error)?.name === 'TimeoutError' || error instanceof TypeError) throw new WorkspaceError('billingProviderFailed')
    throw error
  }
}
