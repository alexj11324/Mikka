import type { PoolClient } from 'pg'
import { isLiveRevisionKind, LIVE_ID, type LiveInvalidation, type LiveKind } from './events'

type Database = Pick<PoolClient, 'query'>
export type LiveRef = { kind: LiveKind; id: string }
/** `${kind}:${id}` → the revision a read saw before reading its data. */
export type LiveRevisions = Record<string, number>
export const liveRevisionKey = (kind: LiveKind, id: string) => `${kind}:${id}`

const refs = (values: readonly LiveRef[]) => {
  const unique = new Map<string, LiveRef>()
  for (const value of values) if (isLiveRevisionKind(value.kind) && LIVE_ID.test(value.id)) unique.set(liveRevisionKey(value.kind, value.id.toLowerCase()), { kind: value.kind, id: value.id.toLowerCase() })
  return [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
}

/**
 * Raise each key's counter once, after its change has committed and before its
 * push is sent. A reader reads the counter before its data, so data read at
 * revision R contains every change whose push carries R or less. A value the
 * writer assigned inside its transaction (a sequence, `now()`) could commit out
 * of order and would let a newer reader skip a change it never saw.
 *
 * One autocommitted statement in key order: no lock outlives it, and two
 * publishers cannot deadlock.
 */
export async function bumpLiveRevisions(database: Database, values: readonly LiveRef[]): Promise<LiveRevisions> {
  const keys = refs(values)
  if (!keys.length) return {}
  const { rows } = await database.query<{ kind: LiveKind; id: string; revision: string }>(
    `INSERT INTO live_revisions (kind, id)
      SELECT k, i FROM unnest($1::text[], $2::uuid[]) AS t(k, i) ORDER BY k, i
      ON CONFLICT (kind, id) DO UPDATE SET revision = live_revisions.revision + 1
      RETURNING kind, id::text AS id, revision`, [keys.map(key => key.kind), keys.map(key => key.id)])
  return Object.fromEntries(rows.map(row => [liveRevisionKey(row.kind, row.id), Number(row.revision)]))
}

/** The counters for these keys, read before the data they describe. A key never raised is absent (always read). */
export async function readLiveRevisions(database: Database, values: readonly LiveRef[]): Promise<LiveRevisions> {
  const keys = refs(values)
  if (!keys.length) return {}
  const { rows } = await database.query<{ kind: LiveKind; id: string; revision: string }>(
    `SELECT r.kind, r.id::text AS id, r.revision FROM live_revisions r
      JOIN unnest($1::text[], $2::uuid[]) AS t(k, i) ON r.kind = t.k AND r.id = t.i`, [keys.map(key => key.kind), keys.map(key => key.id)])
  return Object.fromEntries(rows.map(row => [liveRevisionKey(row.kind, row.id), Number(row.revision)])
    .filter(([, revision]) => Number.isSafeInteger(revision) && (revision as number) > 0))
}

export function withLiveRevisions(events: readonly LiveInvalidation[], revisions: LiveRevisions): LiveInvalidation[] {
  return events.map(event => {
    const rev = revisions[liveRevisionKey(event.kind, event.id.toLowerCase())]
    return rev ? { kind: event.kind, id: event.id, rev } : { kind: event.kind, id: event.id }
  })
}

/** The client side: the held revision of one entity in a read's `live.revisions`. */
export function heldRevision(read: { live?: { revisions?: LiveRevisions } } | undefined | null, kind: LiveKind, id: string | null | undefined): number | undefined {
  if (!id) return undefined
  const value = read?.live?.revisions?.[liveRevisionKey(kind, id.toLowerCase())]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
