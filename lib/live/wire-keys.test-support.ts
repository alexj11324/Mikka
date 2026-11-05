import assert from 'node:assert/strict'
import { liveInvalidations, type LiveInvalidation } from './events'

/** Test support: every pushed key is a kind and an id, plus at most a positive
 * revision on a revision kind (never content). Returns the keys without revisions,
 * so a test compares which keys went where; `revisions` collects what was attached. */
export function wireKeys(body: unknown, message = 'a key carries a kind, an id and at most its revision', revisions?: LiveInvalidation[]): LiveInvalidation[] {
  const events = liveInvalidations(body, true)
  assert.ok(events, message)
  for (const event of events) assert.ok(['id,kind', 'id,kind,rev'].includes(Object.keys(event).sort().join(',')), message)
  revisions?.push(...events.filter(event => event.rev !== undefined))
  return events.map(({ kind, id }) => ({ kind, id }))
}
