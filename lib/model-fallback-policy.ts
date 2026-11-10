import type { OrderEntry } from './model-order-plan'

export type FallbackSource = { entry: Pick<OrderEntry, 'harness' | 'model' | 'source'>; credentialOwnerId: string }

/** Preference order is never permission to switch another person's bill.
 * Recovery additionally pins the actual model and Harness from the failed run. */
export function modelFallbackAllowed(from: FallbackSource, to: FallbackSource, options: { personalPaidFallback: boolean; organizationPaidFallback: boolean; recovery: boolean }) {
  if (from.credentialOwnerId !== to.credentialOwnerId) return false
  if (options.recovery && (from.entry.model !== to.entry.model || from.entry.harness !== to.entry.harness)) return false
  const a = from.entry.source, b = to.entry.source
  const sameSource = a.kind === b.kind && (a.kind === 'subscription' && b.kind === 'subscription' ? a.connectionId === b.connectionId
    : a.kind === 'api_key' && b.kind === 'api_key' && a.keyId === b.keyId)
  if (sameSource || b.kind === 'subscription') return true
  return to.credentialOwnerId.startsWith('organization:') ? options.organizationPaidFallback : options.personalPaidFallback
}
