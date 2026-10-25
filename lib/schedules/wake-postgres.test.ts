import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { retryInboxWakes } from '../coordinator/inbox-retry'
const url=process.env.SCHEDULE_TEST_DATABASE_URL
if(!url||new URL(url).hostname!=='127.0.0.1'||!/179|schedule/.test(new URL(url).pathname))throw new Error('isolated schedule PG required')
const pool=new Pool({connectionString:url,max:15})
test('existing inbox persists delivery failures, compensation, concurrent claim and exhaustion',async()=>{
 const owner=`wake179-${randomUUID()}`,event=randomUUID()
 try{
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier) VALUES($1::uuid,$2,'user_message',$1::text,'{"text":"controlled wake"}','attention')`,[event,owner])
  let attempts=0
  const deliver=async(id:string)=>{
   assert.equal(id,owner);attempts++
   if(attempts<=3)throw new Error('controlled transport unavailable')
   await pool.query('UPDATE coordinator_events SET "deliveredAt"=clock_timestamp() WHERE id=$1',[event])
  }
  assert.deepEqual(await retryInboxWakes(pool,deliver,false),{attempted:0,disabled:true})
  for(let i=0;i<3;i++){
   await retryInboxWakes(pool,deliver,true)
   const row=(await pool.query('SELECT * FROM coordinator_events WHERE id=$1',[event])).rows[0]
   assert.equal(row.wake_attempts,i+1);assert.equal(row.wake_error,'coordinatorWakeUnavailable');assert.ok(row.wake_next_at>new Date())
   await pool.query('UPDATE coordinator_events SET wake_next_at=clock_timestamp() WHERE id=$1',[event])
  }
  await Promise.all(Array.from({length:10},()=>retryInboxWakes(pool,deliver,true)))
  assert.equal(attempts,4)
  const consumed=(await pool.query('SELECT * FROM coordinator_events WHERE id=$1',[event])).rows[0]
  assert.ok(consumed.deliveredAt);assert.equal(consumed.wake_error,null)
  const exhausted=randomUUID()
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier) VALUES($1::uuid,$2,'user_message',$1::text,'{}','attention')`,[exhausted,owner])
  for(let i=0;i<6;i++){
   await retryInboxWakes(pool,async()=>{throw new Error('controlled transport unavailable')},true)
   await pool.query('UPDATE coordinator_events SET wake_next_at=clock_timestamp() WHERE id=$1',[exhausted])
  }
  assert.equal((await pool.query('SELECT wake_attempts FROM coordinator_events WHERE id=$1',[exhausted])).rows[0].wake_attempts,5)
  console.log(JSON.stringify({evidence:'existing inbox compensation only; not Workflow SDK acceptance',owner,event,exhausted}))
 }finally{await pool.end()}
})
