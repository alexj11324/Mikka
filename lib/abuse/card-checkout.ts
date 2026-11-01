import 'server-only'
import { z } from 'zod'
import { authTrustedOrigins, resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { pool } from '@/lib/db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { stripeConfig, stripePost, StripeRequestError } from '@/lib/billing/stripe'

type Env = Readonly<Record<string, string | undefined>>

/**
 * Card verification belongs to the person (orchestration.md § 7, C19): any
 * member verifies, from any workspace, and it is recorded on their own personal
 * workspace, which gets the one-off USD 1 credit once per card. Returns to that
 * workspace's 计费. Stripe hosts the page; setup mode cannot charge the customer.
 */
export async function personalBillingWorkspace(actorId: string, locale = 'zh-CN'): Promise<string> {
  const { rows: [user] } = await pool.query<{ id: string; email: string; name: string }>('SELECT id,email,name FROM "user" WHERE id=$1', [actorId])
  if (!user) throw new WorkspaceError('workspaceAccessDenied')
  const { ensurePersonalWorkspace } = await import('@/lib/personal-workspace')
  return ensurePersonalWorkspace(user, locale === 'en' ? 'en' : 'zh-CN')
}

export async function createCardSetup(actorId: string, currentWorkspaceId: string, fetchImpl: typeof fetch = fetch, locale = 'zh-CN', env: Env = process.env): Promise<{ url: string }> {
  await workspaceDb.transaction(tx => requireWorkspace(tx, currentWorkspaceId, actorId))
  const config = stripeConfig(env)
  const origin = resolveAppOrigin(env)
  if (!config?.webhookSecret || !origin) throw new WorkspaceError('billingNotConfigured')
  const workspaceId = await personalBillingWorkspace(actorId, locale)
  const [trustedOrigin] = authTrustedOrigins({ BETTER_AUTH_URL: origin, NODE_ENV: env.NODE_ENV, CI: env.CI })
  const back = new URL(withBasePath(`${locale === 'en' ? '/en' : ''}/settings`), trustedOrigin)
  back.searchParams.set('section', 'billing')
  back.searchParams.set('workspace', workspaceId)
  try {
    const prior = (await pool.query<{ id: string }>(`
      SELECT "stripeCustomerId" AS id FROM workspace_billing WHERE "workspaceId"=$1 AND "stripeCustomerId" IS NOT NULL
      UNION ALL SELECT "customerId" AS id FROM hosted_verifications WHERE "workspaceId"=$1 AND "customerId" IS NOT NULL
      UNION ALL SELECT "customerId" AS id FROM hosted_setup_intents WHERE "workspaceId"=$1
      LIMIT 1`, [workspaceId])).rows[0]
    const customer = prior ?? await stripePost<{ id: string }>(config, 'customers', { metadata: { workspaceId, userId: actorId } }, fetchImpl, `points-customer:${workspaceId}`)
    const binding = (await pool.query<{ id: string }>(`
      INSERT INTO workspace_billing ("workspaceId", "stripeCustomerId") VALUES ($1,$2)
      ON CONFLICT ("workspaceId") DO UPDATE SET "stripeCustomerId"=coalesce(workspace_billing."stripeCustomerId",excluded."stripeCustomerId")
      RETURNING "stripeCustomerId" AS id`, [workspaceId, customer.id])).rows[0]
    back.searchParams.set('verify', 'success')
    const successUrl = `${back.href}&session_id={CHECKOUT_SESSION_ID}`
    back.searchParams.set('verify', 'cancelled')
    const session = z.object({ id: z.string().startsWith('cs_'), url: z.url() }).parse(await stripePost(config, 'checkout/sessions', {
      mode: 'setup', currency: 'usd', customer: binding.id, client_reference_id: workspaceId,
      // Card-specific Link keeps the fingerprint needed by the verification claim.
      allowed_payment_method_types: ['card'],
      metadata: { workspaceId }, setup_intent_data: { metadata: { workspaceId } },
      success_url: successUrl, cancel_url: back.href,
    }, fetchImpl))
    if (new URL(session.url).origin !== 'https://checkout.stripe.com') throw new WorkspaceError('billingProviderFailed')
    await pool.query('INSERT INTO hosted_setup_intents (id,"workspaceId","customerId") VALUES ($1,$2,$3)', [session.id, workspaceId, binding.id])
    return { url: session.url }
  } catch (error) {
    if (error instanceof StripeRequestError || (error as Error)?.name === 'TimeoutError' || error instanceof TypeError) throw new WorkspaceError('billingProviderFailed')
    throw error
  }
}
