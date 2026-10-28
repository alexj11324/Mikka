import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { writeTransaction } from './write-transaction'
import { cancelMailboxBackend } from '@/lib/mailbox-pg-cancel'
import { MailboxError } from '@/lib/mailbox-error'

// This suite uses canned query results, not a PostgreSQL transport. Keep the
// real function's client/pool types without enrolling this pure suite as DB acceptance.
type TransactionPool = Parameters<typeof writeTransaction>[0]
type PoolClient = Parameters<Parameters<typeof writeTransaction>[1]>[0]

const defer = <T>() => { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }
function fixture(query: (text:string)=>Promise<unknown> = async()=>({rows:[]})) {
  const statements:string[]=[],releases:(Error|undefined)[]=[]
  const client=Object.assign(new EventEmitter(),{query:async(text:string)=>{statements.push(text);return query(text)},release:(error?:Error)=>{releases.push(error)}}) as unknown as PoolClient
  const pool={connect:async()=>client} as TransactionPool
  return {client,pool,statements,releases}
}
test('pre-abort opens no connection; a late pool checkout is discarded exactly once',async()=>{
 const c=new AbortController();c.abort();let calls=0
 await assert.rejects(writeTransaction({connect:async()=>{calls++;throw Error('forbidden')}},async()=>{}, {signal:c.signal}),/writeTransactionCancelled/)
 assert.equal(calls,0)
 const pending=defer<PoolClient>(),f=fixture(),d=new AbortController()
 const run=writeTransaction({connect:()=>pending.promise} as TransactionPool,async()=>{}, {signal:d.signal});d.abort()
 await assert.rejects(run,/writeTransactionCancelled/);pending.resolve(f.client);await Promise.resolve();await Promise.resolve()
 assert.equal(f.releases.length,1);assert.ok(f.releases[0]);assert.deepEqual(f.statements,[])
})
test('pending query abort uses supplied control cancellation once and discards; late work cannot issue SQL',async()=>{
 const pending=defer<unknown>(),started=defer<void>(),c=new AbortController();let cancels=0,tx!:PoolClient
 const f=fixture(async text=>{if(text==='SELECT pending'){started.resolve();return pending.promise}return {rows:[]}})
 const run=writeTransaction(f.pool,async client=>{tx=client;await client.query('SELECT pending');await client.query('late write')},{signal:c.signal,cancel:async client=>{assert.equal(client,f.client);cancels++;return 'timeout'}})
 await started.promise;c.abort();await assert.rejects(run,/writeTransactionCancelled/)
 assert.equal(cancels,1);assert.deepEqual(f.statements,['BEGIN','SELECT pending']);assert.equal(f.releases.length,1);assert.ok(f.releases[0])
 pending.resolve({rows:[]});await Promise.resolve();assert.throws(()=>tx.query('late write'),/writeTransactionCancelled/)
})
test('COMMIT response loss is unconfirmed, never rollback/retry; acknowledged commit cleanup loss is committed',async()=>{
 const f=fixture(async text=>{if(text==='COMMIT')throw Error('lost response');return {rows:[]}})
 await assert.rejects(writeTransaction(f.pool,async tx=>{await tx.query('synthetic write')}),e=>e instanceof MailboxError&&e.status===409&&e.commitState==='unconfirmed')
 assert.deepEqual(f.statements,['BEGIN','synthetic write','COMMIT']);assert.ok(f.releases[0])
 const good=fixture()
 await assert.rejects(writeTransaction(good.pool,async()=>1,{guard:async()=>({check:async()=>{},close:async()=>{throw Error('lost finalize')}})}),e=>e instanceof MailboxError&&e.commitState==='committed')
 assert.deepEqual(good.statements,['BEGIN','COMMIT']);assert.ok(good.releases[0])
})
test('APP parents precede member lease, then final same-client fence immediately precedes COMMIT',async()=>{
 const order:string[]=[],f=fixture(async s=>{order.push(s);return {rows:[]}})
 const result=await writeTransaction(f.pool,async tx=>{await tx.query('APP parent/head lock');return 7},{guard:async()=>{order.push('WS FOR SHARE');return {check:async()=>{order.push('WS check')},close:async()=>{order.push('WS close')}}},authorizeCommit:async tx=>{await tx.query('APP current authority')}})
 assert.equal(result,7);assert.deepEqual(order,['BEGIN','APP parent/head lock','WS FOR SHARE','WS check','APP current authority','COMMIT','WS close']);assert.deepEqual(f.releases,[undefined])
})
test('member authorization failure or lease revocation rolls back with no COMMIT',async()=>{
 for(const mode of ['missing','revoked']){
  const f=fixture(),c=new AbortController()
  await assert.rejects(writeTransaction(f.pool,async()=>1,{guard:async()=>{
   if(mode==='missing')throw new MailboxError('denied')
   return {signal:c.signal,check:async()=>{c.abort()},close:async()=>{}}
  },cancel:async()=> 'unavailable'}))
  assert.ok(!f.statements.includes('COMMIT'));assert.equal(f.releases.length,1)
  if(mode==='revoked')assert.ok(f.releases[0])
 }
})
test('real cancellation helper uses only checked-out endpoint/PID/key and reports EOF, never ACK',async()=>{
 const events:string[]=[],wire=Object.assign(new EventEmitter(),{stream:{destroy:()=>events.push('destroy')},connect:()=>queueMicrotask(()=>wire.emit('connect')),requestSsl:()=>{throw Error('unexpected SSL')},cancel:(pid:number,key:number)=>{assert.equal(pid,12);assert.equal(key,34);events.push('sent');queueMicrotask(()=>wire.emit('end'))}})
 const client={processID:12,secretKey:34,connectionParameters:{host:'127.0.0.1',port:5432,ssl:false}} as unknown as PoolClient
 const outcome=await cancelMailboxBackend(client,options=>{assert.equal(options.user,'unused-cancel-protocol');assert.equal(options.host,'127.0.0.1');return wire})
 assert.equal(outcome,'closed-after-send');assert.deepEqual(events,['sent','destroy'])
 let created=false
 const rejected={...client,connectionParameters:{host:'127.0.0.1',port:5432,ssl:{rejectUnauthorized:false}}} as unknown as PoolClient
 assert.equal(await cancelMailboxBackend(rejected,()=>{created=true;return wire}),'unavailable');assert.equal(created,false)
})

