import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'
import { request as httpRequest } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { browserClientHeaders } from './fixtures'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('owner revokes credential durably; old daemon API calls and attributed workers fail closed', async ({ playwright, baseURL }, info) => {
  const target = new URL(process.env.E2E_DATABASE_URL!)
  expect(['localhost','127.0.0.1']).toContain(target.hostname)
  expect(target.pathname).toBe('/mikka_e2e')
  const origin = new URL(baseURL!).origin
  expect(['localhost','127.0.0.1']).toContain(new URL(origin).hostname)
  const pg = new Pool({ connectionString: target.toString() })
  const owner = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const outsider = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  const daemon = await playwright.request.newContext({ baseURL })
  const tokenId = randomUUID(), bearer = `orv_${randomBytes(32).toString('hex')}`, otherId = randomUUID(), otherBearer = `orv_${randomBytes(32).toString('hex')}`
  const checks: string[] = []
  const startedAt = new Date().toISOString()
  const endpointResults: {method:string;path:string;status:number}[] = []
  let runtime: ChildProcessWithoutNullStreams | undefined
  async function runtimeCommand(command: Record<string,unknown>) {
    const lines = createInterface({input:runtime!.stdout})
    const result = new Promise<{server:string;signedIn:boolean}>((resolve,reject)=>{
      const timeout = setTimeout(()=>{lines.close();reject(new Error('Daemon status timeout'))},15000)
      lines.once('line',line=>{clearTimeout(timeout);lines.close();resolve(JSON.parse(line))})
    })
    runtime!.stdin.write(JSON.stringify(command)+'\n')
    return result
  }
  const revokeURL = `/mikka/api/device-tokens/${tokenId}/revoke`
  try {
    async function signup(client: typeof owner) {
      const response = await client.post('/mikka/api/auth/sign-up/email', { headers: { origin }, data: { name:'Synthetic daemon owner', email:`revoke-${randomUUID()}@example.invalid`,password:randomBytes(32).toString('hex') } })
      expect(response.status()).toBe(200)
      return (await response.json()).user.id as string
    }
    const userId = await signup(owner)
    await signup(outsider)
    for(const [id, token] of [[tokenId,bearer],[otherId,otherBearer]]) await pg.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)', [id,userId,createHash('sha256').update(token).digest('hex')])
    runtime = spawn(process.execPath,['--import','tsx','packages/daemon/test/revocation-runtime.mjs'],{
      env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'test'},stdio:'pipe',
    })
    runtime.stderr.resume()
    expect((await runtimeCommand({action:'start',origin:origin+'/mikka',credential:bearer})).server).toBe('online')
    const headers = { authorization:`Bearer ${bearer}` }
    const registration = {name:'Synthetic daemon',platform:'linux',arch:'x64',daemonVersion:'test',protocolVersion:1,harnesses:[]}
    const registered = await daemon.post('/mikka/v1/devices/register', { headers, data:registration })
    expect(registered.status()).toBe(200)
    const deviceId = (await registered.json()).deviceId as string
    const heartbeat = `/mikka/v1/devices/${deviceId}/heartbeat`
    expect((await daemon.post(heartbeat,{headers,data:{harnesses:[],runs:[],worktreeDiskBytes:0}})).status()).toBe(200)
    const agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID(),repoId=randomUUID()
    await pg.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'fixture\',\'{"type":"doc","content":[]}\',\'todo\',\'normal\')',[issueId,userId])
    await pg.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,\'codex\',\'revocation fixture\',$3)',[agentId,userId,deviceId])
    await pg.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,$4)',[repoId,deviceId,userId,'/synthetic/no-execution'])
    await pg.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","deviceId","deviceRepoId",status,"baseBranch",prompt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[runId,userId,agentId,issueId,deviceId,repoId,'queued','main','Synthetic request only; no harness execution'])
    const claim = await daemon.post(`/mikka/v1/devices/${deviceId}/runs/${runId}/claim`,{headers,data:{}})
    expect(claim.status()).toBe(200)
    const worker = (await claim.json()).mcp.token as string
    expect((await pg.query('SELECT "deviceTokenId" FROM agent_runs WHERE id=$1',[runId])).rows[0].deviceTokenId).toBe(tokenId)
    checks.push('real queued claim records credential attribution and issues worker token')
    expect((await daemon.post(revokeURL)).status()).toBe(401)
    expect((await outsider.post(revokeURL,{headers:{origin}})).status()).toBe(404)
    expect((await owner.post(revokeURL,{headers:{origin:'https://invalid.example'}})).status()).toBe(403)
    expect((await pg.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1',[tokenId])).rows[0].revokedAt).toBeNull()
    checks.push('unauthenticated, nonowner and cross-origin mutation denied')
    // Start a real long poll before revoke; it must recheck within its loop.
    const gate = 'revoke_'+randomUUID().replaceAll('-','')
    await pg.query(`CREATE FUNCTION ${gate}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${gate}',0)); RETURN NEW; END $$`)
    await pg.query(`CREATE TRIGGER ${gate} BEFORE INSERT ON run_chunks FOR EACH ROW WHEN (NEW."runId"='${runId}'::uuid) EXECUTE FUNCTION ${gate}()`)
    const blocker = await pg.connect()
    let revoked
    const started = Date.now()
    const polling = daemon.get(`/mikka/v1/devices/${deviceId}/commands?wait=25`,{headers})
    try {
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[gate])
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const report = daemon.post(`/mikka/v1/runs/${runId}/events`,{headers,data:{fromSeq:1,chunks:[{type:'text-delta',delta:'Synthetic pre-revoke event'}]}})
      await expect.poll(async()=>Number((await pg.query('SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].count)).toBeGreaterThan(0)
      const revoking = owner.post(revokeURL,{headers:{origin}})
      await expect.poll(async()=>Number((await pg.query(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id,"revokedAt","revokedBy" FROM device_tokens%'`)).rows[0].count),{timeout:3000}).toBeGreaterThan(0)
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate])
      expect((await report).status()).toBe(200)
      revoked = await revoking
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate])
      blocker.release()
    }
    checks.push('revoke waits for admitted event commit; controlled SQL insert race uses actual HTTP')
    expect(revoked.status()).toBe(200)
    const receipt = await revoked.json()
    expect(receipt.revokedBy).toBe(userId)
    expect((await polling).status()).toBe(401)
    expect(Date.now()-started).toBeLessThan(5000)
    const repeat = await owner.post(revokeURL,{headers:{origin}})
    expect(await repeat.json()).toEqual(receipt)
    checks.push('owner revoke is idempotent; long poll refuses within 5s')
    expect((await runtimeCommand({action:'sync'})).signedIn).toBe(false)
    const restarted=await runtimeCommand({action:'restart'})
    expect(restarted.signedIn).toBe(false)
    expect(restarted.server).toBe('unregistered')
    checks.push('actual daemon runtime clears rejected session and rejects same credential after restart; no provider or harness execution')
    const endpoints: [string,string][] = [
      ['POST','/v1/devices/register'],['POST',`/v1/devices/${deviceId}/heartbeat`],['GET',`/v1/devices/${deviceId}/repos`],['GET',`/v1/devices/${deviceId}/runs`],
      ['GET',`/v1/devices/${deviceId}/commands`],['POST',`/v1/devices/${deviceId}/commands/ack`],['GET',`/v1/devices/${deviceId}/fs/requests`],['POST',`/v1/devices/${deviceId}/fs/requests/${randomUUID()}`],
      ['POST',`/v1/devices/${deviceId}/group-reviews`],['POST',`/v1/devices/${deviceId}/runs/${runId}/claim`],['POST',`/v1/devices/${deviceId}/runs/${runId}/subscription`],
      ['PATCH',`/v1/runs/${runId}`],['POST',`/v1/runs/${runId}/events`],['POST',`/v1/runs/${runId}/checkpoint`],['POST',`/v1/runs/${runId}/complete`],['GET',`/v1/runs/${runId}/skill-receipt`],['POST',`/v1/runs/${runId}/group-reply`],
    ]
    for(const [method,path] of endpoints) {
      const response=await daemon.fetch('/mikka'+path,{method,headers,...(method==='GET'?{}:{data:{}})})
      endpointResults.push({method,path,status:response.status()})
      expect([401,403],path).toContain(response.status())
    }
    checks.push(`${endpoints.length} protected endpoint methods refuse old token`)
    await pg.query('UPDATE devices SET enabled=false WHERE id=$1',[deviceId])
    await pg.query('UPDATE devices SET enabled=true WHERE id=$1',[deviceId])
    expect((await daemon.post('/mikka/v1/devices/register',{headers,data:{...registration,deviceId}})).status()).toBe(401)
    expect((await daemon.post(heartbeat,{headers:{authorization:`Bearer ${otherBearer}`},data:{harnesses:[],runs:[],worktreeDiskBytes:0}})).status()).toBe(200)
    const state=(await pg.query('SELECT "stopRequestedAt","leaseExpiresAt" FROM agent_runs WHERE id=$1',[runId])).rows[0]
    expect(state.stopRequestedAt).not.toBeNull()
    expect(new Date(state.leaseExpiresAt).getTime()).toBeLessThanOrEqual(Date.now())
    expect((await daemon.post('/mikka/api/mcp',{headers:{authorization:`Bearer ${worker}`,accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'report',arguments:{text:'must be refused'}}}})).status()).toBe(401)
    const list=await owner.get('/mikka/api/device-tokens')
    const text=await list.text()
    expect(text).not.toContain(bearer)
    expect(text).not.toContain('tokenHash')
    checks.push('re-enable and re-registration cannot revive token; sibling token works; worker token revoked and lease expired')
    const audit = await owner.get('/mikka/api/audit?action=device.credential.revoked')
    expect(audit.status()).toBe(200)
    const auditEvents = (await audit.json()).events.filter((row: {event:{resourceId:string}}) => row.event.resourceId===tokenId)
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0].event.actorId).toBe(userId)
    checks.push('owner audit HTTP lists exactly one correctly attributed credential revocation after retry')

    // Actual Next transport: terminate only the fixture's blocked SQL writer.
    const faultId=randomUUID(),faultRun=randomUUID(),faultBearer='orv_'+randomBytes(32).toString('hex'),faultGate='httpfault_'+randomUUID().replaceAll('-','')
    await pg.query('INSERT INTO device_tokens(id,"userId","tokenHash","lastUsedAt") VALUES($1,$2,$3,now())',[faultId,userId,createHash('sha256').update(faultBearer).digest('hex')])
    await pg.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","deviceId","deviceRepoId","deviceTokenId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval \'90 seconds\')',[faultRun,userId,agentId,issueId,deviceId,repoId,faultId,'preparing'])
    await pg.query(`CREATE FUNCTION ${faultGate}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${faultGate}',0)); RETURN NEW; END $$`)
    await pg.query(`CREATE TRIGGER ${faultGate} BEFORE INSERT ON run_chunks FOR EACH ROW WHEN (NEW."runId"='${faultRun}'::uuid) EXECUTE FUNCTION ${faultGate}()`)
    const faultLocker=await pg.connect()
    let faultRequest: ReturnType<typeof daemon.post> | undefined
    try {
      await faultLocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[faultGate])
      const lockerPid=(await faultLocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      faultRequest=daemon.post(`/mikka/v1/runs/${faultRun}/events`,{headers:{authorization:'Bearer '+faultBearer},data:{fromSeq:1,chunks:[{type:'text-delta',delta:'must roll back'}]}})
      let writers: {pid:number}[]=[]
      await expect.poll(async()=>{writers=(await pg.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[lockerPid])).rows;return writers.length}).toBe(1)
      await pg.query('SELECT pg_terminate_backend($1)',[writers[0].pid])
      expect((await owner.post(`/mikka/api/device-tokens/${faultId}/revoke`,{headers:{origin}})).status()).toBe(200)
      await faultLocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[faultGate])
      expect((await faultRequest).status()).toBeGreaterThanOrEqual(400)
      expect(Number((await pg.query('SELECT count(*) FROM run_chunks WHERE "runId"=$1',[faultRun])).rows[0].count)).toBe(0)
      checks.push('real Next HTTP writer connection failure rolls back chunk; subsequent owner revoke commits')
    } finally {
      await faultLocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[faultGate])
      faultLocker.release()
      if(faultRequest)await faultRequest.catch(()=>undefined)
    }

    // Hold the request body after initial admission/ownedRun. A PG table-lock
    // barrier proves ownedRun was entered, then its COMMIT proves it finished.
    // Revoke before supplying the rest of the body forces ORM BEGIN admission.
    for (let attempt=0;attempt<6;attempt++) {
      const midId=randomUUID(),midRun=randomUUID(),midBearer='orv_'+randomBytes(32).toString('hex')
      await pg.query('INSERT INTO device_tokens(id,"userId","tokenHash","lastUsedAt") VALUES($1,$2,$3,now())',[midId,userId,createHash('sha256').update(midBearer).digest('hex')])
      await pg.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceTokenId",status) VALUES($1,$2,$3,$4,$5,$6)',[midRun,userId,agentId,deviceId,midId,'preparing'])
      const barrier=await pg.connect()
      const payload=JSON.stringify({fromSeq:1,chunks:[{type:'text-delta',delta:'must not persist after mid-request revoke'}]})
      let finishBody: (()=>void)|undefined
      let requestDone: Promise<number>|undefined
      try {
        await barrier.query('BEGIN')
        await barrier.query('LOCK TABLE agent_runs IN ACCESS EXCLUSIVE MODE')
        const barrierPid=(await barrier.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        requestDone=new Promise<number>((resolve,reject)=>{
          const req=httpRequest(new URL(`/mikka/v1/runs/${midRun}/events`,origin),{method:'POST',headers:{authorization:'Bearer '+midBearer,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!))})
          req.on('error',reject)
          req.setTimeout(15000,()=>req.destroy(new Error('mid-request fixture timeout')))
          req.write(payload.slice(0,-1))
          finishBody=()=>req.end(payload.slice(-1))
        })
        let readers: {pid:number}[]=[]
        await expect.poll(async()=>{readers=(await pg.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[barrierPid])).rows;return readers.length}).toBe(1)
        const readerPid=readers[0].pid
        await barrier.query('COMMIT')
        await expect.poll(async()=>{const row=(await pg.query('SELECT state,query FROM pg_stat_activity WHERE pid=$1',[readerPid])).rows[0];return row?.state==='idle' && row.query==='COMMIT'}).toBe(true)
        expect((await owner.post(`/mikka/api/device-tokens/${midId}/revoke`,{headers:{origin}})).status()).toBe(200)
        finishBody!()
        finishBody=undefined
        expect(await requestDone).toBe(401)
        expect(Number((await pg.query('SELECT count(*) FROM run_chunks WHERE "runId"=$1',[midRun])).rows[0].count)).toBe(0)
      } finally {
        await barrier.query('ROLLBACK')
        barrier.release()
        finishBody?.()
        if(requestDone)await requestDone.catch(()=>undefined)
      }
    }
    checks.push('six actual HTTP requests revoked after ownedRun commit and before ORM BEGIN return 401 with zero chunks; pool remains available')

    // Independent SQL failure stays 500; retry the same batch after clearing
    // only its retained fixture fault control, using a still-live sibling token.
    const sqlRun=randomUUID(),sqlFault='sqlfault_'+randomUUID().replaceAll('-','')
    await pg.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceTokenId",status) VALUES($1,$2,$3,$4,$5,$6)',[sqlRun,userId,agentId,deviceId,otherId,'preparing'])
    await pg.query('CREATE TABLE IF NOT EXISTS daemon_sql_fault_controls(id uuid PRIMARY KEY,enabled boolean NOT NULL)')
    await pg.query('INSERT INTO daemon_sql_fault_controls VALUES($1,true)',[sqlRun])
    await pg.query(`CREATE FUNCTION ${sqlFault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM daemon_sql_fault_controls WHERE id='${sqlRun}'::uuid AND enabled) THEN RAISE EXCEPTION 'isolated independent SQL failure'; END IF; RETURN NEW; END $$`)
    await pg.query(`CREATE TRIGGER ${sqlFault} BEFORE INSERT ON run_chunks FOR EACH ROW WHEN (NEW."runId"='${sqlRun}'::uuid) EXECUTE FUNCTION ${sqlFault}()`)
    const sqlOptions={headers:{authorization:'Bearer '+otherBearer},data:{fromSeq:1,chunks:[{type:'text-delta',delta:'retry same synthetic batch'}]}}
    expect((await daemon.post(`/mikka/v1/runs/${sqlRun}/events`,sqlOptions)).status()).toBe(500)
    expect(Number((await pg.query('SELECT count(*) FROM run_chunks WHERE "runId"=$1',[sqlRun])).rows[0].count)).toBe(0)
    await pg.query('UPDATE daemon_sql_fault_controls SET enabled=false WHERE id=$1',[sqlRun])
    expect((await daemon.post(`/mikka/v1/runs/${sqlRun}/events`,sqlOptions)).status()).toBe(200)
    expect((await daemon.post(`/mikka/v1/runs/${sqlRun}/events`,sqlOptions)).status()).toBe(200)
    expect(Number((await pg.query('SELECT count(*) FROM run_chunks WHERE "runId"=$1',[sqlRun])).rows[0].count)).toBe(1)
    checks.push('independent SQL fault remains 500 with zero writes; same-batch explicit retry succeeds once after fault cleared')

    const evidencePath = info.outputPath('device-revocation-evidence.json')
    writeFileSync(evidencePath,JSON.stringify({sha:process.env.GITHUB_SHA,base:'a3294781eae74d824087c9c80bfc3f6093f196d7',migration:'20261025185500_daemon_revocation.sql',startedAt,finishedAt:new Date().toISOString(),environment:'isolated PG + actual Next HTTP',fixture:{deviceId,runId,tokenId},revocation:{revokedAt:receipt.revokedAt,stopRequestedAt:state.stopRequestedAt,leaseExpiresAt:state.leaseExpiresAt},endpointResults,checks},null,2))
    await info.attach('device-revocation-evidence',{path:evidencePath,contentType:'application/json'})
  } finally { if(runtime){runtime.stdin.write(JSON.stringify({action:'stop'})+'\n');await new Promise<void>(resolve=>{if(runtime!.exitCode!==null)resolve();else runtime!.once('exit',()=>resolve())})}await owner.dispose();await outsider.dispose();await daemon.dispose();await pg.end() }
})
