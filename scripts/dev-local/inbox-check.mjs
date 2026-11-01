// The subscribed-task inbox's existing product action, driven from a bounded
// CLI in the owning disposable local harness. No rows or sessions are seeded.
import assert from 'node:assert/strict'
import { assertDevLocal } from './guard.mjs'
import { actAs } from '../../lib/acting-user.ts'
import { toggleIssuePreference } from '../../app/actions/issue-operations.ts'
import { pool } from '../../lib/db/index.ts'
import { workspacePool } from '../../lib/workspace-db.ts'

assertDevLocal(process.env)
const [owner, peer, issueId] = process.argv.slice(2)
try {
  assert.ok(owner && peer && issueId)
  const subscribed = await actAs(owner, () => toggleIssuePreference({ id: issueId, kind: 'subscribe' }))
  assert.ok(subscribed.issue?.metadata.subscriberUserIds.includes(owner), 'Subscribe action did not add the owner to the inbox')
  const stored = (await pool.query('SELECT content FROM issues WHERE id=$1', [issueId])).rows[0]
  assert.ok(stored.content.attrs.mikka.subscriberUserIds.includes(owner), 'Inbox subscription was not durable')
  const denied = await actAs(peer, () => toggleIssuePreference({ id: issueId, kind: 'subscribe' }))
  assert.equal(denied.error, 'issueNotFound', 'An unrelated identity subscribed a private task')
  const unsubscribed = await actAs(owner, () => toggleIssuePreference({ id: issueId, kind: 'subscribe' }))
  assert.ok(!unsubscribed.issue?.metadata.subscriberUserIds.includes(owner), 'Unsubscribe left the task in the inbox')
  console.log('inbox subscribe, durable read, ownership and unsubscribe passed')
} finally {
  await pool.end()
  if (workspacePool !== pool) await workspacePool.end()
}
