import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
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
      ['PATCH',`/v1/runs/${runId}`],['POST',`/v1/runs/${runId}/events`],['POST',`/v1/runs/${runId}/checkpoint`],['POST',`/v1/runs/${runId}/complete`],['POST',`/v1/runs/${runId}/skill-receipt`],['POST',`/v1/runs/${runId}/group-reply`],
    ]
    for(const [method,path] of endpoints) {
      const response=await daemon.fetch('/mikka'+path,{method,headers,...(method==='GET'?{}:{data:{}})})
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
    await info.attach('device-revocation-evidence',{body:JSON.stringify({sha:process.env.GITHUB_SHA,environment:'isolated PG + actual Next HTTP',checks}),contentType:'application/json'})
  } finally { if(runtime){runtime.stdin.write(JSON.stringify({action:'stop'})+'\n');await new Promise<void>(resolve=>{if(runtime!.exitCode!==null)resolve();else runtime!.once('exit',()=>resolve())})}await owner.dispose();await outsider.dispose();await daemon.dispose();await pg.end() }
})
