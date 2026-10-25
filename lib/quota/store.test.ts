import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { Pool } from 'pg'
import { QuotaStore } from './store'
import { QuotaError, quotaResponse, retryAfterSeconds } from './errors'
import { configureQuota, quotaPolicySchema } from './config'

const url = process.env.QUOTA_TEST_DATABASE_URL
if (url) {
  const target = new URL(url)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname))
  assert.ok(/(?:_e2e|_quota215)$/.test(target.pathname), 'Only an explicitly isolated quota test database is allowed')
}

test('Retry-After parses delta/date, rounds safely and fails conservatively', () => {
  assert.equal(retryAfterSeconds('3.2'),4)
  assert.equal(retryAfterSeconds('Sun, 25 Oct 2026 00:00:30 GMT',Date.parse('2026-10-25T00:00:00Z')),30)
  assert.equal(retryAfterSeconds(null),60)
  assert.equal(retryAfterSeconds('junk'),60)
  assert.equal(retryAfterSeconds('0'),1)
  assert.equal(quotaResponse(new QuotaError('limited',429,3.2)).headers.get('Retry-After'),'4')
})

test('real PostgreSQL quota contention, restart, retries and authorization', { skip: !url, timeout: 120000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const schema = `quota_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const target = new URL(url!); target.searchParams.set('options',`-c search_path=${schema}`)
  const pool = new Pool({ connectionString: target.toString(), max: 20 })
  const authorize = async (owner: string, workspace: string) => Boolean((await pool.query('SELECT 1 FROM quota_test_members WHERE owner_id=$1 AND workspace_id=$2 AND active', [owner,workspace])).rowCount)
  const store = new QuotaStore(pool, authorize)
  try {
    await pool.query('CREATE TABLE agent_runs (id uuid PRIMARY KEY)')
    const migration = await readFile(new URL('../../drizzle/20261025165100_tenant_quotas.sql', import.meta.url),'utf8')
    await pool.query(migration); await pool.query(migration)
    await pool.query('CREATE TABLE quota_test_members(owner_id text PRIMARY KEY,workspace_id uuid NOT NULL,active boolean NOT NULL DEFAULT true)')
    await pool.query('CREATE TABLE quota_test_effects(operation_id text PRIMARY KEY,created_at timestamptz DEFAULT clock_timestamp())')
    const fixture = async (changes: Record<string,unknown> = {}) => {
      const owner = randomUUID(), workspace = randomUUID()
      const policy = quotaPolicySchema.parse({ windowStart:new Date(Date.now()-60000).toISOString(),windowEnd:new Date(Date.now()+3600000).toISOString(),budgetUnits:100,
        concurrencyLimit:3,rateLimit:100,rateWindowSeconds:60, resources:{ 'agent.turn':{units:1,unknownCostApproved:true},'coordinator.model':{units:1,unknownCostApproved:true},'daemon.run':{units:1,unknownCostApproved:true} },paused:false,owners:[owner],override:null,...changes })
      await pool.query(`INSERT INTO quota_allocations(workspace_id,max_budget_units,max_concurrency,max_rate_limit,rate_window_seconds,resources,expires_at,granted_by,reason)
        VALUES ($1,100,100,1000,60,$2,now()+interval '2 hours','test-operator','isolated synthetic allocation')`,[workspace,policy.resources])
      await configureQuota(pool,workspace,owner,policy)
      await pool.query('INSERT INTO quota_test_members(owner_id,workspace_id) VALUES ($1,$2)',[owner,workspace])
      return { owner,workspace,policy }
    }
    const request = (owner: string, key: string = randomUUID(), resource='agent.turn', binding: unknown={}) => ({ ownerId:owner,key,resource,binding })
    const state = async (id:string) => (await pool.query('SELECT * FROM quota_reservations WHERE id=$1',[id])).rows[0]

    await t.test('10 simultaneous mixed entry requests share tenant concurrency; other tenant proceeds', async () => {
      const a=await fixture(), b=await fixture()
      const results = await Promise.allSettled(Array.from({length:10},(_,i)=>store.reserve(request(a.owner,randomUUID(),['agent.turn','coordinator.model','daemon.run'][i%3]))))
      assert.equal(results.filter(r=>r.status==='fulfilled').length,3)
      assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='quotaConcurrencyExceeded'))
      assert.equal((await store.reserve(request(b.owner))).state,'reserved')
      assert.equal(Number((await pool.query("SELECT count(*) AS n FROM quota_reservations WHERE workspace_id=$1 AND state='reserved'",[a.workspace])).rows[0].n),3)
    })
    await t.test('same key gets one reservation and exactly one activation; changed binding rejected',async()=>{
      const {owner}=await fixture(), key=randomUUID()
      const all=await Promise.all(Array.from({length:10},()=>store.reserve(request(owner,key))))
      assert.equal(new Set(all.map(r=>r.id)).size,1)
      const activated=await Promise.allSettled(all.map(r=>store.activate(owner,r.id)))
      assert.equal(activated.filter(r=>r.status==='fulfilled').length,1)
      await assert.rejects(store.reserve(request(owner,key,'agent.turn',{changed:true})),{code:'quotaKeyConflict'})
      await Promise.all(Array.from({length:10},()=>store.finish(owner,all[0].id,'settled')))
      assert.equal((await state(all[0].id)).settled_units,'1')
      assert.equal((await store.reserve(request(owner,key))).id,all[0].id)
      await assert.rejects(store.activate(owner,all[0].id),{code:'quotaAlreadyDispatched'})
    })
    await t.test('reserve budget is atomic across owners within the same workspace',async()=>{
      const {owner,workspace}=await fixture({budgetUnits:2,concurrencyLimit:20})
      const member=randomUUID()
      await pool.query('INSERT INTO quota_owners(owner_id,workspace_id) VALUES ($1,$2)',[member,workspace])
      await pool.query('INSERT INTO quota_test_members(owner_id,workspace_id) VALUES ($1,$2)',[member,workspace])
      const all=await Promise.allSettled(Array.from({length:10},(_,i)=>store.reserve(request(i%2?owner:member))))
      assert.equal(all.filter(r=>r.status==='fulfilled').length,2)
      assert.ok(all.filter(r=>r.status==='rejected').every(r=>r.reason.code==='quotaBudgetExhausted'))
    })
    await t.test('before-send refunds and contradictory settlement stays immutable',async()=>{
      const {owner}=await fixture({budgetUnits:1})
      const r=await store.reserve(request(owner))
      await store.finish(owner,r.id,'refunded')
      await store.finish(owner,r.id,'settled')
      assert.equal((await state(r.id)).settled_units,'0')
      await store.reserve(request(owner))
    })
    await t.test('expiry before send refunds; after send consumes once and frees concurrency',async()=>{
      const {owner}=await fixture({concurrencyLimit:1})
      const pre=await store.reserve(request(owner))
      await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[pre.id])
      const sent=await store.reserve(request(owner));await store.activate(owner,sent.id)
      assert.equal((await state(pre.id)).state,'refunded')
      await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[sent.id])
      await store.reserve(request(owner))
      assert.equal((await state(sent.id)).state,'uncertain')
      assert.equal((await state(sent.id)).settled_units,'1')
      await assert.rejects(store.renew(owner,sent.id,90000),{code:'quotaLeaseLost'})
      await store.finish(owner,sent.id,'refunded')
      assert.equal((await state(sent.id)).state,'uncertain')
    })
    await t.test('provider 429 persists tenant/resource Retry-After across process-independent stores',async()=>{
      const {owner}=await fixture()
      const r=await store.reserve(request(owner));await store.activate(owner,r.id)
      await store.finish(owner,r.id,'refunded',undefined,25)
      const restarted=new QuotaStore(pool,authorize)
      await assert.rejects(restarted.reserve(request(owner)),(e:QuotaError)=>e.code==='providerBackoff'&&e.retryAfter>20)
      await restarted.reserve(request(owner,randomUUID(),'daemon.run'))
      assert.equal((await state(r.id)).settled_units,'0')
    })
    await t.test('rate is not refunded by failures and survives restarts',async()=>{
      const {owner}=await fixture({rateLimit:1})
      const r=await store.reserve(request(owner));await store.finish(owner,r.id,'refunded')
      await assert.rejects(new QuotaStore(pool,authorize).reserve(request(owner)),{code:'quotaRateExceeded'})
    })
    await t.test('operator allocation and override are rechecked at activation/renewal; tenant admins cannot raise caps',async()=>{
      const f=await fixture({budgetUnits:0})
      await assert.rejects(configureQuota(pool,f.workspace,f.owner,{...f.policy,rateWindowSeconds:1}),{code:'quotaAllocationExceeded'})
      await assert.rejects(configureQuota(pool,f.workspace,f.owner,{...f.policy,budgetUnits:101}),{code:'quotaAllocationExceeded'})
      await assert.rejects(configureQuota(pool,f.workspace,f.owner,{...f.policy,resources:{'agent.turn':{units:0,unknownCostApproved:true}}}),{code:'quotaAllocationExceeded'})
      await configureQuota(pool,f.workspace,f.owner,{...f.policy,override:{units:1,until:new Date(Date.now()+60000).toISOString(),reason:'synthetic authorized override'}})
      const r=await store.reserve(request(f.owner))
      await pool.query("UPDATE quota_tenants SET override_until=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[f.workspace])
      await assert.rejects(store.activate(f.owner,r.id),{code:'quotaBudgetExhausted'})
      await store.finish(f.owner,r.id,'refunded')
      await pool.query("UPDATE quota_tenants SET budget_units=1 WHERE workspace_id=$1",[f.workspace])
      const active=await store.reserve(request(f.owner));await store.activate(f.owner,active.id)
      await pool.query('UPDATE quota_allocations SET revoked_at=clock_timestamp() WHERE workspace_id=$1',[f.workspace])
      await assert.rejects(store.renew(f.owner,active.id,90000),{code:'quotaAllocationUnavailable'})
      await store.finish(f.owner,active.id,'uncertain')
      assert.equal((await state(active.id)).settled_units,'1')
    })
    await t.test('rolling tenant windows cannot reset the platform allocation lifetime cap',async()=>{
      const f=await fixture({budgetUnits:1})
      await pool.query('UPDATE quota_allocations SET max_budget_units=2 WHERE workspace_id=$1',[f.workspace])
      for(let i=0;i<2;i++) {
        const r=await store.reserve(request(f.owner));await store.activate(f.owner,r.id);await store.finish(f.owner,r.id,'settled')
        await pool.query("UPDATE quota_tenants SET window_start=clock_timestamp()-interval '2 seconds',window_end=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[f.workspace])
        await configureQuota(pool,f.workspace,f.owner,{...f.policy,windowStart:new Date().toISOString()})
      }
      await assert.rejects(store.reserve(request(f.owner)),{code:'quotaBudgetExhausted'})
    })
    await t.test('SQL write fault rolls back reservation and releases the tenant lock',async()=>{
      const {owner}=await fixture()
      await pool.query(`CREATE FUNCTION quota_test_write_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_key='synthetic-write-fault' THEN RAISE EXCEPTION 'injected quota insert failure'; END IF; RETURN NEW; END $$`)
      await pool.query('CREATE TRIGGER quota_test_write_fault BEFORE INSERT ON quota_reservations FOR EACH ROW EXECUTE FUNCTION quota_test_write_fault()')
      await assert.rejects(store.reserve(request(owner,'synthetic-write-fault')),/injected quota insert failure/)
      assert.equal(Number((await pool.query('SELECT count(*) n FROM quota_reservations WHERE owner_id=$1',[owner])).rows[0].n),0)
      await store.reserve(request(owner))
    })
    await t.test('unknown configuration/cost, suspension, workspace mismatch and expired override fail closed',async()=>{
      await assert.rejects(store.reserve(request(randomUUID())),{code:'quotaNotConfigured'})
      const {owner,workspace}=await fixture()
      await assert.rejects(store.reserve(request(owner,randomUUID(),'cloud.unpriced')),{code:'quotaCostApprovalRequired'})
      const r=await store.reserve(request(owner))
      await pool.query('UPDATE quota_test_members SET active=false WHERE owner_id=$1',[owner])
      await assert.rejects(store.activate(owner,r.id),{code:'quotaAccessDenied'})
      await store.finish(owner,r.id,'refunded') // Cleanup still works after revocation.
      await pool.query('UPDATE quota_test_members SET active=true,workspace_id=$2 WHERE owner_id=$1',[owner,randomUUID()])
      await assert.rejects(store.reserve(request(owner)),{code:'quotaAccessDenied'})
      const a=await fixture({budgetUnits:0})
      await pool.query("UPDATE quota_tenants SET override_units=1,override_until=clock_timestamp()-interval '1 second',override_by='admin',override_reason='test' WHERE workspace_id=$1",[a.workspace])
      await assert.rejects(store.reserve(request(a.owner)),{code:'quotaBudgetExhausted'})
      assert.ok(workspace)
    })
    await t.test('authorization is checked after a blocked tenant lock',async()=>{
      const {owner,workspace}=await fixture()
      const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT workspace_id FROM quota_tenants WHERE workspace_id=$1 FOR UPDATE',[workspace])
      const pending=store.reserve(request(owner))
      await pool.query('UPDATE quota_test_members SET active=false WHERE owner_id=$1',[owner])
      await lock.query('COMMIT');lock.release()
      await assert.rejects(pending,{code:'quotaAccessDenied'})
    })
    await t.test('configuration records actor, disallows active-window reset and owner reassignment',async()=>{
      const {owner,workspace,policy}=await fixture()
      await assert.rejects(configureQuota(pool,workspace,owner,{...policy,windowStart:new Date(Date.now()).toISOString()}),{code:'quotaWindowImmutable'})
      const other=await fixture(); await assert.rejects(configureQuota(pool,other.workspace,owner,{...other.policy,owners:[owner]}),{code:'quotaOwnerAlreadyBound'})
      assert.equal((await pool.query('SELECT actor FROM quota_policy_events WHERE workspace_id=$1',[workspace])).rows[0].actor,owner)
    })
    await t.test('real SIGKILL after dispatch before/after HTTP effect: no resend on restart',async()=>{
      const server=createServer(async(req,res)=>{
        const key=new URL(req.url!,'http://localhost').searchParams.get('operation')!
        await pool.query('INSERT INTO quota_test_effects(operation_id) VALUES ($1)',[key])
        res.end('accepted')
      }); server.listen(0,'127.0.0.1');await once(server,'listening')
      try {
        for(const phase of ['before-send','after-send']) {
          const {owner}=await fixture({concurrencyLimit:1}), key=randomUUID()
          const child=spawn(process.execPath,['--import','tsx',new URL('./restart-worker.ts',import.meta.url).pathname],{
            cwd:new URL('../..',import.meta.url),env:{...process.env,QUOTA_TEST_DATABASE_URL:target.toString(),QUOTA_TEST_OWNER:owner,QUOTA_TEST_KEY:key,QUOTA_TEST_PHASE:phase,QUOTA_TEST_EFFECT_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}/?operation=${key}`},stdio:['ignore','pipe','pipe'],
          })
          let stderr='';child.stderr.on('data',chunk=>stderr+=chunk)
          await new Promise<void>((resolve,reject)=>{
            child.stdout.on('data',chunk=>{if(String(chunk).includes('READY'))resolve()})
            child.once('exit',code=>reject(new Error(`worker exited ${code}: ${stderr}`)))
          })
          const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')
          const existing=(await pool.query('SELECT * FROM quota_reservations WHERE owner_id=$1 AND request_key=$2',[owner,key])).rows[0]
          await pool.query("UPDATE quota_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[existing.id])
          const replay=await new QuotaStore(pool,authorize).reserve(request(owner,key))
          assert.equal(replay.id,existing.id);assert.equal(replay.state,'uncertain')
          await assert.rejects(store.activate(owner,replay.id),{code:'quotaOutcomeUncertain'})
          assert.equal(Number((await pool.query('SELECT count(*) AS n FROM quota_test_effects WHERE operation_id=$1',[key])).rows[0].n),phase==='before-send'?0:1)
          await store.reserve(request(owner))
        }
      } finally { server.close();await once(server,'close') }
    })
    console.log(JSON.stringify({environment:'isolated cloud Linux PG',schema,server:(await pool.query('SHOW server_version')).rows[0].server_version,utc:new Date().toISOString(),recordsRetained:true}))
  } finally { await pool.end();await admin.end() }
})
