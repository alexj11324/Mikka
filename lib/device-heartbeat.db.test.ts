import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('a heartbeat re-checks execution identities only when the harnesses change or the device comes back, and renews the leases of the runs it reports', async t => {
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const [{ createRequestDatabaseScope, pool }, { POST }] = await Promise.all([import('./db'), import('../app/v1/devices/[deviceId]/heartbeat/route')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-heartbeat-${randomUUID()}`
  const device = randomUUID(), run = randomUUID(), stranger = randomUUID()
  const token = `orv_${randomBytes(32).toString('base64url')}`
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('delete from agent_runs where "userId"=$1', [owner])
      await pool.query('delete from agents where "userId"=$1', [owner])
      await pool.query('delete from device_token_devices where "deviceId"=$1', [device]).catch(() => undefined)
      await pool.query('delete from device_tokens where "userId"=$1', [owner])
      await pool.query('delete from devices where "ownerId"=$1', [owner])
      await pool.query('delete from "user" where id=$1', [owner])
    })
    await scope.close()
  })
  const codex = { harness: 'codex', installed: true, version: '1.0.0' }
  const claude = { harness: 'claude_code', installed: true, version: '2.1.0' }
  const beat = async (body: Record<string, unknown>, version = '0.0.456') => {
    const response = await POST(new Request(`http://127.0.0.1/v1/devices/${device}/heartbeat`, {
      method: 'POST', headers: { 'x-mikka-client-version': version, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [], worktreeDiskBytes: 0, ...body }),
    }), { params: Promise.resolve({ deviceId: device }) })
    assert.equal(response.status, 200)
    return await response.json() as { leases: Record<string, string>; revoked?: string[] }
  }
  await scope.run(async () => {
    await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Heartbeat fixture', $1 || '@example.invalid', false, now(), now())`, [owner])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    await pool.query(`insert into devices (id, name, "ownerId", harnesses, "lastSeenAt", "updateFailure") values ($1, 'mine', $2, $3, now(), $4)`,
      [device, owner, JSON.stringify([codex]), JSON.stringify({ code: 'download_failed' })])
    await pool.query(`insert into device_tokens (id, "userId", "tokenHash") values ($1, $2, $3)`, [randomUUID(), owner, createHash('sha256').update(token).digest('hex')])
    const identities = async () => (await pool.query(`select harness from agents where "userId"=$1 and "deviceId"=$2 order by harness`, [owner, device])).rows.map(row => row.harness)
    const seen = async () => (await pool.query(`select "lastSeenAt", "deviceType", "updateFailure", harnesses from devices where id=$1`, [device])).rows[0]

    // Online with unchanged harnesses: the identities are taken as checked.
    const before = (await seen()).lastSeenAt
    const idle = await beat({ harnesses: [codex] })
    assert.deepEqual([idle.leases, idle.revoked], [{}, []], 'an idle device has no leases')
    const after = await seen()
    assert.ok(after.lastSeenAt > before, 'the beat records the device as seen')
    assert.deepEqual(after.updateFailure, { code: 'download_failed' }, 'a beat without an update result keeps the last one')
    assert.deepEqual(await identities(), [], 'unchanged harnesses on an online device: no re-check')

    // The identity check fails: the beat fails (Next answers 500) and the new harnesses
    // are not stored, so the next beat still sees a change and checks again.
    const guard = `heartbeat_test_${randomUUID().replaceAll('-', '')}`
    await pool.query(`create function ${guard}() returns trigger language plpgsql as $$ begin raise exception 'identity check failed'; end $$`)
    await pool.query(`create trigger ${guard} before insert on agents for each row when (NEW."userId" = '${owner}') execute function ${guard}()`)
    try {
      await assert.rejects(beat({ harnesses: [codex, claude] }), /identity check failed/)
    } finally {
      await pool.query(`drop trigger ${guard} on agents`)
      await pool.query(`drop function ${guard}()`)
    }
    assert.deepEqual((await seen()).harnesses.map((info: { harness: string }) => info.harness), ['codex'], 'the harnesses stay as last checked')
    assert.deepEqual(await identities(), [])

    // A harness appears (the beat after the failure): the identities follow at once.
    await beat({ harnesses: [codex, claude], deviceType: 'server', updateFailure: null })
    assert.deepEqual(await identities(), ['claude_code', 'codex'])
    const changed = await seen()
    assert.equal(changed.deviceType, 'server')
    assert.equal(changed.updateFailure, null, 'a successful update clears the failure')
    assert.deepEqual(changed.harnesses.map((info: { harness: string }) => info.harness), ['codex', 'claude_code'])

    // A harness goes away: its identity loses the device.
    await beat({ harnesses: [claude] })
    assert.deepEqual(await identities(), ['claude_code'])

    // Back after being offline, same harnesses: checked again.
    await pool.query(`update agents set "deviceId"=null where "userId"=$1`, [owner])
    await pool.query(`update devices set "lastSeenAt"=now() - interval '10 minutes' where id=$1`, [device])
    await beat({ harnesses: [claude] })
    assert.deepEqual(await identities(), ['claude_code'], 'a device coming back online re-checks its identities')

    // With a run, its lease is renewed; a run the device no longer holds is revoked.
    const [{ id: agent }] = (await pool.query(`select id from agents where "userId"=$1 and "deviceId"=$2`, [owner, device])).rows
    await pool.query(`insert into agent_runs (id, "agentId", "userId", "deviceId", "workspaceId", status, "leaseExpiresAt") values ($1, $2, $3, $4, $5, 'running', now() + interval '5 seconds')`, [run, agent, owner, device, workspaceId])
    const ownToken = (await pool.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [createHash('sha256').update(token).digest('hex')])).rows[0].id
    await pool.query('UPDATE agent_runs SET "deviceTokenId"=$2 WHERE id=$1', [run, ownToken])
    const old = await beat({ harnesses: [claude, codex], runs: [{ runId: run, lastProgressAt: new Date().toISOString() }, { runId: stranger, lastProgressAt: new Date().toISOString() }, { runId: 'not-a-uuid', lastProgressAt: new Date().toISOString() }] }, '0.0.329')
    assert.ok(old.leases[run], 'old original claim can finish its own live run')
    assert.deepEqual(old.revoked?.sort(), ['not-a-uuid', stranger].sort())
    assert.deepEqual(await identities(), ['claude_code'], 'obsolete heartbeat cannot provision new execution identities')
    assert.deepEqual((await seen()).harnesses.map((info: { harness: string }) => info.harness), ['claude_code'])
    const leased = await beat({ harnesses: [claude], runs: [{ runId: run, lastProgressAt: new Date().toISOString() }, { runId: stranger, lastProgressAt: new Date().toISOString() }] })
    assert.ok(leased.leases[run], 'the held run\'s lease is renewed')
    assert.deepEqual(leased.revoked, [stranger])
    const [{ leaseExpiresAt }] = (await pool.query(`select "leaseExpiresAt" from agent_runs where id=$1`, [run])).rows
    assert.ok(leaseExpiresAt.getTime() > Date.now() + 60_000, 'the stored lease moved forward')
    assert.equal(new Date(leased.leases[run]).getTime(), leaseExpiresAt.getTime())
  })
})

