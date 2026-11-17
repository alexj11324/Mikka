import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import { seedAgent, seedRun } from '../tests/support/workspace-admin-db'

// Database regressions run in CI against the ephemeral Postgres 17; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('a person archives, restores and deletes their own bot; the Coordinator and other people\'s bots stay', async t => {
  const [{ createRequestDatabaseScope, pool }, lifecycle, { listOwnerBots }, { ActionFailureError }] = await Promise.all([
    import('./db'), import('./bot-lifecycle'), import('./coordinator/coordinator-bot'), import('./action-error')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  t.after(() => scope.close())
  await scope.run(async () => {
    const owner = `bot-lifecycle-${randomUUID()}`, stranger = `bot-lifecycle-${randomUUID()}`
    for (const id of [owner, stranger]) await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Lifecycle fixture',$2,true,now(),now())`, [id, `${id}@example.invalid`])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    const [{ id: coordinatorId }] = await listOwnerBots(owner, workspaceId)
    const botId = randomUUID()
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Writer')`, [botId, workspaceId, owner])
    const notFound = (error: unknown) => error instanceof ActionFailureError && error.code === 'botNotFound'

    // Archive: off the person's list, into their archived list; restore brings it back.
    await lifecycle.setOwnedBotArchived({ ownerId: owner, workspaceId }, botId, true)
    assert.deepEqual((await listOwnerBots(owner, workspaceId)).map(bot => bot.id), [coordinatorId])
    assert.deepEqual((await lifecycle.ownArchivedBots({ ownerId: owner, workspaceId })).map(bot => bot.id), [botId])
    await lifecycle.setOwnedBotArchived({ ownerId: owner, workspaceId }, botId, false)
    assert.deepEqual((await listOwnerBots(owner, workspaceId)).map(bot => bot.id).sort(), [coordinatorId, botId].sort())
    assert.deepEqual(await lifecycle.ownArchivedBots({ ownerId: owner, workspaceId }), [])

    // Neither the Coordinator nor someone else's bot can be archived or deleted.
    await assert.rejects(lifecycle.setOwnedBotArchived({ ownerId: owner, workspaceId }, coordinatorId, true), notFound)
    await assert.rejects(lifecycle.deleteOwnedBot({ ownerId: owner, workspaceId }, coordinatorId), notFound)
    await assert.rejects(lifecycle.deleteOwnedBot({ ownerId: stranger, workspaceId }, botId), notFound)

    // Delete: the bot and its chat go; a group it was in and a run it dispatched stay, without it.
    const groupId = randomUUID()
    await pool.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy","leadBotId") VALUES ($1,$2,'group','Design review',$3,$4)`, [groupId, workspaceId, owner, botId])
    await pool.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user',$2,'owner'),($1,'bot',$3,'member')`, [groupId, owner, botId])
    await pool.query(`INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($3,$1,$2,1,'{"role":"user","content":"hi"}')`, [owner, botId, randomUUID()])
    const runId = await seedRun(pool, { userId: owner, agentId: await seedAgent(pool, owner), workspaceId, botId })
    await pool.query(`INSERT INTO chat_preferences ("userId","chatKey",pinned) VALUES ($1,$2,true)`, [owner, botId])
    await lifecycle.deleteOwnedBot({ ownerId: owner, workspaceId }, botId)
    assert.equal((await pool.query('SELECT 1 FROM bots WHERE id=$1', [botId])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM coordinator_messages WHERE "botId"=$1', [botId])).rowCount, 0, 'its chat goes')
    assert.equal((await pool.query('SELECT 1 FROM chat_preferences WHERE "chatKey"=$1', [botId])).rowCount, 0)
    assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [runId])).rows, [{ botId: null }], 'its runs stay')
    assert.deepEqual((await pool.query('SELECT "leadBotId" FROM conversations WHERE id=$1', [groupId])).rows, [{ leadBotId: null }])
    assert.ok((await pool.query(`SELECT "leftAt" FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='bot'`, [groupId])).rows[0].leftAt, 'it left the group')
    await assert.rejects(lifecycle.deleteOwnedBot({ ownerId: owner, workspaceId }, botId), notFound)
  })
})
