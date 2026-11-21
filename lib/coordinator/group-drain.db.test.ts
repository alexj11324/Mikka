import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { hostedBillingScope } from '../abuse/context'
import { handleGroup } from '../group-conversations-store'

test('draining a group looks up its workspace once and bills each message to its sender', { skip: !dbUrl }, async t => {
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  t.after(async () => { await Promise.all([pool.end(), workspacePool.end()]) })
  const owner = await seedUser(pool, 'group-owner')
  const peer = await seedUser(pool, 'group-peer')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const agent = await seedAgent(pool, owner)
  const request = { method: 'POST' as const, origin: 'http://localhost', host: 'localhost' }
  const group = await handleGroup(pool, async () => true, {
    ...request, userId: owner, resource: 'conversations', body: JSON.stringify({
      workspaceId: workspace.id, title: 'Group drain', members: [{ memberType: 'agent', memberId: agent }, { memberType: 'user', memberId: peer }],
    }),
  }, true)
  assert.equal(group.status, 201)
  const { id } = group.body as { id: string }
  for (const sender of [owner, peer]) {
    const message = await handleGroup(pool, async () => true, {
      ...request, userId: sender, resource: 'messages', id,
      body: JSON.stringify({ body: 'Please reply', mentions: [{ memberType: 'agent', memberId: agent }] }),
    }, true)
    assert.equal(message.status, 201)
  }

  const { groupRuntime } = await import('./group-runtime')
  const payers: ReturnType<typeof hostedBillingScope.getStore>[] = []
  t.mock.module('./group-runtime', { namedExports: { groupRuntime: {
    authorized: groupRuntime.authorized,
    agents: groupRuntime.agents,
    generate: async () => {
      payers.push(hostedBillingScope.getStore())
      return { text: 'Reply', mentions: [] }
    },
  } } })
  const { drainGroupTurns } = await import('../group-conversations-route')
  const query = pool.query
  let workspaceReads = 0
  t.mock.method(pool, 'query', function (...args: unknown[]) {
    if (args[0] === 'SELECT "workspaceId" FROM conversations WHERE id=$1') workspaceReads++
    return Reflect.apply(query, pool, args)
  })
  const foreignScope = { workspaceId: randomUUID(), ownerId: 'unrelated', creditShareOwnerId: 'unrelated' }
  await hostedBillingScope.run(foreignScope, () => drainGroupTurns(id, Date.now() + 60_000))
  assert.deepEqual(payers, [{ workspaceId: workspace.id, ownerId: owner }, { workspaceId: workspace.id, ownerId: peer }])
  assert.equal(workspaceReads, 1)
  await drainGroupTurns(id, Date.now())
  assert.equal(workspaceReads, 1, 'an expired drain does not start a turn')
})
