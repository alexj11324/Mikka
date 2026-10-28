// Candidate behind the blocked revokeSessions entry. Calling the generated
// statement requires an authorized target, an identity-checked transaction,
// and current lease fencing before and after the update. A token already
// authenticated in an in-flight request can still complete; application-wide
// cancellation, other sessions and OAuth paths require separate proof. A caller
// must confirm every registered session update and retain/quarantine failures.
// Keep entry points blocked until these requirements are independently verified.
import { randomBytes } from 'node:crypto'

export const RETAINED_SESSION_UPDATE = `
  UPDATE public.session AS s
     SET token = $4, "expiresAt" = clock_timestamp() - interval '1 second',
         "updatedAt" = clock_timestamp()
   WHERE s.id = $1 AND s."userId" = $2
     AND EXISTS (
       SELECT 1 FROM mikka_test_accounts.resources r
       JOIN mikka_test_accounts.leases l ON l.id = r.lease_id
       JOIN mikka_test_accounts.pairs p ON p.id = l.pair_id
       JOIN mikka_test_accounts.accounts a ON a.pair_id = p.id AND a.user_id = r.owner_id
       JOIN public."user" u ON u.id = a.user_id AND u.email = a.email
       WHERE r.lease_id = $3 AND r.type = 'session' AND r.id = s.id
         AND r.owner_id = s."userId" AND r.state = 'created'
         AND l.state = 'active' AND l.expires_at > clock_timestamp()
         AND l.generation = $5 AND p.active_lease_id = l.id
         AND p.state = 'leased' AND p.generation = l.generation
     )
 RETURNING s.id`

/** Return one parameterized candidate update. Never log its values. */
export function retainedSessionUpdate({ sessionId, ownerId, leaseId, generation }) {
  if (![sessionId, ownerId, leaseId].every(value => typeof value === 'string' && value.length > 0) ||
      !Number.isSafeInteger(generation) || generation < 1) throw new Error('INVALID_RETAINED_SESSION_BINDING')
  const bytes = randomBytes(32)
  try {
    return { text: RETAINED_SESSION_UPDATE, values: [sessionId, ownerId, leaseId, bytes.toString('base64url'), generation] }
  } finally { bytes.fill(0) }
}

// The caller must roll back the identity-checked transaction on a mismatch.
export function assertOneRetainedSessionUpdated(result) {
  if (result?.rowCount !== 1) throw new Error('RETAINED_SESSION_UPDATE_MISMATCH')
}