dbTest('initial claim repository handoff removes a real cloud repos request without increasing SQL, rows or response bytes', async t => {
  const [{ createRequestDatabaseScope, pool }, { GET }, { readRepositorySettings }] = await Promise.all([
    import('./db'), import('../app/v1/devices/[deviceId]/repos/route'), import('./device-repositories'),
  ])
  const { Client } = await import('pg')
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = 'repository-handoff-' + randomUUID(), device = randomUUID(), agent = randomUUID(), run = randomUUID(), repo = randomUUID(), workspace = randomUUID()
  const token = 'orv_' + randomBytes(32).toString('base64url'), remote = 'https://github.com/fixture/repository.git'
  type Meter = { queries: number; sqlBytes: number; resultRows: number; sentBytes: number; receivedBytes: number }
  type Channel = { write:(chunk:Uint8Array|string,...args:unknown[])=>boolean; on:(event:'data',fn:(data:Buffer)=>void)=>unknown; off:(event:'data',fn:(data:Buffer)=>void)=>unknown }
  let active: Meter | undefined
  const channels = new Map<Channel,{write:Channel['write'];receive:(data:Buffer)=>void}>()
  const original = Client.prototype.query
  Client.prototype.query = new Proxy(original,{apply(target,client,args) {
    if (active) {
      const meter = active
      meter.queries++
      meter.sqlBytes += Buffer.byteLength(typeof args[0] === 'string' ? args[0] : args[0].text)
      const channel = (client as unknown as {connection:{stream:Channel}}).connection.stream
      if (!channels.has(channel)) {
        const write = channel.write
        const receive = (data:Buffer) => { if(active)active.receivedBytes += data.length }
        channel.write = function(chunk,...rest) { if(active)active.sentBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength; return write.call(this,chunk,...rest) }
        channel.on('data',receive);channels.set(channel,{write,receive})
      }
      const observed = (result:unknown) => {
        const results = Array.isArray(result) ? result : [result]
        for(const value of results)if(value && typeof value==='object' && 'rows' in value && Array.isArray(value.rows))meter.resultRows += value.rows.length
      }
      const callback = args.at(-1)
      if(typeof callback==='function')args[args.length-1]=(error:unknown,result:unknown)=>{observed(result);callback(error,result)}
      const result = Reflect.apply(target,client,args)
      return result && typeof result.then==='function' ? result.then((value:unknown)=>{observed(value);return value}) : result
    }
    return Reflect.apply(target,client,args)
  }})
  const measure = async<T>(fn:()=>Promise<T>) => {
    const meter:Meter={queries:0,sqlBytes:0,resultRows:0,sentBytes:0,receivedBytes:0}
    active=meter
    try {return {meter,value:await fn()}}finally{active=undefined}
  }
  try {
    await scope.run(async()=>{
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@example.invalid\',false,now(),now())',[owner])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task fixture\',\'cloud\')',[device,owner])
      await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Fixture\',\'codex\')',[agent,owner])
      await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",status) VALUES($1,$2,$3,$4,\'queued\')',[run,owner,agent,device])
      await pool.query('INSERT INTO thread_machines("runId","ownerId","workspaceId","deviceId","snapshotId","operationId",state) VALUES($1,$2,$3,$4,\'fixture\',$5,\'starting\')',[run,owner,workspace,device,randomUUID()])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt","lastUsedAt") VALUES($1,$2,$3,$4,$5,now()+interval \'1 day\',now())',[randomUUID(),owner,createHash('sha256').update(token).digest('hex'),device,workspace])
      await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,\'v2/github.com/fixture/repository\',$4)',[repo,device,owner,remote])
      const request=()=>new Request('http://127.0.0.1/v1/devices/'+device+'/repos',{headers:{authorization:'Bearer '+token,'x-mikka-client-version':'999.0.0'}})
      const get=()=>GET(request(),{params:Promise.resolve({deviceId:device})})
      // Warm this isolated connection before measuring protocol messages. No production IO.
      assert.equal((await get()).status,200)
      for(const scenario of ['missing','complete','unicode'] as const) {
        await pool.query('DELETE FROM repository_settings WHERE "userId"=$1',[owner])
        if(scenario!=='missing')await pool.query('INSERT INTO repository_settings("userId","remoteKey",setup,"networkAllow") VALUES($1,\'v2/github.com/fixture/repository\',$2,$3)',[owner,JSON.stringify({approved:true,copyFiles:['.env.local'],command:scenario==='unicode'?'echo '+ '测试'.repeat(300):'npm ci'}),JSON.stringify(['registry.npmjs.org'])])
        const old=await measure(async()=>{
          await readRepositorySettings(owner,remote) // the existing claim read, unchanged
          const response=await get();assert.equal(response.status,200)
          return await response.text()
        })
        const next=await measure(()=>readRepositorySettings(owner,remote))
        if(scenario!=='missing')assert(next.value?.setup, 'the complete/Unicode fixtures must read their real setup row')
        const selected=JSON.parse(old.value).repos[0]
        assert.deepEqual(selected.setup,next.value?.setup ?? undefined)
        assert.deepEqual(selected.networkAllow,next.value?.networkAllow ?? undefined)
        const originalClaim={runId:run,repoId:repo,remoteUrl:remote}
        const oldResponseBytes=Buffer.byteLength(JSON.stringify(originalClaim))+Buffer.byteLength(old.value)
        const nextResponseBytes=Buffer.byteLength(JSON.stringify({...originalClaim,repo:selected}))
        assert(next.meter.queries<old.meter.queries)
        assert(next.meter.resultRows<old.meter.resultRows)
        assert(next.meter.sentBytes<old.meter.sentBytes)
        assert(next.meter.receivedBytes<old.meter.receivedBytes)
        assert(nextResponseBytes<=oldResponseBytes)
        t.diagnostic(JSON.stringify({metric:'initial_repository_task_delta',scenario,unchangedTaskPrefixSuffixExcluded:true,
          protocol:'PostgreSQL messages, excluding TCP/TLS/connect; HTTP JSON bodies separately',original:old.meter,candidate:next.meter,
          oldResponseBytes,nextResponseBytes,sqlDelta:next.meter.queries-old.meter.queries,
          rowDelta:next.meter.resultRows-old.meter.resultRows,wireDelta:next.meter.sentBytes+next.meter.receivedBytes-old.meter.sentBytes-old.meter.receivedBytes,
          responseBodyDelta:nextResponseBytes-oldResponseBytes}))
      }
      assert.equal(await readRepositorySettings('different-owner',remote),null)
    })
  } finally {
    active=undefined;Client.prototype.query=original
    for(const[channel,entry]of channels){channel.write=entry.write;channel.off('data',entry.receive)}
    await scope.run(async()=>{
      await pool.query('DELETE FROM device_tokens WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM agents WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM repository_settings WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM device_repos WHERE "userId"=$1',[owner])
      await pool.query('DELETE FROM devices WHERE "ownerId"=$1',[owner])
      await pool.query('DELETE FROM "user" WHERE id=$1',[owner])
    })
    await scope.close()
  }
})
