// The subscribed-task inbox's existing product action, driven from a bounded
// CLI in the owning disposable local harness. No rows or sessions are seeded.
import assert from 'node:assert/strict'
import { assertDevLocal } from './guard.mjs'
import { actAs } from '../../lib/acting-user.ts'
import { toggleIssuePreference } from '../../app/actions/issue-operations.ts'
import { pool } from '../../lib/db/index.ts'
import { workspacePool } from '../../lib/workspace-db.ts'
import { createRequestScope, runRequestScope } from '../../apps/api/src/context.ts'

assertDevLocal(process.env)
const [owner, peer, issueId] = process.argv.slice(2)
async function subscribeAs(userId) {
  const scope = createRequestScope(new Request('http://127.0.0.1/mikka/acceptance/inbox'))
  return runRequestScope(scope, async () => {
    try { return await actAs(userId, () => toggleIssuePreference({ id: issueId, kind: 'subscribe' })) }
    finally { await scope.after.finish() }
  })
}
try {
  assert.ok(owner && peer && issueId)
  const subscribed = await subscribeAs(owner)
  assert.ok(subscribed.issue?.metadata.subscriberUserIds.includes(owner), 'Subscribe action did not add the owner to the inbox')
  const stored = (await pool.query('SELECT content FROM issues WHERE id=$1', [issueId])).rows[0]
  assert.ok(stored.content.attrs.mikka.subscriberUserIds.includes(owner), 'Inbox subscription was not durable')
  const denied = await subscribeAs(peer)
  assert.equal(denied.error, 'issueNotFound', 'An unrelated identity subscribed a private task')
  const unsubscribed = await subscribeAs(owner)
  assert.ok(!unsubscribed.issue?.metadata.subscriberUserIds.includes(owner), 'Unsubscribe left the task in the inbox')
  console.log('inbox subscribe, durable read, ownership and unsubscribe passed')
} finally {
  // The real post-commit notification opens this process's LISTEN/NOTIFY bus.
  // Its dedicated connection is independent of the application pools below.
  await (await import('../../lib/builtin-gateway/runtime.ts')).builtinGateway()?.stop()
  await pool.end()
  if (workspacePool !== pool) await workspacePool.end()
}