test('checkout resolved then same-turn abort cannot fall between ownership and waiter resolution',async()=>{
 const pending=defer<PoolClient>(),f=fixture(),c=new AbortController()
 const run=writeTransaction({connect:()=>pending.promise} as TransactionPool,async()=>{throw Error('must not start')},{signal:c.signal})
 pending.resolve(f.client);queueMicrotask(()=>c.abort())
 await assert.rejects(run,/writeTransactionCancelled/);assert.equal(f.releases.length,1);assert.ok(f.releases[0]);assert.deepEqual(f.statements,[])
})
test('late guard cleanup is awaited once, including a delayed close rejection',async()=>{
 const f=fixture(),c=new AbortController(),acquired=defer<{check:()=>Promise<void>;close:()=>Promise<void>}>(),entered=defer<void>(),closed=defer<void>(),closing=defer<void>();let closes=0,settled=false
 const run=writeTransaction(f.pool,async()=>1,{signal:c.signal,cancel:async()=> 'unavailable',guard:()=>{entered.resolve();return acquired.promise}})
 run.then(()=>{settled=true},()=>{settled=true})
 await entered.promise;c.abort();acquired.resolve({check:async()=>{},close:async()=>{closes++;closing.resolve();return closed.promise}})
 await closing.promise;await Promise.resolve();assert.equal(settled,false);assert.equal(f.releases.length,0)
 closed.reject(Error('synthetic close failed'));await assert.rejects(run);assert.equal(closes,1);assert.equal(f.releases.length,1);assert.ok(f.releases[0])
})
test('guarded effect runs with membership lease held through commit', async () => {
 const order:string[]=[], f=fixture(async s=>{order.push(s);return {rows:[]}})
 const result=await writeTransaction(f.pool,async tx=>{await tx.query('APP policy lock');return 1},{
  guard:async()=>{order.push('WS lock');return {check:async()=>{order.push('WS check')},close:async()=>{order.push('WS close')}}},
  guardedWork:async (_tx,value,lease)=>{assert.ok(lease);order.push('provider effect');return value+1},
 })
 assert.equal(result,2)
 assert.deepEqual(order,['BEGIN','APP policy lock','WS lock','WS check','provider effect','WS check','COMMIT','WS close'])
 const denied=fixture();let sent=false
 await assert.rejects(writeTransaction(denied.pool,async()=>1,{guard:async()=>{throw Error('revoked')},guardedWork:async (_tx,value)=>{sent=true;return value}}),/revoked/)
 assert.equal(sent,false);assert.ok(!denied.statements.includes('COMMIT'))
})
