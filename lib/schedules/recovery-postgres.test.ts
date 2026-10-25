import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ScheduleStore, type WorkspaceGuard } from './store'
import { ScheduleError, type Actor, type Definition } from './contract'
const url=process.env.SCHEDULE_RECOVERY_TEST_DATABASE_URL
if(!url||new URL(url).hostname!=='127.0.0.1'||!new URL(url).pathname.endsWith('179_recovery'))throw new Error('isolated loopback recovery PG required')
const pool=new Pool({connectionString:url,max:15}),members=new Pool({connectionString:url,max:15})
const guard:WorkspaceGuard=async(owner,workspace,work)=>{
 const tx=await members.connect()
 try{await tx.query('BEGIN');const rows=await tx.query(`SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR UPDATE`,[workspace,owner]);if(!rows.rowCount)throw new ScheduleError('scheduleWorkspaceAccessDenied',403);const result=await work();await tx.query('COMMIT');return result}
 catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
}
let now=new Date('2035-01-01T00:00:00Z')
const executor={enabled:()=>true,read:async()=>{await pool.query('INSERT INTO schedule_recovery_effects(id) VALUES($1)',[randomUUID()]);return {text:'CONTROLLED REAL PG EFFECT; NO MODEL OR PROVIDER'}}}
const store=()=>new ScheduleStore(pool,guard,()=>now,executor)
async function fixture():Promise<Actor>{
 const owner=`recovery-${randomUUID()}`,workspace=randomUUID(),session=randomUUID(),source=randomUUID()
 await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())`,[owner,`${owner}@example.invalid`])
 await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'recovery fixture\')',[workspace,owner])
 await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,'admin')`,[workspace,owner,`${owner}@example.invalid`])
 await pool.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'recovery original chat\')',[session,owner])
 await pool.query(`INSERT INTO agent_turns(id,"sessionId","userId",prompt,status,"attemptId") VALUES($1,$2,$3,'controlled recovery request','complete',$1)`,[source,session,owner])
 return {ownerId:owner,workspaceId:workspace,conversation:'bot',sessionId:session,sourceId:source}
}
const definition=(task:Definition['task'],misfire:Definition['misfire']='skip'):Definition=>({title:'recovery fixture',timezone:'Etc/UTC',timing:{kind:'once',at:new Date(now.getTime()+60000).toISOString()},task,misfire,maxLatenessMinutes:1})
async function create(actor:Actor,def:Definition){return (await store().command(actor,{action:'create',requestId:randomUUID(),definition:def}) as any).schedule}
async function occurrence(id:string){return (await pool.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[id])).rows[0]}
async function fault(session:string,once:boolean){
 const name=`recovery_${randomUUID().replaceAll('-','')}`
 await pool.query(`CREATE SEQUENCE ${name}`)
 await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."sessionId"='${session}'::uuid AND ${once?`nextval('${name}')=1`:'true'} THEN RAISE EXCEPTION 'controlled real PG report fault'; END IF; RETURN NEW; END $$`)
 await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION ${name}()`)
 return async()=>{await pool.query(`DROP TRIGGER ${name} ON agent_turns`)}
}

