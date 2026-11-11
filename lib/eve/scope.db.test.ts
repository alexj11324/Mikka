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
    await t.test('known ids grant no cross-owner, cross-Bot or cross-surface access',async()=>{
      await assertSessionScope(scope,sessionId)
      for(const foreign of [{...scope,ownerId:other},{...scope,ownerId:other,botId:otherBot},{...scope,workspaceId:randomUUID()},{...scope,surface:'slack' as const}])await assert.rejects(assertSessionScope(foreign,sessionId))
      await assert.rejects(registerSession({...scope,ownerId:other,botId:otherBot},sessionId),/workspaceAccessDenied/)
    })
    await t.test('historic user/assistant rows import once without deletion or forged tool turns',async()=>{
      const historic=[{role:'user',content:'Original request'},{role:'assistant',content:[{type:'text',text:'Original response'}]},{role:'tool',content:[{type:'tool-result',toolCallId:'old',output:{type:'text',value:'old result'}}]}]
      for(const [index,message]of historic.entries())await pool.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message)VALUES($1,$2,$3,$4,$5)',[randomUUID(),ownerId,botId,index+1,message])
      assert.deepEqual((await priorHistory(scope)).map(({role,text})=>({role,text})),[{role:'user',text:'Original request'},{role:'assistant',text:'Original response'}])
      assert.deepEqual(await priorHistory({...scope,surface:'slack'}),[])
      assert.equal((await pool.query('SELECT 1 FROM coordinator_messages WHERE "userId"=$1',[ownerId])).rowCount,3)
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
