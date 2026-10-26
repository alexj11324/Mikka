import {test} from 'node:test'
import {registerHooks} from 'node:module'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {spawn} from 'node:child_process'
import {Pool} from 'pg'
import {ScheduleStore,type WorkspaceGuard} from './store'
import {resourceFixture,isolatedResourceUrls} from '../resources/test-fixtures'
import {AGENT_ROUTE} from '../policy/model'
import type {Actor,Definition} from './contract'
import {QuotaStore} from '../quota/store'

test('scheduled read: formal provider SDK over controlled transport, separate outcome/publication and OS loss',async t=>{
 const urls=isolatedResourceUrls()
 Object.assign(process.env,{MIKKA_DATABASE_URL:urls.app,DATABASE_URL:urls.workspace,CI:'true',BETTER_AUTH_SECRET:'isolated-resource-proof-no-production-authorization-123456789',BETTER_AUTH_URL:'http://127.0.0.1:3180',MIKKA_RESOURCE_TEST_ORIGIN:'http://127.0.0.1:6181',MIKKA_SCHEDULE_AGENT_ENABLED:'1',MIKKA_RUNTIME_SWEEP_ENABLED:'1'})
 const app=new Pool({connectionString:urls.app,max:5}),workspace=new Pool({connectionString:urls.workspace,max:5}),control=new Pool({connectionString:urls.app,max:5})
 const hooks=registerHooks({resolve(specifier,context,next){return specifier==='server-only'?{url:'data:text/javascript,export{}',shortCircuit:true}:next(specifier,context)}})
 const {scheduledAgent}=await import('./agent')
 await app.query('CREATE TABLE IF NOT EXISTS scheduled_model_probe(operation_id uuid PRIMARY KEY,executions int NOT NULL DEFAULT 1,hold boolean NOT NULL DEFAULT false)')
 const holds=new Set<string>()
 const server=createServer(async(req,res)=>{
  for await(const _chunk of req){}
  const id=String(req.headers['x-controlled-operation-id'])
  await control.query('INSERT INTO scheduled_model_probe(operation_id) VALUES($1) ON CONFLICT(operation_id) DO UPDATE SET executions=scheduled_model_probe.executions+1',[id])
  if(holds.has(id)){res.writeHead(200,{'content-type':'application/json'});res.write('{');return}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'controlled-chat',object:'chat.completion',created:Math.floor(Date.now()/1000),model:AGENT_ROUTE.model,choices:[{index:0,message:{role:'assistant',content:'CONTROLLED scheduled result, no real provider'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:6,total_tokens:11}}))
 })
 server.listen(6181,'127.0.0.1');await once(server,'listening')
 const guard:WorkspaceGuard=async(owner,id,work)=>{
  const tx=await workspace.connect();try{await tx.query('BEGIN');const m=await tx.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\' FOR SHARE',[id,owner]);if(!m.rowCount)throw new Error('currentWorkspaceDenied');const value=await work();await tx.query('COMMIT');return value}catch(e){await tx.query('ROLLBACK');throw e}finally{tx.release()}
 }
 let now=new Date()
 const store=()=>new ScheduleStore(app,guard,()=>now,scheduledAgent)
 async function fixture(){
  const f=await resourceFixture(app,workspace),session=randomUUID(),source=randomUUID()
  await app.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'original scheduled model chat\')',[session,f.owner])
  await app.query('INSERT INTO agent_turns(id,"sessionId","userId",prompt,status,"attemptId") VALUES($1,$2,$3,\'authorized controlled scheduled read\',\'complete\',$1)',[source,session,f.owner])
  const actor:Actor={ownerId:f.owner,workspaceId:f.workspaceId,conversation:'bot',sessionId:session,sourceId:source}
  const definition:Definition={title:'controlled paid-boundary proof',timezone:'Etc/UTC',timing:{kind:'once',at:new Date(now.getTime()+1000).toISOString()},task:{kind:'agent_read',prompt:'Return a controlled scheduled result',allowedActions:[]},misfire:'catch_up_once',maxLatenessMinutes:5}
  const created=await store().command(actor,{action:'create',requestId:randomUUID(),definition}) as any
  now=new Date(now.getTime()+2000);await store().materialize()
  const occurrence=(await app.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[created.schedule.id])).rows[0]
  return {...f,actor,schedule:created.schedule,occurrence}
 }
 const row=async(id:string)=>(await app.query('SELECT * FROM schedule_occurrences WHERE id=$1',[id])).rows[0]
 const count=async(id:string)=>(await app.query('SELECT executions FROM scheduled_model_probe WHERE operation_id=$1',[id])).rows[0]?.executions??0
 async function wait(fn:()=>Promise<boolean>,label:string){const until=Date.now()+15000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw new Error('timeout '+label)}
 try{
  await t.test('SQL publication failure reuses immutable actual SDK result after fresh claim with zero regeneration',async()=>{
   const f=await fixture(),suffix=randomUUID().replaceAll('-',''),fault=`schedule_model_fault_${suffix}`
   await app.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.occurrence.operation_id}'::uuid THEN RAISE EXCEPTION 'controlled scheduled publication fault'; END IF; RETURN NEW; END $$`)
   await app.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION ${fault}()`)
   try{await store().execute(await store().claim())}finally{await app.query(`DROP TRIGGER ${fault} ON agent_turns`)}
   const pending=await row(f.occurrence.id)
   assert.equal(pending.status,'pending');assert.equal(pending.generation_state,'returned');assert.ok(pending.generation_checkpoint)
   assert.equal(await count(f.occurrence.operation_id),1)
   await assert.rejects(app.query('UPDATE schedule_occurrences SET generation_checkpoint=$2 WHERE id=$1',[f.occurrence.id,{text:'replace paid result'}]),/immutable/)
   now=new Date(now.getTime()+31000)
   process.env.MIKKA_SCHEDULE_AGENT_ENABLED='0'
   await store().tick()
   process.env.MIKKA_SCHEDULE_AGENT_ENABLED='1'
   const done=await row(f.occurrence.id)
   assert.equal(done.status,'succeeded');assert.equal(await count(f.occurrence.operation_id),1)
   assert.equal((await app.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[done.operation_id])).rows[0].n,1)
   assert.deepEqual((await app.query('SELECT state,settled_units FROM quota_reservations WHERE owner_id=$1',[f.owner])).rows.map(r=>[r.state,r.settled_units]),[['settled','2']])
   console.log(JSON.stringify({evidence:'formal scheduled Agent generateText/provider SDK + actual split PG; controlled HTTP model',occurrenceId:done.id,operationId:done.operation_id,generation:done.generation_state,status:done.status,modelInvocations:await count(done.operation_id),resultPublications:1}))
  })
  await t.test('ten consumers of the same formal scheduled claim perform one actual SDK generation',async()=>{
   now=new Date(Date.now()+1000)
   const f=await fixture(),claim=await store().claim()
   assert.equal(claim?.id,f.occurrence.id)
   await Promise.all(Array.from({length:10},()=>store().execute(claim!)))
   const done=await row(f.occurrence.id)
   assert.equal(done.status,'succeeded');assert.equal(await count(done.operation_id),1)
   assert.equal((await app.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[done.operation_id])).rows[0].n,1)
  })
  await t.test('actual user pause after preparation prevents provider send and new quota charge',async()=>{
   now=new Date(Date.now()+1000)
   const f=await fixture()
   const agent={enabled:()=>scheduledAgent.enabled(),read:async(...args:Parameters<typeof scheduledAgent.read>)=>{
    await store().command(f.actor,{action:'pause',scheduleId:f.schedule.id,version:1})
    return scheduledAgent.read(...args)
   }}
   const consumer=new ScheduleStore(app,guard,()=>now,agent)
   await consumer.execute((await consumer.claim())!)
   const done=await row(f.occurrence.id)
   assert.equal(done.status,'cancelled');assert.equal(await count(done.operation_id),0)
   assert.equal((await app.query('SELECT count(*)::int n FROM quota_reservations WHERE owner_id=$1',[f.owner])).rows[0].n,0)
  })
  await t.test('checkpoint transaction loss after provider return is uncertain and cannot regenerate',async()=>{
   now=new Date(Date.now()+1000)
   const f=await fixture(),fault='checkpoint_fault_'+randomUUID().replaceAll('-','')
   await app.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.occurrence.id}'::uuid AND NEW.generation_checkpoint IS NOT NULL THEN RAISE EXCEPTION 'controlled checkpoint failure'; END IF; RETURN NEW; END $$`)
   await app.query(`CREATE TRIGGER ${fault} BEFORE UPDATE OF generation_checkpoint ON schedule_occurrences FOR EACH ROW EXECUTE FUNCTION ${fault}()`)
   try{await store().execute((await store().claim())!)}finally{await app.query(`DROP TRIGGER ${fault} ON schedule_occurrences`)}
   assert.equal((await row(f.occurrence.id)).generation_state,'sending');assert.equal(await count(f.occurrence.operation_id),1)
   now=new Date(now.getTime()+31000);await store().tick()
   const done=await row(f.occurrence.id)
   assert.equal(done.status,'failed');assert.equal(done.generation_state,'uncertain');assert.equal(done.error,'scheduleGenerationUncertain')
   assert.equal(await count(done.operation_id),1)
   assert.equal((await app.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[done.operation_id])).rows[0].n,1)
  })
  await t.test('real formal runtime child SIGKILL after send stays uncertain and never generates on restart',async()=>{
   now=new Date(Date.now()+1000)
   const f=await fixture();holds.add(f.occurrence.operation_id)
   await app.query("UPDATE schedule_occurrences SET next_retry_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.occurrence.id])
   const launch=()=>spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/fixtures/scheduled-model-worker.ts'],{env:process.env,stdio:['ignore','pipe','pipe']})
   const child=launch();let output='';child.stdout.on('data',d=>{output+=d.toString()});child.stderr.on('data',()=>{})
   await wait(async()=>await count(f.occurrence.operation_id)===1,'actual model transport received one request')
   const exit=once(child,'exit');child.kill('SIGKILL');assert.deepEqual(await exit,[null,'SIGKILL'])
   await app.query("UPDATE schedule_occurrences SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.occurrence.id])
   await app.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1",[f.owner])
   const restarted=launch();restarted.stdout.on('data',d=>{output+=d.toString()});restarted.stderr.on('data',()=>{})
   const restartedExit=await once(restarted,'exit');assert.deepEqual(restartedExit,[0,null])
   const done=await row(f.occurrence.id)
   assert.equal(done.generation_state,'uncertain');assert.equal(done.status,'failed');assert.equal(done.error,'scheduleGenerationUncertain');assert.equal(await count(done.operation_id),1)
   const quota=new QuotaStore(app,async(owner,ws)=>owner===f.owner&&ws===f.workspaceId);await quota.inspect(f.owner,f.workspaceId,'schedule.model')
   assert.deepEqual((await app.query('SELECT state,settled_units FROM quota_reservations WHERE owner_id=$1',[f.owner])).rows.map(r=>[r.state,r.settled_units]),[['uncertain','2']])
   const chat=(await app.query('SELECT completion FROM agent_turns WHERE id=$1',[done.operation_id])).rows
   assert.equal(chat.length,1);assert.match(chat[0].completion,/scheduleGenerationUncertain/)
   console.log(JSON.stringify({evidence:'actual formal schedule runtime OS SIGKILL/restart; controlled HTTP model',occurrenceId:done.id,operationId:done.operation_id,state:done.generation_state,status:done.status,modelInvocations:await count(done.operation_id),childExited:restartedExit[0],workerStarted:output.includes('formal scheduled model worker')}))
  })
 }finally{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await Promise.all([app.end(),workspace.end(),control.end()])
  const {pool}=await import('../db');const {workspacePool}=await import('../workspace-db');await pool.end();await workspacePool.end();hooks.deregister()
 }
})
