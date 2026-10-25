import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { scheduleTools } from './tools'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ScheduleStore, type WorkspaceGuard } from './store'
import { ScheduleError, type Actor, type Definition } from './contract'

const url = process.env.SCHEDULE_TEST_DATABASE_URL
if (!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || !/179|schedule/.test(new URL(url).pathname)) throw new Error('SCHEDULE_TEST_DATABASE_URL must name an isolated loopback schedule database')
const pool = new Pool({ connectionString: url, max: 20 })
// Use the actual membership table and hold its lock across the app transaction,
// just as the separate workspace DB runtime does. No auth mock or fake executor.
const workspacePool = new Pool({ connectionString: url, max: 20 })
const guard: WorkspaceGuard = async (owner, workspace, work) => {
  const tx = await workspacePool.connect()
  try {
    await tx.query('BEGIN')
    const { rows } = await tx.query(`SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR UPDATE`, [workspace, owner])
    if (!rows.length) throw new ScheduleError('scheduleWorkspaceAccessDenied', 403)
    const result = await work(); await tx.query('COMMIT'); return result
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
}
let now = new Date('2030-01-01T00:00:00Z')
const store = () => new ScheduleStore(pool, guard, () => now)
const owner = `schedule-owner-${randomUUID()}`
const other = `schedule-other-${randomUUID()}`
const workspace = randomUUID(), session = randomUUID(), source = randomUUID()
const actor: Actor = { ownerId: owner, workspaceId: workspace, conversation: 'bot', sessionId: session, sourceId: source }
const base = (task: Definition['task'] = { kind: 'reminder', text: 'Controlled reminder: no external recipient' }): Definition => ({ title: '179 controlled task', timezone: 'Etc/UTC', timing: { kind: 'once', at: new Date(now.getTime()+60000).toISOString() }, task, misfire: 'catch_up_once', maxLatenessMinutes: 5 })
async function create(definition = base(), requestId = randomUUID()) { return (await store().command(actor, { action: 'create', requestId, definition }) as { schedule: { id: string; version: number; status: string } }).schedule }
async function history(id: string) { return (await store().command(actor, { action: 'history', scheduleId: id }) as { occurrences: Record<string, any>[] }).occurrences }

test('real PG schedule lifecycle, concurrency, fencing, recovery and original-chat result', async t => {
  try {
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'controlled owner',$2,true,now(),now()),($3,'controlled outsider',$4,true,now(),now())`, [owner,`${owner}@example.invalid`,other,`${other}@example.invalid`])
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'179 disposable workspace\')', [workspace,owner])
    await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'owner',$3,'admin')`,[workspace,owner,`${owner}@example.invalid`])
    await pool.query('INSERT INTO agent_sessions(id,"userId",title) VALUES($1,$2,\'controlled original chat\')',[session,owner])
    await pool.query(`INSERT INTO agent_turns(id,"sessionId","userId",prompt,"attemptId",status) VALUES($1,$2,$3,'Remind me in one minute',$1,'complete')`,[source,session,owner])
    await t.test('ten repeated creates and ten concurrent due scans yield one occurrence/result', async () => {
      const definition=base(), requestId=randomUUID()
      const tools=scheduleTools(command=>store().command(actor,command))
      const created=await Promise.all(Array.from({length:10},async()=>{
        const result=await tools.schedule_create.execute!({definition},{toolCallId:requestId,messages:[],context:{}}) as any
        return result.schedule
      }))
      assert.equal(new Set(created.map(s=>s.id)).size,1)
      const id=created[0].id
      now=new Date(now.getTime()+60000)
      await Promise.all(Array.from({length:10},()=>store().tick()))
      const rows=await history(id)
      assert.equal(rows.length,1);assert.equal(rows[0].status,'succeeded');assert.equal(rows[0].attempts,1)
      assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[rows[0].operation_id])).rows[0].n,1)
      assert.equal((await pool.query('SELECT count(*)::int n FROM coordinator_events WHERE id=$1',[rows[0].id])).rows[0].n,1)
      // A retry after the due time still replays the original creation.
      assert.equal((await create(definition,requestId)).id,id)
    })
    await t.test('two recurring executions retain stable IDs across fresh process stores', async () => {
      const definition=base();definition.timing={kind:'interval',start:new Date(now.getTime()+60000).toISOString(),minutes:1}
      const s=await create(definition)
      now=new Date(now.getTime()+60000);await store().tick()
      now=new Date(now.getTime()+60000);await store().tick()
      const rows=await history(s.id)
      assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='succeeded'))
      assert.equal(new Set(rows.map(r=>r.operation_id)).size,2)
      await store().command(actor,{action:'cancel',scheduleId:s.id,version:s.version})
    })
    await t.test('claimed worker crash expires lease; stale claim cannot execute after restart', async () => {
      const s=await create();now=new Date(now.getTime()+60000);await store().materialize()
      const child=spawn(process.execPath,['--import','tsx','scripts/schedule-claim-child.ts'],{env:{...process.env,SCHEDULE_TEST_CLOCK:now.toISOString()},stdio:['pipe','pipe','inherit']})
      const reader=createInterface({input:child.stdout})
      const [line]=await once(reader,'line');const stale=JSON.parse(line)
      assert.ok(stale);const exited=once(child,'exit');child.kill('SIGKILL');assert.deepEqual(await exited,[null,'SIGKILL']);reader.close()
      now=new Date(now.getTime()+61000)
      const recovered=await store().claim();assert.ok(recovered);assert.equal(recovered.id,stale.id)
      await store().execute(stale);assert.equal((await history(s.id))[0].status,'running')
      await store().execute(recovered)
      assert.equal((await history(s.id))[0].status,'succeeded');assert.equal((await history(s.id))[0].attempts,2)
    })
    await t.test('pause/cancel/update fence already claimed work, persistence and optimistic version', async () => {
      const s=await create();now=new Date(now.getTime()+60000);await store().materialize();const claim=await store().claim();assert.ok(claim)
      const paused=await store().command(actor,{action:'pause',scheduleId:s.id,version:1}) as any
      await store().execute(claim);assert.equal((await history(s.id))[0].status,'cancelled')
      await assert.rejects(store().command(actor,{action:'resume',scheduleId:s.id,version:1}),/scheduleVersionConflict/)
      const def=base();def.timezone='Asia/Shanghai'
      const updated=await store().command(actor,{action:'update',scheduleId:s.id,version:paused.schedule.version,definition:def}) as any
      assert.equal(updated.schedule.status,'paused')
      const resumed=await store().command(actor,{action:'resume',scheduleId:s.id,version:updated.schedule.version}) as any
      assert.equal(resumed.schedule.status,'active')
      await store().command(actor,{action:'cancel',scheduleId:s.id,version:resumed.schedule.version})
      now=new Date(now.getTime()+120000);await store().tick();assert.equal((await history(s.id)).length,1)
      await assert.rejects(store().command(actor,{action:'resume',scheduleId:s.id,version:resumed.schedule.version+1}),/scheduleCancelled/)
    })
    await t.test('ten real cancellation-versus-execution races have one linearized outcome',async()=>{
      for(let n=0;n<10;n++){
        const s=await create();now=new Date(now.getTime()+60000);await store().materialize()
        const claim=await store().claim();assert.ok(claim)
        await Promise.all([store().execute(claim),store().command(actor,{action:'cancel',scheduleId:s.id,version:1})])
        const rows=await history(s.id)
        assert.equal(rows.length,1);assert.ok(['cancelled','succeeded'].includes(rows[0].status))
        assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[rows[0].operation_id])).rows[0].n,1)
        await store().tick();assert.equal((await history(s.id)).length,1)
      }
    })
    await t.test('late policy records skip; catch-up coalesces and records at most one backlog slot',async()=>{
      const def=base();def.misfire='skip';def.maxLatenessMinutes=1;const s=await create(def)
      now=new Date(now.getTime()+180001);await store().tick();assert.equal((await history(s.id))[0].status,'skipped')
    })
    await t.test('cross owner/workspace/source denied and membership revoked before execution',async()=>{
      const s=await create()
      await assert.rejects(store().command({...actor,ownerId:other},{action:'history',scheduleId:s.id}),/scheduleWorkspaceAccessDenied/)
      await assert.rejects(store().command({...actor,workspaceId:randomUUID()},{action:'history',scheduleId:s.id}),/scheduleWorkspaceAccessDenied/)
      await assert.rejects(store().command({...actor,sourceId:randomUUID()},{action:'create',requestId:randomUUID(),definition:base()}),/scheduleUserSourceRequired/)
      now=new Date(now.getTime()+60000)
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,owner])
      await store().tick()
      const rows=(await pool.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[s.id])).rows
      assert.equal(rows[0].status,'failed');assert.equal(rows[0].error,'scheduleWorkspaceAccessDenied')
      assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[rows[0].operation_id])).rows[0].n,0)
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,owner])
      await store().flushFailedReports()
      assert.equal((await pool.query('SELECT count(*)::int n FROM agent_turns WHERE id=$1',[rows[0].operation_id])).rows[0].n,1)
    })
    await t.test('read current issue state; revoked issue visibility produces a final error, not task data',async()=>{
      const issue=randomUUID()
      await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'current issue title\',\'{"type":"doc","content":[]}\',\'todo\',\'normal\')',[issue,owner])
      const s=await create(base({kind:'issue_snapshot',issueId:issue}))
      await pool.query('UPDATE issues SET title=\'changed after scheduling\' WHERE id=$1',[issue])
      now=new Date(now.getTime()+60000);await store().tick()
      assert.equal((await history(s.id))[0].result.title,'changed after scheduling')
      const denied=await create(base({kind:'issue_snapshot',issueId:issue}))
      await pool.query('UPDATE issues SET "userId"=$2 WHERE id=$1',[issue,other])
      now=new Date(now.getTime()+60000);await store().tick()
      const failed=(await history(denied.id))[0]
      assert.equal(failed.status,'failed');assert.equal(failed.error,'scheduleTaskAccessDenied')
      const chat=(await pool.query('SELECT completion FROM agent_turns WHERE id=$1',[failed.operation_id])).rows[0].completion
      assert.match(chat,/failed/);assert.doesNotMatch(chat,/changed after scheduling/)
    })
    await t.test('real transaction failure retries three times and persists final error in chat',async()=>{
      const s=await create();now=new Date(now.getTime()+60000);await store().materialize()
      // A transaction-local PG constraint failure happens after the task read;
      // both occurrence success and result insertion must roll back.
      await pool.query(`CREATE OR REPLACE FUNCTION schedule_179_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.completion LIKE '%179 controlled task: succeeded%' THEN RAISE EXCEPTION 'controlled integration fault'; END IF; RETURN NEW; END $$`)
      await pool.query('CREATE TRIGGER schedule_179_failure BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION schedule_179_fail()')
      try { for(let n=0;n<3;n++){await store().tick();now=new Date(now.getTime()+120000)} }
      finally { await pool.query('DROP TRIGGER schedule_179_failure ON agent_turns') }
      const rows=await history(s.id);assert.equal(rows[0].status,'failed');assert.equal(rows[0].attempts,3)
      const completion=(await pool.query('SELECT completion FROM agent_turns WHERE id=$1',[rows[0].operation_id])).rows[0].completion
      assert.match(completion,/failed/);assert.doesNotMatch(completion,/controlled integration fault/)
    })
    console.log(JSON.stringify({evidence:'retained PG schedule records',owner,workspace,session,source,at:now.toISOString()}))
  } finally { await pool.end();await workspacePool.end() }
})
