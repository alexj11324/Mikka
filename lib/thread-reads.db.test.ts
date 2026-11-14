import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'

const enabled = disposableDatabase()
if (!enabled && process.env.REQUIRE_DB === '1') throw new Error('Thread reads require an isolated _e2e database')

test('run read receipts preserve new replies and explicit unread marks across clients and tenants', { skip: !enabled }, async t => {
  const { pool } = await import('./db')
  const { changeThreadRead, threadReadReceipts } = await import('./thread-reads')
  const owner = randomUUID(), peer = randomUUID(), agent = randomUUID(), run = randomUUID(), other = randomUUID()
  const first = '2026-11-13T09:00:00.010Z', finish = '2026-11-13T09:01:00.012Z'
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,false,now(),now()),($3,$3,$4,false,now(),now())',
    [owner, owner + '@example.invalid', peer, peer + '@example.invalid'])
  const workspace = await seedFixtureWorkspace(pool, owner, 'team'), elsewhere = await seedFixtureWorkspace(pool, owner)
  t.after(async () => {
    await pool.query('DELETE FROM conversation_reads WHERE "userId"=ANY($1::text[])', [[owner, peer]])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspace, elsewhere]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  })
  await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$2,\'member\')', [workspace, peer])
  await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Fixture\',\'codex\')', [agent, owner])
  await pool.query('INSERT INTO agent_runs(id,"userId","workspaceId","agentId","lastReplyAt") VALUES($1,$3,$4,$6,$7),($2,$3,$5,$6,$7)', [run, other, owner, workspace, elsewhere, agent, first])
  const receipt = async (id = run) => (await threadReadReceipts(owner, [id]))[0]!
  const open = await receipt()
  assert.deepEqual(open, { id: run, through: first, revision: 0, unread: true })
  assert.equal(await changeThreadRead(peer, workspace, { action: 'unread', runId: run }), false)
  assert.equal(await changeThreadRead(owner, elsewhere, { action: 'unread', runId: run }), false)
  await pool.query('UPDATE agent_runs SET "finishedAt"=$2,status=\'succeeded\' WHERE id=$1', [run, finish])
  await changeThreadRead(owner, workspace, { action: 'read', runId: run, through: open.through, revision: open.revision })
  assert.equal((await receipt()).unread, true, 'an unseen completion stays unread')
  await changeThreadRead(owner, workspace, { action: 'readAll' })
  assert.equal((await receipt()).unread, false)
  assert.equal((await receipt(other)).unread, true, 'bulk read leaves another workspace alone')
  await changeThreadRead(owner, workspace, { action: 'unread', runId: run })
  await changeThreadRead(owner, workspace, { action: 'read', runId: run, through: finish, revision: open.revision })
  const manual = await receipt()
  assert.equal(manual.unread, true, 'a delayed read cannot erase another device’s manual mark')
  await changeThreadRead(owner, workspace, { action: 'read', runId: run, through: finish, revision: manual.revision })
  assert.equal((await receipt()).unread, false)
})
