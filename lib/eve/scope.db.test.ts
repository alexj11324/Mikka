import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {disposableDatabase} from '../../tests/helpers/e2e-target.mjs'

const valid=disposableDatabase() && process.env.E2E_DATABASE_URL===process.env.MIKKA_DATABASE_URL && process.env.E2E_DATABASE_URL===process.env.DATABASE_URL
if(process.env.REQUIRE_DB==='1'&&!valid)throw new Error('Eve ownership tests require matching isolated loopback _e2e databases')
test('eve sessions keep Bot, Workspace, owner and surface authorization after import and replay',{skip:!valid},async t=>{
  const {pool}=await import('../db')
  await pool.query(await readFile(new URL('../../drizzle/20261112030100_eve_sessions.sql',import.meta.url),'utf8'))
  const {assertEveScope,assertSessionScope,registerSession}=await import('./scope')
  const {priorHistory}=await import('./history')
  const {projectTurnState}=await import('./projection')
  const workspaceId=randomUUID(),botId=randomUUID(),otherBot=randomUUID(),ownerId='eve-owner-'+randomUUID(),other='eve-other-'+randomUUID(),sessionId='wrun_'+randomUUID()
  const scope={ownerId,botId,workspaceId,surface:'web' as const}
  try{
    for(const owner of [ownerId,other])await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Eve owner fixture',$2,true,now(),now())`,[owner,owner+'@example.invalid'])
    await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name)VALUES($1,$2,'Eve fixture')`,[workspaceId,ownerId])
    for(const owner of [ownerId,other])await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role)VALUES($1,$2,'Owner',$3,'admin')`,[workspaceId,owner,owner+'@example.invalid'])
    for(const [id,owner]of [[botId,ownerId],[otherBot,other]])await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name)VALUES($1,$2,$3,\'Eve bot fixture\')',[id,owner,workspaceId])
    await registerSession(scope,sessionId)
    await t.test('event ingress registers its session once before native delivery', async t => {
      const { mikkaEveChannel } = await import('./channel')
      const { internalEveAuthorization } = await import('./auth')
      const { conversationAddress } = await import('./scope')
      const { routes } = mikkaEveChannel()
      const route = routes.find(route => route.transport !== 'websocket' && route.path === '/eve/v1/mikka/events')
      assert.ok(route && route.transport !== 'websocket')
      t.mock.property(process, 'env', { ...process.env, MIKKA_API_INGRESS: '', MIKKA_EVE_HOST: '', BETTER_AUTH_SECRET: randomUUID() })
      for (const scheduled of [false, true]) {
        const eventId = randomUUID(), id = 'wrun_' + randomUUID()
        const report = 'r'.repeat(8192)
        await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier,"deliveredAt")
          VALUES($1,$2,$3,'run_report',$4,$5,'attention',now())`, [eventId, ownerId, botId, eventId, scheduled ? {source:'schedule_due', text:report} : {text:report}])
        const queries = t.mock.method(pool, 'query')
        try {
          const session = {
            id,
            async send(message: string, options: {idempotencyKey: string}) {
              assert.ok(message.includes(report), 'delivery includes the complete stored report')
              await assertSessionScope(scope, id)
              assert.equal(options.idempotencyKey, 'mikka-event:' + eventId)
              return { sessionId: id, deliveryId: eventId }
            },
          }
          const args = {
            from(address: string) {
              assert.equal(address, conversationAddress(scope) + (scheduled ? ':schedule:' + eventId : ''))
              return { create: async () => ({session}) }
            },
          } as unknown as Parameters<typeof route.handler>[1]
          const response = await route.handler(new Request('https://app.example/eve/v1/mikka/events', {
            method: 'POST', headers: {authorization:internalEveAuthorization(scope)}, body:JSON.stringify({eventId}),
          }), args)
          assert.equal(response.status, 200)
          assert.deepEqual(await response.json(), {ok:true, sessionId:id, deliveryId:eventId})
          const eventReads = queries.mock.calls.filter(call => /SELECT .* FROM coordinator_events WHERE id=/i.test(String(call.arguments[0])))
          const rows = await Promise.all(eventReads.map(async call => {
            const result = await (call.result as unknown as Promise<{rows: unknown[]}>)
            return JSON.stringify(result.rows)
          }))
          assert.equal(rows.filter(row => row.includes(report)).length, 1, 'read the full report only for delivery')
          t.diagnostic(`Event query result bytes (${scheduled ? 'scheduled' : 'ordinary'}): ${rows.map(row => Buffer.byteLength(row)).join(', ')}`)
          const registrations = queries.mock.calls.filter(call => String(call.arguments[0]).includes('INSERT INTO eve_sessions'))
          assert.equal(registrations.length, 1, scheduled ? 'scheduled ingress' : 'ordinary ingress')
        } finally {
          queries.mock.restore()
          await pool.query('DELETE FROM coordinator_events WHERE id=$1', [eventId])
        }
      }
    })
    await t.test('a message composed under a different browser account is refused before its input is persisted', async () => {
      const { acceptEveMessage } = await import('./submission')
      const request = new Request('https://mikka.example.invalid/eve/v1/session/' + sessionId)
      await assert.rejects(acceptEveMessage(scope, 'Wrong account', { expectedOwnerId: other }, request), /workspaceAccessDenied/)
      const messages = await pool.query('SELECT 1 FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [ownerId, botId])
      assert.equal(messages.rowCount, 0)
    })
    await t.test('known ids grant no cross-owner, cross-Bot or cross-surface access',async()=>{
      await assertSessionScope(scope,sessionId)
      for(const foreign of [{...scope,ownerId:other},{...scope,ownerId:other,botId:otherBot},{...scope,workspaceId:randomUUID()},{...scope,surface:'slack' as const}])await assert.rejects(assertSessionScope(foreign,sessionId))
      await assert.rejects(registerSession({...scope,ownerId:other,botId:otherBot},sessionId),/workspaceAccessDenied/)
    })
    await t.test('legacy history imports ordered text and leaves rich rows intact', async t => {
      const excluded = 'private tool result '.repeat(512)
      const history = [
        {role:'user', content:'  Original request  ', metadata:excluded},
        {role:'assistant', content:[null, {type:'text',text:'First'}, {type:'image', data:excluded}, {type:'text',text:42}, {type:'text',text:''}, {type:'text',text:'Last'}]},
        {role:'tool', content:[{type:'tool-result',output:excluded}]},
        {role:'assistant', content:'  '},
        {role:'user', content:{text:'not a text part'}},
      ]
      const ids = history.map(() => randomUUID())
      for (const [index, message] of history.entries()) {
        await pool.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message)VALUES($1,$2,$3,$4,$5)',[ids[index],ownerId,botId,index+1,message])
      }
      const queries = t.mock.method(pool, 'query')
      const imported = await priorHistory(scope)
      assert.deepEqual(imported, [
        {id:ids[0], role:'user', text:'  Original request  '},
        {id:ids[1], role:'assistant', text:'First\n\nLast'},
      ])
      assert.equal(queries.mock.callCount(), 1)
      const result = await (queries.mock.calls[0]!.result as unknown as Promise<{rows: unknown[]}>)
      const transferred = JSON.stringify(result.rows)
      t.diagnostic(`Legacy history query rows: ${result.rows.length}; JSON bytes: ${Buffer.byteLength(transferred)}`)
      assert.ok(!transferred.includes(excluded), 'exclude rich content from the history query result')
      assert.deepEqual(await priorHistory({...scope,surface:'slack'}),[])
      assert.equal(queries.mock.callCount(), 1, 'Slack performs no legacy web history read')
      queries.mock.restore()
      assert.deepEqual((await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position',[ownerId,botId])).rows.map(row => row.message), history)
    })
    await t.test('a stale session settlement cannot clear the active user session; mirror commits once',async()=>{
      await registerSession(scope,'wrun_stale_'+sessionId)
      await projectTurnState(scope,sessionId,'user-turn',true)
      await projectTurnState(scope,'wrun_stale_'+sessionId,'old-turn',false)
      assert.equal((await pool.query('SELECT "leaseHolder" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2',[ownerId,botId])).rows[0].leaseHolder,sessionId)
      const message=[{role:'assistant',content:'Native eve reply',mikkaStreamId:`eve:${sessionId}:user-turn`}]
      await projectTurnState(scope,sessionId,'user-turn',false,message)
      await projectTurnState(scope,sessionId,'user-turn',false,message)
      assert.equal((await pool.query('SELECT 1 FROM coordinator_messages WHERE "userId"=$1 AND message->>\'content\'=\'Native eve reply\'',[ownerId])).rowCount,1)
    })
    await t.test('membership revocation removes existing session authority',async()=>{
      await pool.query('UPDATE mikka_workspace_members SET status=\'inactive\' WHERE "workspaceId"=$1 AND "userId"=$2',[workspaceId,ownerId])
      await assert.rejects(assertEveScope(scope))
      await assert.rejects(assertSessionScope(scope,sessionId))
    })
  }finally{
    await pool.query('DELETE FROM bots WHERE id=ANY($1::uuid[])',[[botId,otherBot]])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1',[workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[[ownerId,other]])
  }
})
