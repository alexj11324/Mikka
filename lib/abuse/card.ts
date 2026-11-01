import 'server-only'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { stripeConfig, stripeGet } from '@/lib/billing/stripe'
import { hostedUsage } from './runtime'
import { MICRO_USD_PER_POINT } from './policy'

export { createCardSetup } from './card-checkout'

type Binding = { workspaceId: string; customerId: string }

async function applyBoundCardSetup(object: Record<string, unknown>, binding: Binding, fetchImpl: typeof fetch) {
  if (object.status !== 'succeeded' || typeof object.payment_method !== 'string' || object.customer !== binding.customerId) return
  const config = stripeConfig()
  if (!config) throw new WorkspaceError('billingNotConfigured')
  const method = await stripeGet<{
    type: string
    customer: string
    card?: { fingerprint?: string; last4?: string; wallet?: { type?: string } }
  }>(config, `payment_methods/${encodeURIComponent(object.payment_method)}`, fetchImpl)
  if (method.type !== 'card' || method.customer !== binding.customerId || !method.card?.fingerprint) return
  // Regular cards and Link-saved cards deliberately share the same claim key.
  await hostedUsage.verify(binding.workspaceId, binding.customerId, method.card.fingerprint, /^\d{4}$/.test(method.card.last4 ?? '') ? method.card.last4 : null)
}

/** Legacy SetupIntent events retain their locally recorded intent/customer binding. */
export async function applyCardSetup(object: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  if (typeof object.id !== 'string') return
  const binding = (await pool.query('SELECT * FROM hosted_setup_intents WHERE id=$1', [object.id])).rows[0]
  if (binding) await applyBoundCardSetup(object, binding, fetchImpl)
}

/** Only invoked after webhook signature verification; session metadata cannot select the workspace. */
export async function applyCardCheckout(object: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  if (object.mode !== 'setup' || object.status !== 'complete' || typeof object.id !== 'string' || typeof object.setup_intent !== 'string') return
  const binding = (await pool.query('SELECT * FROM hosted_setup_intents WHERE id=$1', [object.id])).rows[0] as Binding | undefined
  if (!binding || object.customer !== binding.customerId) return
  const config = stripeConfig()
  if (!config) throw new WorkspaceError('billingNotConfigured')
  const intent = await stripeGet<Record<string, unknown>>(config, `setup_intents/${encodeURIComponent(object.setup_intent)}`, fetchImpl)
  if (intent.id !== object.setup_intent) return
  await applyBoundCardSetup(intent, binding, fetchImpl)
}

export interface CardVerificationStatus {
  status: 'unavailable' | 'unverified' | 'pending' | 'verified'
  last4: string | null
  allowance: 'granted' | 'claimed_elsewhere' | null
  remainingAllowanceMicroUsd: number
  remainingAllowancePoints: number
}

const EMPTY = { last4: null, allowance: null, remainingAllowanceMicroUsd: 0, remainingAllowancePoints: 0 }

/** The person's own verification (it lives on their personal workspace), read-only. Fingerprints never leave the backend. */
export async function cardVerificationStatus(actorId: string, currentWorkspaceId: string, fetchImpl: typeof fetch = fetch): Promise<CardVerificationStatus> {
  await workspaceDb.transaction(tx => requireWorkspace(tx, currentWorkspaceId, actorId))
  if (!stripeConfig()?.webhookSecret) return { status: 'unavailable', ...EMPTY }
  const { personalBillingWorkspace } = await import('./card-checkout')
  const personal = await personalBillingWorkspace(actorId)
  // A card verified before this was the person's on a workspace they own: it counts here too (decision 2026-10-31-2225).
  const { ensureLegacyVerification } = await import('./runtime')
  await ensureLegacyVerification(personal)
  return workspaceCardStatus(personal, fetchImpl)
}


/** One workspace's verification record and its latest setup session. No access check: callers resolve whose it is. */
export async function workspaceCardStatus(workspaceId: string, fetchImpl: typeof fetch = fetch): Promise<CardVerificationStatus> {
  const empty = EMPTY
  const config = stripeConfig()
  if (!config?.webhookSecret) return { status: 'unavailable', ...empty }
  const row = (await pool.query(`SELECT v.last4,v.fingerprint IS NOT NULL AS "hasCard",a."workspaceId" IS NOT NULL AS granted,COALESCE(a.remaining,0)::float8 AS remaining,
    c."workspaceId" IS NOT NULL AND c."workspaceId"<>v."workspaceId" AS "alreadyClaimed"
    FROM hosted_verifications v LEFT JOIN hosted_allowances a ON a."workspaceId"=v."workspaceId"
    LEFT JOIN hosted_card_claims c ON c.fingerprint=v.fingerprint WHERE v."workspaceId"=$1`, [workspaceId])).rows[0]
  if (row) return {
    status: 'verified', last4: row.last4, allowance: row.granted ? 'granted' : row.hasCard && row.alreadyClaimed ? 'claimed_elsewhere' : null,
    remainingAllowanceMicroUsd: row.remaining, remainingAllowancePoints: row.remaining / MICRO_USD_PER_POINT,
  }
  const binding = (await pool.query('SELECT id,"customerId" FROM hosted_setup_intents WHERE "workspaceId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1', [workspaceId])).rows[0]
  if (!binding) return { status: 'unverified', ...empty }
  const resource = binding.id.startsWith('cs_') ? 'checkout/sessions' : 'setup_intents'
  const setup = await stripeGet<{ customer: string; status: string }>(config, `${resource}/${encodeURIComponent(binding.id)}`, fetchImpl)
  if (setup.customer !== binding.customerId) return { status: 'unverified', ...empty }
  return { status: setup.status === 'expired' || setup.status === 'canceled' ? 'unverified' : 'pending', ...empty }
}
