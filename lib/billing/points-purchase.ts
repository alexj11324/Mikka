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

/**
 * The points' Stripe tax code: Artificial Intelligence as a Service (AIaaS) - Cloud Based - Business Use.
 * Managed Payments, on by default for the account, refuses a product without an eligible code
 * (Alex, 2026-11-02: keep Managed Payments). Both the embedded and the hosted Checkout use it.
 */
export const POINTS_TAX_CODE = 'txcd_10105002'

/** Admin-only; the browser supplies dollars, never points, price IDs or redirect URLs. Comes back to 计费. */
export async function pointsPurchaseUrl(actorId: string, workspaceId: string, amount: number, locale: string, fetchImpl: typeof fetch = fetch, env: Env = process.env): Promise<{ url: string }> {
  const result = await pointsPurchase(actorId, workspaceId, amount, locale, {}, fetchImpl, env)
  if (!('url' in result)) throw new WorkspaceError('billingProviderFailed')
  return result
}

/**
 * Where a purchase started from a chat comes back to (decision
 * 2026-11-02-1450, 「同一页完成」): that chat, which then runs the refused
 * turn again. Only a bot id is taken from the browser, never a URL.
 */
export interface PurchaseFromChat { chat: { botId: string | null } }

/**
 * 充值. From a chat with NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY set, an embedded
 * Checkout session whose client secret the chat mounts in a dialog. Without
 * the key, or from 计费, a hosted Checkout page that comes back to where it
 * started (`url`).
 */
export async function pointsPurchase(actorId: string, workspaceId: string, amount: number, locale: string, from: Partial<PurchaseFromChat> & { hosted?: boolean }, fetchImpl: typeof fetch = fetch, env: Env = process.env): Promise<{ url: string } | { clientSecret: string }> {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
  z.number().refine(value => (POINTS_PURCHASE_AMOUNTS as readonly number[]).includes(value)).parse(amount)
  const config = stripeConfig(env)
  const origin = resolveAppOrigin(env)
  if (!config?.webhookSecret || !origin) throw new WorkspaceError('billingNotConfigured')
  const [trustedOrigin] = authTrustedOrigins({ BETTER_AUTH_URL: origin, NODE_ENV: env.NODE_ENV, CI: env.CI })
  const chat = from.chat ? { botId: from.chat.botId === null ? null : z.uuid().parse(from.chat.botId) } : null
  const { workspaceLink } = await import('@/components/workspace/workspace-navigation')
  const back = new URL(withBasePath(`${locale === 'en' ? '/en' : ''}${chat ? workspaceLink(chat.botId ? { bot: chat.botId } : {}) : '/settings'}`), trustedOrigin)
  if (!chat) back.searchParams.set('section', 'billing')
  back.searchParams.set('workspace', workspaceId)
  // The bundled renderer cannot load Stripe's remote script. Its authenticated
  // RPC scope selects the existing hosted flow, retaining the same chat return.
  const embedded = Boolean(chat && env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && !from.hosted)
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
    const common = {
      mode: 'payment', managed_payments: { enabled: true }, customer: binding.id, client_reference_id: workspaceId,
      line_items: [{ price_data: { currency: 'usd', unit_amount: amount * 100, product_data: { name: 'Mikka points', tax_code: POINTS_TAX_CODE } }, quantity: 1 }],
      metadata, payment_intent_data: { metadata },
    }
    if (embedded) {
      // In a dialog on the chat: Stripe returns there only for payment methods that must leave the page.
      const session = await stripePost<{ client_secret: string }>(config, 'checkout/sessions', { ...common, ui_mode: 'embedded_page', return_url: successUrl }, fetchImpl)
      return { clientSecret: z.string().min(1).parse(session.client_secret) }
    }
    const session = await stripePost<{ url: string }>(config, 'checkout/sessions', { ...common, success_url: successUrl, cancel_url: back.href }, fetchImpl)
    const url = z.url().parse(session.url)
    if (new URL(url).origin !== 'https://checkout.stripe.com') throw new WorkspaceError('billingProviderFailed')
    return { url }
  } catch (error) {
    if (error instanceof StripeRequestError || (error as Error)?.name === 'TimeoutError' || error instanceof TypeError) throw new WorkspaceError('billingProviderFailed')
    throw error
  }
}
