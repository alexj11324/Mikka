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

test('unified directory marks named chats unread and bulk-reads only the owner’s admitted chat snapshots', { skip: !enabled }, async t => {
  const { pool } = await import('./db')
  const { changeThreadRead } = await import('./thread-reads')
  const { conversationDirectory } = await import('./conversation-directory')
  const { handleGroup } = await import('./group-conversations-store')
  const owner = randomUUID(), peer = randomUUID()
  const chat = randomUUID(), empty = randomUUID(), foreign = randomUUID(), otherOwner = randomUUID(), ordinary = randomUUID()
  const workspace = randomUUID(), elsewhere = randomUUID()
  const ids = [chat, empty, foreign, otherOwner, ordinary]
  t.after(async () => {
    await pool.query('DELETE FROM conversation_reads WHERE "userId"=ANY($1::text[])', [[owner,peer]])
    await pool.query('DELETE FROM conversations WHERE id=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspace,elsewhere]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner,peer]])
  })
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    SELECT id,id,id||'@example.invalid',false,now(),now() FROM unnest($1::text[]) id`, [[owner,peer]])
  await seedFixtureWorkspace(pool, owner, 'team', workspace)
  await seedFixtureWorkspace(pool, owner, 'team', elsewhere)
  await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,$2,$2,'member')`, [workspace,peer])
  for (const [id, space, author, purpose] of [[chat,workspace,owner,'conversation'],[empty,workspace,owner,'conversation'],
    [foreign,elsewhere,owner,'conversation'],[otherOwner,workspace,peer,'conversation'],[ordinary,workspace,owner,'group']]) {
    await pool.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy","creationPurpose")
      VALUES ($1,$2,'group','Read fixture',$3,$4)`, [id,space,author,purpose])
    await pool.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user',$2,'owner')`, [id,author])
  }
  const mark = (reader: string, space: string, id: string) => changeThreadRead(reader, space, {action:'unread',chatId:id})
  const all = () => changeThreadRead(owner, workspace, {action:'readAll'})
  const state = async (id: string) => (await conversationDirectory(pool,owner,workspace,{})).items.find(row => row.id === id)?.unread
  const receipt = async () => (await pool.query(`SELECT "lastReadPosition","lastReadMessageId" FROM conversation_reads WHERE "userId"=$1 AND "conversationId"=$2`, [owner,chat])).rows[0]
  const append = async (position: number) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body)
      VALUES ($1,$2,$3,'agent',$4,'Reply')`, [id,chat,position,randomUUID()])
    return id
  }
  await append(1)
  assert.equal(await state(chat), true)
  for (const [reader,space,id] of [[peer,workspace,chat],[owner,elsewhere,chat],[owner,workspace,otherOwner],[owner,workspace,ordinary]]) {
    assert.equal(await mark(reader,space,id), false)
  }
  assert.equal(await mark(owner,workspace,empty),true)
  assert.equal(await mark(owner,elsewhere,foreign),true)
  const second = await append(2)
  assert.deepEqual(await Promise.all([all(),all()]),[true,true])
  assert.deepEqual(await receipt(),{lastReadPosition:2,lastReadMessageId:second})
  assert.equal(await state(chat),false)
  assert.equal(await state(empty),false,'an empty chat has no fabricated watermark but clears its explicit mark')
  assert.equal((await pool.query('SELECT "markedUnread" FROM chat_preferences WHERE "userId"=$1 AND "chatKey"=$2',[owner,foreign])).rows[0].markedUnread,true)
  const historyRead = (messageId: string | null, readRevision?: number, id = chat) => handleGroup(pool, async space => space===workspace, {
    method:'POST',resource:'read',id,userId:owner,host:'fixture.local',origin:null,body:JSON.stringify({messageId,readRevision}),
  })
  const observed = async (id = chat) => {
    const history = await handleGroup(pool, async space => space===workspace, {
      method:'GET',resource:'messages',id,userId:owner,host:'fixture.local',origin:null,
    })
    assert.equal(history.status,200)
    return (history.body as { readRevision: number }).readRevision
  }
  const originalRevision = await observed()
  assert.equal(originalRevision,0)
  const third = await append(3)
  assert.equal(await state(chat),true,'activity after read-all remains unread')
  assert.equal((await historyRead(third)).status,200)
  assert.equal(await mark(owner,workspace,chat),true)
  await historyRead(second)
  assert.equal(await state(chat),true,'an earlier observed message cannot clear a newer manual mark')
  assert.deepEqual(await receipt(),{lastReadPosition:3,lastReadMessageId:third})
  await historyRead(third,originalRevision)
  assert.equal(await state(chat),true,'a delayed observation at the same message position cannot erase a subsequent mark')
  assert.equal((await observed()),originalRevision+1)
  await historyRead(third,await observed())
  assert.equal(await state(chat),false,'opening the current transcript end clears the explicit mark')
  const emptyRevision = await observed(empty)
  await mark(owner,workspace,empty)
  assert.equal((await historyRead(null,emptyRevision,empty)).status,200)
  assert.equal(await state(empty),true)
  assert.equal((await historyRead(null,await observed(empty),empty)).status,200)
  assert.equal(await state(empty),false)
  assert.equal((await historyRead(null,await observed())).status,422,'empty acknowledgements require an empty chat')
  const limitId = await append(2147483647), overflow = await append(2147483648)
  assert.equal((await historyRead(overflow,await observed())).status,422)
  assert.equal(await all(),true,'one bigint position beyond the receipt contract does not roll back the other reads')
  assert.deepEqual(await receipt(),{lastReadPosition:2147483647,lastReadMessageId:limitId})
  assert.equal(await state(chat),true,'the unrepresentable message stays unread')
  await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,owner])
  assert.equal(await mark(owner,workspace,chat),false)
  assert.equal(await all(),false)
})
