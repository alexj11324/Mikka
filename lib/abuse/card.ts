import 'server-only'
import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { stripeConfig, stripeGet, stripePost } from '@/lib/billing/stripe'
import { hostedUsage } from './runtime'
/** Admin-only. The intent has no amount and cannot charge the customer. */
export async function createCardSetup(
  actorId: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
) {
  await workspaceDb.transaction((tx) =>
    requireWorkspace(tx, workspaceId, actorId, true),
  )
  const config = stripeConfig()
  if (!config?.webhookSecret) throw new WorkspaceError('billingNotConfigured')
  // Stripe idempotency also serializes concurrent first-customer creation.
  const prior = (
    await pool.query(
      'SELECT "customerId" AS id FROM hosted_setup_intents WHERE "workspaceId"=$1 LIMIT 1',
      [workspaceId],
    )
  ).rows[0]
  const customer =
    prior ??
    (await stripePost<{ id: string }>(
      config,
      'customers',
      { metadata: { workspaceId } },
      fetchImpl,
      `card-customer:${workspaceId}`,
    ))
  const intent = await stripePost<{ id: string; client_secret: string }>(
    config,
    'setup_intents',
    {
      customer: customer.id,
      usage: 'on_session',
      metadata: { workspaceId },
      allowed_payment_method_types: ['card'],
    },
    fetchImpl,
    `card-setup:${workspaceId}:${randomUUID()}`,
  )
  await pool.query(
    'INSERT INTO hosted_setup_intents (id,"workspaceId","customerId") VALUES ($1,$2,$3)',
    [intent.id, workspaceId, customer.id],
  )
  return { clientSecret: intent.client_secret }
}
/** Only invoked AFTER signature verification. Trust the locally recorded intent binding. */
export async function applyCardSetup(
  object: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
) {
  if (
    object.status !== 'succeeded' ||
    typeof object.id !== 'string' ||
    typeof object.payment_method !== 'string'
  )
    return
  const binding = (
    await pool.query('SELECT * FROM hosted_setup_intents WHERE id=$1', [
      object.id,
    ])
  ).rows[0]
  if (!binding || binding.customerId !== object.customer) return
  const config = stripeConfig()
  if (!config) throw new WorkspaceError('billingNotConfigured')
  const method = await stripeGet<{
    type: string
    customer: string
    card?: { fingerprint?: string }
  }>(
    config,
    `payment_methods/${encodeURIComponent(object.payment_method)}`,
    fetchImpl,
  )
  if (
    method.type !== 'card' ||
    method.customer !== binding.customerId ||
    !method.card?.fingerprint
  )
    return
  await hostedUsage.verify(
    binding.workspaceId,
    binding.customerId,
    method.card.fingerprint,
  )
}
