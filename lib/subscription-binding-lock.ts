import type { PoolClient } from 'pg'

/** Serializes binding replacement with CI claim and snapshot authorization. */
export function lockSubscriptionBinding(tx: Pick<PoolClient,'query'>, ownerId:string, consumerId:string, route:string) {
  return tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['byos-binding-v1',ownerId,consumerId,route])])
}
