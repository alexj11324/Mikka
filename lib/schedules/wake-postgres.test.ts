import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CoordinatorInbox } from '../coordinator/inbox-receipts'
import { retryInboxWakes } from '../coordinator/inbox-retry'
const url=process.env.SCHEDULE_TEST_DATABASE_URL
if(!url||new URL(url).hostname!=='127.0.0.1'||!/179|schedule/.test(new URL(url).pathname))throw new Error('isolated schedule PG required')
const pool=new Pool({connectionString:url,max:15})
test('existing inbox persists delivery failures, compensation, concurrent claim and exhaustion',async()=>{
 const owner=`wake179-${randomUUID()}`,event=randomUUID()
 let now=new Date('2030-01-01T00:00:00.000Z')
 const options={clock:()=>now,onlyOwner:owner}
 const due=async(id:string)=>pool.query('UPDATE coordinator_events SET wake_next_at=$2 WHERE id=$1',[id,now])
 const advance=async(id:string)=>{
  const row=(await pool.query('SELECT wake_next_at FROM coordinator_events WHERE id=$1',[id])).rows[0]
  now=new Date(Math.max(now.getTime(),row.wake_next_at.getTime())+1)
 }
 try{
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',[owner,`${owner}@example.invalid`])
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier) VALUES($1::uuid,$2,'user_message',$1::text,'{"text":"controlled wake"}','attention')`,[event,owner])
  // Use one explicit millisecond clock and advance to persisted retry times;
  // PG microseconds must not make an immediate test sweep silently premature.
  await due(event)
  let attempts=0
  const deliver=async(id:string,delivery: {eventId:string;token:string})=>{
   assert.equal(id,owner);attempts++
   if(attempts<=3)throw new Error('controlled transport unavailable')
   const inbox=new CoordinatorInbox(pool,options),holder=randomUUID();await inbox.take(owner,holder,delivery);await inbox.acknowledge(owner,holder,delivery,[{role:'assistant',content:'controlled consumption receipt'}])
  }
  assert.deepEqual(await retryInboxWakes(pool,deliver,false,25,options),{attempted:0,disabled:true})
  for(let i=0;i<3;i++){
   await retryInboxWakes(pool,deliver,true,25,options)
   const row=(await pool.query('SELECT * FROM coordinator_events WHERE id=$1',[event])).rows[0]
   assert.equal(row.wake_attempts,i+1);assert.equal(row.wake_error,'wakeTransportUnconfirmed');assert.ok(row.wake_next_at>now)
   await advance(event)
  }
  await Promise.all(Array.from({length:10},()=>retryInboxWakes(pool,deliver,true,25,options)))
  assert.equal(attempts,4)
  const consumed=(await pool.query('SELECT * FROM coordinator_events WHERE id=$1',[event])).rows[0]
  assert.ok(consumed.deliveredAt);assert.equal(consumed.wake_error,null)
  const exhausted=randomUUID()
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier) VALUES($1::uuid,$2,'user_message',$1::text,'{}','attention')`,[exhausted,owner])
  await due(exhausted)
  for(let i=0;i<6;i++){
   await retryInboxWakes(pool,async()=>{throw new Error('controlled transport unavailable')},true,25,options)
   await advance(exhausted)
  }
  const terminal=(await pool.query('SELECT wake_attempts,wake_status,wake_error FROM coordinator_events WHERE id=$1',[exhausted])).rows[0]
  assert.equal(terminal.wake_attempts,5);assert.equal(terminal.wake_status,'failed');assert.equal(terminal.wake_error,'wakeRetriesExhausted')
  console.log(JSON.stringify({evidence:'existing inbox compensation only; not Workflow SDK acceptance',owner,event,exhausted}))
 }finally{await pool.end()}
})