test('recovery P2s use actual PG report faults, effects and permission rows',async t=>{
 try{
  await pool.query('CREATE TABLE IF NOT EXISTS schedule_recovery_effects(id uuid PRIMARY KEY,at timestamptz DEFAULT now())')
  const actor=await fixture(),issue=randomUUID()
  await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'real snapshot fixture','{}','todo','normal')`,[issue,actor.ownerId])
  for(const task of [{kind:'reminder',text:'MUST NOT EXECUTE'}, {kind:'issue_snapshot',issueId:issue}, {kind:'agent_read',prompt:'MUST NOT EXECUTE',allowedActions:[]}] as Definition['task'][]){
   await t.test(`immutable skip after real report fault and restarted ${task.kind}`,async()=>{
    const before=Number((await pool.query('SELECT count(*) n FROM schedule_recovery_effects')).rows[0].n)
    const s=await create(actor,definition(task));now=new Date(now.getTime()+180001)
    const remove=await fault(actor.sessionId,true)
    try{await store().tick()}finally{await remove()}
    const pending=await occurrence(s.id);assert.equal(pending.status,'pending');assert.equal(pending.error,'scheduleExecutionUnavailable')
    now=new Date(now.getTime()+31000)
    await Promise.all(Array.from({length:10},()=>store().tick()))
    const final=await occurrence(s.id),after=Number((await pool.query('SELECT count(*) n FROM schedule_recovery_effects')).rows[0].n)
    console.log(JSON.stringify({evidence:'real report fault then fresh process-store retry',task:task.kind,occurrenceId:final.id,operationId:final.operation_id,status:final.status,result:final.result,effects:after-before}))
    assert.equal(final.status,'skipped');assert.equal(final.result,null);assert.equal(after,before)
    await assert.rejects(pool.query("UPDATE schedule_occurrences SET execution_decision='execute' WHERE id=$1",[final.id]),/immutable/)
    assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[final.operation_id])).rows[0].n,1)
    assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_events WHERE id=$1',[final.id])).rows[0].n,1)
   })
  }
  await t.test('catch_up_once still executes after the same report fault without duplicate logical output',async()=>{
   const s=await create(actor,definition({kind:'reminder',text:'AUTHORIZED CATCH UP'},'catch_up_once'));now=new Date(now.getTime()+180001)
   const remove=await fault(actor.sessionId,true);try{await store().tick()}finally{await remove()}
   now=new Date(now.getTime()+31000);await store().tick();const row=await occurrence(s.id)
   assert.equal(row.status,'succeeded');assert.deepEqual(row.result,{text:'AUTHORIZED CATCH UP'})
   assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[row.operation_id])).rows[0].n,1)
  })
  await t.test('more than LIMIT denied reports cannot starve a later authorized tenant after restart',async()=>{
   const denied=await fixture(),healthy=await fixture();const blocked=[]
   for(let n=0;n<30;n++)blocked.push(await create(denied,definition({kind:'reminder',text:'PRIVATE REVOKED'},'catch_up_once')))
   now=new Date(now.getTime()+61000);await store().materialize(50)
   await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1`,[denied.workspaceId])
   for(let n=0;n<30;n++){const claim=await store().claim();assert.ok(claim);await store().execute(claim)}
   const noChat=await fixture()
   for(let n=0;n<2;n++)await create(noChat,definition({kind:'reminder',text:'PRIVATE MISSING CHAT'},'catch_up_once'))
   await pool.query('UPDATE agent_sessions SET "userId"=$2 WHERE id=$1',[noChat.sessionId,denied.ownerId])
   now=new Date(now.getTime()+61000);await store().materialize(50)
   for(let n=0;n<2;n++){const claim=await store().claim();assert.ok(claim);await store().execute(claim)}
   const s=await create(healthy,definition({kind:'reminder',text:'legitimate failed report'},'catch_up_once'));now=new Date(now.getTime()+61000)
   const remove=await fault(healthy.sessionId,false)
   try{for(let n=0;n<3;n++){await store().tick(50);now=new Date(now.getTime()+120000)}}finally{await remove()}
   const row=await occurrence(s.id);assert.equal(row.status,'failed');assert.equal(row.reported_at,null)
   // A real committed failure whose publication failed sits after the denied
   // prefix. Keep all permission checks enabled; never mark denial as success.
   await pool.query(`UPDATE schedule_occurrences o SET finished_at=$2 FROM user_schedules s WHERE s.id=o.schedule_id AND s.owner_id=ANY($1::text[])`,[[denied.ownerId,noChat.ownerId],new Date(now.getTime()-86400000)])
   if((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='schedule_occurrences' AND column_name='report_next_at'`)).rowCount){
    await pool.query('UPDATE schedule_occurrences SET report_next_at=$1 WHERE reported_at IS NULL',[new Date(now.getTime()-1000)])
   }
   const ready=Number((await pool.query("SELECT count(*) n FROM schedule_occurrences WHERE status='failed' AND reported_at IS NULL")).rows[0].n)
   const scans=Math.ceil(ready/25)+1
   for(let n=0;n<scans;n++)await store().flushFailedReports(25)
   const reportCount=(await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[row.operation_id])).rows[0].n
   console.log(JSON.stringify({evidence:'denied prefix before legal tenant',deniedCount:blocked.length+2,queued:ready,scans,limit:25,healthyOccurrence:row.id,healthyReports:reportCount,deniedOwner:denied.ownerId,healthyOwner:healthy.ownerId}))
   assert.equal(reportCount,1)
   assert.equal((await pool.query(`SELECT count(*)::int n FROM agent_turns WHERE "userId"=$1 AND prompt LIKE '[Schedule]%'`,[denied.ownerId])).rows[0].n,0)
   await Promise.all(Array.from({length:10},()=>store().flushFailedReports(25)))
   assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[row.operation_id])).rows[0].n,1)
   await assert.rejects(store().command({...healthy,workspaceId:denied.workspaceId},{action:'history',scheduleId:s.id}),/scheduleWorkspaceAccessDenied/)
   const retry=(await pool.query('SELECT report_next_at,report_attempts FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id WHERE s.owner_id=$1 LIMIT 1',[denied.ownerId])).rows[0]
   assert.ok(retry.report_next_at>now);assert.ok(retry.report_attempts>0)
   await pool.query('UPDATE agent_sessions SET "userId"=$2 WHERE id=$1',[noChat.sessionId,noChat.ownerId])
   now=new Date(now.getTime()+21601000)
   await store().flushFailedReports(100)
   await Promise.all(Array.from({length:10},()=>store().flushFailedReports(100)))
   assert.equal((await pool.query(`SELECT count(*)::int n FROM agent_turns WHERE "userId"=$1 AND prompt LIKE '[Schedule]%'`,[noChat.ownerId])).rows[0].n,2)

  })
 }finally{await pool.end();await members.end()}
})
