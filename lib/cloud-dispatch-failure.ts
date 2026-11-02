import type { Pool } from 'pg'
import { ownE2BKeySql } from './secrets/e2b-owner-sql'

/** A failed cloud start is not evidence that a stored key is missing. */
export async function cloudDispatchFailureReason(query: Pick<Pool, 'query'>, ownerId: string): Promise<'cloudNotConfigured' | 'cloudTemporarilyUnavailable'> {
  try {
    const { rows: [row] } = await query.query<{ configured: boolean }>(`SELECT ${ownE2BKeySql('$1::text')} AS configured`, [ownerId])
    return row?.configured === false ? 'cloudNotConfigured' : 'cloudTemporarilyUnavailable'
  } catch {
    // An unconfirmed read cannot establish that the person has no key.
    return 'cloudTemporarilyUnavailable'
  }
}
