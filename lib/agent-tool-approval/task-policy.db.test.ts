import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { z } from 'zod'
import test, { after } from 'node:test'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { Pool } from 'pg'
import { observePoolCommits } from '../db/commit-effects'
import { readCliRunPolicy, readCliAgentPolicy, lockCliTaskScope, providerContinuationPolicy } from './policy-store'
import { readIssueMetadata } from '../issue-metadata'
import { setCliPolicy, setCliAgentPolicy } from './policy-settings'
import { AgentToolApprovalStore } from './store'
import { issuePolicySnapshot, policyDistributionContext } from './policy-distribution'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { POLICY_SNAPSHOT_TTL_MS } from '@mikka/protocol/policy-snapshot'
import { defaultRunPolicy, type RunPolicy } from '@mikka/protocol/agent-policy'
import { freezeWorkerDefinition } from '../agent-kit/worker'
import { intersectRunPolicy } from '../run-assignment-policy'
import { continuedRunPolicyCeiling } from '../computer/run-model'
import { humanSessionHeaders } from '../desktop-rpc/handler'
import { PgDialect } from 'drizzle-orm/pg-core'
import { runPolicyStopSQL, type RunPolicyStopScope } from '../run-policy-stop'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated task policy database is required')

after(async () => {
  if (!target) return
  const [{ pool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
  await Promise.all([pool.end(), workspacePool.end()])
})

test('task workspace policy applies to Coordinator and tenant-bound Bot runs', { skip: !target }, async t => {
  const priorSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'isolated-policy-distribution-test-fixture-only'
  const pool = new Pool({ connectionString: target })
  observePoolCommits(pool)
  const tokenId = randomUUID(), token = randomUUID()
  let server: ReturnType<typeof createServer> | undefined
  t.after(async () => {
    try {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server!.close(() => resolve()))
      }
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
    } finally { if(priorSecret===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=priorSecret; await pool.end() }
  })
  const owner = `policy230-${randomUUID()}`, device = randomUUID(), agent = randomUUID()
  const workspaceA = randomUUID(), workspaceB = randomUUID(), botA = randomUUID(), botB = randomUUID()
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [owner, `${owner}@example.invalid`])
  await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,\'Task policy fixture\')', [device, owner])
  await pool.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,\'codex\',\'Task policy fixture\',$3)', [agent, owner, device])
  for (const id of [workspaceA, workspaceB]) {
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Task policy fixture\')', [id, owner])
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [id, owner, `${owner}@example.invalid`])
  }
  await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Task policy fixture\')', [botB, owner, workspaceB])
  await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Task policy fixture\')', [botA, owner, workspaceA])
  const workspacePolicyA = { permissions: { install_dependency: 'deny' } }
  await pool.query('INSERT INTO workspace_computer_policies ("workspaceId",cli_run_policy) VALUES ($1,$2),($3,$4)', [workspaceA, workspacePolicyA, workspaceB, { permissions: { git_push: 'deny' } }])
  const personalWorkspace = await seedFixtureWorkspace(pool, owner)
  async function fixture(workspaceId: string | null, botId: string | null = null) {
    const issue = randomUUID(), run = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority,scope) VALUES ($1,$2,$4,\'Task policy fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',$3)', [issue, owner, workspaceId ? 'workspace' : 'personal', workspaceId ?? personalWorkspace])
    let team: string | null = null
    if (workspaceId) {
      team = randomUUID()
      await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,\'Task policy fixture\',$4)', [team, workspaceId, owner, `T${team.slice(0, 8)}`])
      await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [issue, team, workspaceId, owner])
    }
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","botId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,\'running\',now()+interval \'5 minutes\')', [run, owner, issue, agent, device, botId])
    return { issue, run, team }
  }
  const a = await fixture(workspaceA), b = await fixture(workspaceB), personal = await fixture(null), cross = await fixture(workspaceB, botB)
  const project = randomUUID()
  await pool.query(`INSERT INTO workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision) VALUES($1,$2,'Policy project','','','started','none','','','','',$3,1)`,[project,owner,JSON.stringify([a.issue])])
  await pool.query(`INSERT INTO mikka_team_projects("projectId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[project,a.team,workspaceA,owner])
  const read = (run: string) => readCliRunPolicy(pool, run, owner)
  await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [tokenId, owner, createHash('sha256').update(token).digest('hex')])
  const { POST } = await import('../../app/v1/runs/[runId]/tool-approval/route')
  const snapshotRoutes = await import('../../app/v1/runs/[runId]/policy-snapshot/route')
  // Execute the real route, human-session header boundary and store against PG.
  // Only session identity is synthetic; this is not login/OAuth acceptance.
  const ownerSessionToken = 'A'.repeat(32), foreignSessionToken = 'B'.repeat(32)
  const settingsModules: Record<string, unknown> = { 'zod': { z }, '@/lib/db': { pool },
    '@/lib/api-auth': { auth: { api: { getSession: async ({ headers, query }: { headers: Headers; query?: { disableCookieCache?: boolean } }) => {
      assert.equal(query?.disableCookieCache, true, 'settings must revalidate the human session')
      const authorization = headers.get('authorization')
      if (authorization) {
        assert.equal(headers.has('cookie'), false, 'browser cookies must never rescue a bearer')
        const id = authorization === `Bearer ${ownerSessionToken}` ? owner : authorization === `Bearer ${foreignSessionToken}` ? 'other-owner' : null
        return id ? { user: { id } } : null
      }
      const cookie = headers.get('cookie')
      return cookie === 'owner=1' ? { user: { id: owner } } : cookie === 'other=1' ? { user: { id: 'other-owner' } } : null
    } } } },
    '@/lib/desktop-rpc/handler': { humanSessionHeaders },
    '@/lib/agent-tool-approval/policy-store': { readCliRunPolicy, readCliAgentPolicy },
    '@/lib/agent-tool-approval/policy-settings': { setCliPolicy, setCliAgentPolicy },
  }
  const settingsExports: Record<string, unknown> = {}
  const settingsSource = await readFile(new URL('../../app/api/agent-cli-policy/route.ts', import.meta.url), 'utf8')
  runInNewContext(transpileModule(settingsSource, {compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports:settingsExports,require:(name:string)=>{if(!Object.hasOwn(settingsModules,name))throw Error(`Unexpected settings import ${name}`);return settingsModules[name]},Response,URL})
  const settingsRoute = settingsExports.POST as (request:Request)=>Promise<Response>
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const route = request.url!.includes('/policy-snapshot') ? (request.method==='GET'?snapshotRoutes.GET:snapshotRoutes.POST) : POST
      const input = new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers: request.headers as HeadersInit, ...(request.method==='GET'?{}:{body:Buffer.concat(chunks)}) })
      const result = request.url === '/api/agent-cli-policy' ? await settingsRoute(input) : await route(input, { params: Promise.resolve({ runId: new URL(request.url!, 'http://127.0.0.1').pathname.split('/')[3] }) })
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
    } catch { response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const checkHTTP = (policyRevision: string, runId = a.run) => fetch(`http://127.0.0.1:${address.port}/v1/runs/${runId}/tool-approval`, {
    method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'check', deviceId: device, policyRevision }),
  })
  await t.test('human settings retain same-origin, fresh-session and tenant checks for browser and native callers', async () => {
    const origin = `http://127.0.0.1:${address.port}`
    const readSettings = (headers: Record<string, string>) => fetch(`${origin}/api/agent-cli-policy`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ operation: 'read', runId: a.run }),
    })
    const expected = await read(a.run)
    const validHeaders: Record<string, string>[] = [{ cookie: 'owner=1' }, { authorization: `Bearer ${ownerSessionToken}`, cookie: 'other=1' }]
    for (const headers of validHeaders) {
      const response = await readSettings(headers)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(expected)))
    }
    for (const authorization of [`Bearer ${'C'.repeat(32)}`, `Bearer mkp_${'a'.repeat(43)}`, 'Bearer invalid']) {
      assert.equal((await readSettings({ authorization, cookie: 'owner=1' })).status, 401)
    }
    assert.equal((await readSettings({ authorization: `Bearer ${foreignSessionToken}`, cookie: 'owner=1' })).status, 409)
    assert.equal((await readSettings({ cookie: 'other=1' })).status, 409)
    assert.equal((await readSettings({ authorization: `Bearer ${ownerSessionToken}`, origin: 'https://foreign.example.invalid' })).status, 401)
    assert.equal((await readSettings({ cookie: 'owner=1', origin: '' })).status, 401)
    assert.equal((await readSettings({})).status, 401)
  })
  await t.test('signed policy HTTP context and renewal bind the current run and retain final restrictions', async () => {
    const issuer=`http://127.0.0.1:${address.port}`,url=`${issuer}/v1/runs/${a.run}/policy-snapshot`,auth={'x-mikka-client-version':'0.0.456',authorization:`Bearer ${token}`,'content-type':'application/json'}
    const current=await read(a.run),context=policyDistributionContext(issuer,owner,device,a.run,current)
    const finalPolicy={...current.policy,readOnly:true,permissions:{...current.policy.permissions,computer_use:'deny' as const}}
    const expired=issuePolicySnapshot(context,finalPolicy,Date.now()-POLICY_SNAPSHOT_TTL_MS-1000)
    assert.equal((await fetch(`${url}?deviceId=${device}`)).status,401)
    const metadata=await fetch(`${url}?deviceId=${device}`,{headers:auth})
    assert.equal(metadata.status,200);assert.deepEqual(await metadata.json(),context)
    const renew=async(snapshot:unknown,deviceId=device)=>fetch(url,{method:'POST',headers:auth,body:JSON.stringify({deviceId,snapshot})})
    const response=await renew(expired);assert.equal(response.status,200)
    const renewed=verifyPolicySnapshot(await response.json(),context,{runId:a.run,deviceId:device,revision:current.revision,policy:finalPolicy})
    assert.equal(renewed.payload.policy.readOnly,true);assert.equal(renewed.payload.policy.permissions.computer_use,'deny')
    assert.equal(renewed.payload.policyHash,expired.payload.policyHash)
    assert.ok(renewed.payload.expiresAt>Date.now())
    const tampered=structuredClone(expired);tampered.payload.policy.readOnly=false
    assert.equal((await renew(tampered)).status,409)
    const foreign=issuePolicySnapshot({...context,ownerId:'foreign-owner'},finalPolicy)
    assert.equal((await renew(foreign)).status,409)
    assert.equal((await renew(expired,randomUUID())).status,409)
    // The same exact endpoint must pass the cloud token's narrow run ownership gate.
    const scopedId=randomUUID(),scopedToken=randomUUID()
    await pool.query(`UPDATE devices SET kind='cloud' WHERE id=$1`,[device])
    await pool.query(`INSERT INTO cloud_machines("workspaceId","ownerId","deviceId","operationId") VALUES($1,$2,$3,$4)`,[workspaceA,owner,device,randomUUID()])
    await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`,[scopedId,owner,createHash('sha256').update(scopedToken).digest('hex'),device,workspaceA])
    try {
      const scoped={authorization:`Bearer ${scopedToken}`,'content-type':'application/json'}
      assert.equal((await fetch(`${url}?deviceId=${device}`,{headers:scoped})).status,200)
      const cloudCurrent=await read(a.run),cloudContext=policyDistributionContext(issuer,owner,device,a.run,cloudCurrent)
      const cloudSnapshot=issuePolicySnapshot(cloudContext,{...cloudCurrent.policy,readOnly:true})
      assert.equal((await fetch(url,{method:'POST',headers:scoped,body:JSON.stringify({deviceId:device,snapshot:cloudSnapshot})})).status,200)
      assert.equal((await fetch(`${issuer}/v1/runs/${randomUUID()}/policy-snapshot?deviceId=${device}`,{headers:scoped})).status,401)
    } finally {
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1',[scopedId])
      await pool.query('DELETE FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2',[workspaceA,owner])
      await pool.query(`UPDATE devices SET kind='local' WHERE id=$1`,[device])
    }
    await setCliPolicy(pool,owner,a.run,'workspace',current.revision,{permissions:{install_dependency:'deny',network:'deny'}})
    assert.equal((await renew(expired)).status,409,'current revision cannot renew an old approval policy')
    await setCliPolicy(pool,owner,a.run,'workspace',(await read(a.run)).revision,workspacePolicyA)
    await pool.query(`UPDATE agent_runs SET status='stopped' WHERE id=$1`,[a.run])
    assert.equal((await fetch(`${url}?deviceId=${device}`,{headers:auth})).status,409)
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`,[a.run])
  })
  await t.test('cross-harness provider policy survives live settings, broker grants and signed HTTP renewal', async () => {
    const sourceAgent = randomUUID(), nextAgent = randomUUID()
    await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'codex','Provider source fixture',$3),($4,$2,'claude_code','Provider target fixture',$3)`, [sourceAgent, owner, device, nextAgent])
    const source = await fixture(null), child = await fixture(null), unrelated = await fixture(null)
    await pool.query('UPDATE agent_runs SET "agentId"=$2 WHERE id=$1', [source.run, sourceAgent])
    await pool.query('UPDATE agent_runs SET "agentId"=$2,"issueId"=$3 WHERE id=$1', [child.run, nextAgent, source.issue])
    await pool.query('UPDATE agent_runs SET "agentId"=$2 WHERE id=$1', [unrelated.run, nextAgent])
    await setCliPolicy(pool, owner, source.run, 'worker', (await read(source.run)).revision,
      { approvalMode: 'read_only', permissions: { git_push: 'deny' }, networkAllow: ['*.example.invalid'] })
    const capture = async (runId: string, userId = owner) => {
      const tx = await pool.connect()
      try { await tx.query('BEGIN'); const value = await providerContinuationPolicy(tx, userId, runId); await tx.query('COMMIT'); return value }
      catch (error) { await tx.query('ROLLBACK'); throw error }
      finally { tx.release() }
    }
    const ceiling = await capture(source.run)
    const definition = freezeWorkerDefinition({ harness: 'claude_code', instructions: '', prompt: 'Same task', parent: null, executionId: null, model: 'fixture-model', policyCeiling: ceiling })
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$2,"retryOf"=$3 WHERE id=$1', [child.run, JSON.stringify(definition), source.run])
    const current = await read(child.run)
    assert.equal(current.policy.readOnly, true)
    assert.equal(current.policy.permissions.git_push, 'deny')
    assert.equal(current.policy.permissions.install_dependency, 'deny')
    assert.equal(current.policy.permissions.computer_use, 'deny')
    assert.deepEqual(current.policy.networkCeiling, ['*.example.invalid'])
    assert.equal((await read(unrelated.run)).policy.readOnly, undefined, 'the target worker and unrelated task are not rewritten')
    assert.deepEqual(await continuedRunPolicyCeiling(pool, owner, source.issue, child.run, undefined), ceiling)
    assert.equal(await continuedRunPolicyCeiling(pool, owner, unrelated.issue, child.run, undefined), undefined)
    assert.equal(await continuedRunPolicyCeiling(pool, 'foreign-owner', source.issue, child.run, undefined), undefined)
    await assert.rejects(capture(source.run, 'foreign-owner'), /agentPolicyUnavailable/)
    const finalPolicy = intersectRunPolicy({ ...current.policy, permissions: { ...current.policy.permissions, git_push: 'allow', computer_use: 'allow' } }, ceiling)
    const issuer = `http://127.0.0.1:${address.port}`, url = `${issuer}/v1/runs/${child.run}/policy-snapshot`
    const auth = { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const context = policyDistributionContext(issuer, owner, device, child.run, current)
    const expired = issuePolicySnapshot(context, finalPolicy, Date.now() - POLICY_SNAPSHOT_TTL_MS - 1000)
    const renew = () => fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ deviceId: device, snapshot: expired }) })
    const response = await renew()
    assert.equal(response.status, 200)
    const renewed = verifyPolicySnapshot(await response.json(), context, { runId: child.run, deviceId: device, revision: current.revision, policy: finalPolicy })
    assert.equal(renewed.payload.policy.readOnly, true)
    assert.equal(renewed.payload.policy.permissions.git_push, 'deny')
    assert.equal(renewed.payload.policy.permissions.computer_use, 'deny')
    assert.deepEqual(renewed.payload.policy.networkCeiling, ['*.example.invalid'])
    assert.deepEqual(await (await checkHTTP(current.revision, child.run)).json(), { live: true, paused: false })
    const relaxed = await setCliPolicy(pool, owner, child.run, 'worker', current.revision,
      { permissions: { install_dependency: 'allow', git_push: 'allow', network: 'allow' } })
    assert.equal(relaxed.policy.readOnly, true)
    assert.equal(relaxed.policy.permissions.git_push, 'deny')
    assert.deepEqual(relaxed.policy.networkCeiling, ['*.example.invalid'])
    assert.notEqual(relaxed.revision, current.revision)
    assert.deepEqual(await (await checkHTTP(current.revision, child.run)).json(), { live: false, paused: false })
    assert.equal((await renew()).status, 409, 'settings changes revoke the old signed policy revision')
    const narrowed = await setCliPolicy(pool, owner, child.run, 'worker', relaxed.revision, { permissions: { network: 'deny' } })
    assert.equal(narrowed.policy.permissions.network, 'deny')
    assert.deepEqual(await (await checkHTTP(narrowed.revision, child.run)).json(), { live: true, paused: false })
    await setCliPolicy(pool, owner, source.run, 'worker', (await read(source.run)).revision, {})
    assert.equal((await read(child.run)).policy.readOnly, true, 'later source changes cannot remove the captured ceiling')
    const computerOnly: RunPolicy = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use: 'deny' } }
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [unrelated.run, JSON.stringify(freezeWorkerDefinition({ harness: 'claude_code', instructions: '', prompt: '', parent: null, executionId: null, model: 'fixture-model', policyCeiling: computerOnly }))])
    const inherited = await capture(unrelated.run)
    assert.equal(inherited.readOnly, undefined)
    assert.equal(inherited.permissions.computer_use, 'deny', 'a subsequent fallback retains an explicit broker ceiling even without readOnly')
  })
  await t.test('Coordinator tasks inherit their own workspace ceiling without changing the global head', async () => {
    const policyA = await read(a.run), policyB = await read(b.run), privatePolicy = await read(personal.run)
    assert.equal(policyA.workspaceId, workspaceA)
    assert.equal(policyA.policy.permissions.install_dependency, 'deny')
    assert.equal(policyB.policy.permissions.git_push, 'deny')
    assert.equal(policyB.policy.permissions.install_dependency, 'allow')
    assert.equal(privatePolicy.workspaceId, personalWorkspace)
    assert.equal(privatePolicy.policy.permissions.install_dependency, 'allow')
    const head = (await pool.query('SELECT workspace_id FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=\'coordinator\'', [owner])).rows[0]
    assert.equal(head.workspace_id, null)
  })
  await t.test('a Bot cannot cross the frozen task tenant and its own membership is rechecked', async () => {
    await assert.rejects(pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [cross.run, a.issue]), /taskWorkspaceMismatch/)
    assert.equal((await pool.query('SELECT "issueId" FROM agent_runs WHERE id=$1', [cross.run])).rows[0].issueId, cross.issue)
    const current = await read(cross.run)
    assert.equal(current.policy.permissions.install_dependency, 'allow')
    assert.equal(current.policy.permissions.git_push, 'deny')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceB, owner])
    await assert.rejects(read(cross.run))
    assert.equal((await read(a.run)).policy.permissions.install_dependency, 'deny')
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceB, owner])
  })
  await t.test('workspace changes end the live check and rollback never revives its revision', async () => {
    const store = new AgentToolApprovalStore(pool), actor = { userId: owner, deviceId: device }
    const initial = await read(a.run)
    assert.deepEqual(await (await checkHTTP(initial.revision)).json(), { live: true, paused: false })
    const changed = await setCliPolicy(pool, owner, a.run, 'workspace', initial.revision, { permissions: { install_dependency: 'deny', git_push: 'deny' } })
    assert.equal(await store.check(actor, a.run, initial.revision), false)
    assert.deepEqual(await (await checkHTTP(initial.revision)).json(), { live: false, paused: false })
    const reverted = await setCliPolicy(pool, owner, a.run, 'workspace', changed.revision, workspacePolicyA)
    assert.notEqual(reverted.revision, initial.revision)
    assert.equal(await store.check(actor, a.run, reverted.revision), true)
  })
  await t.test('a lower agent layer cannot loosen the task workspace limit', async () => {
    const current = await read(a.run)
    const next = await setCliPolicy(pool, owner, a.run, 'agent', current.revision, { permissions: { install_dependency: 'allow' } })
    assert.equal(next.policy.permissions.install_dependency, 'deny')
    assert.equal((await read(personal.run)).policy.permissions.install_dependency, 'allow')
  })
  await t.test('team and shared-project ceilings are derived, intersected and live-versioned', async () => {
    const initial = await read(a.run)
    assert.deepEqual(initial.hierarchy, { workspaceId: workspaceA, teamId: a.team, projectId: project })
    const team = await setCliPolicy(pool,owner,a.run,'team',initial.revision,{permissions:{network:'deny'}})
    const scoped = await setCliPolicy(pool,owner,a.run,'project',team.revision,{permissions:{git_push:'deny'}})
    const lower = await setCliPolicy(pool,owner,a.run,'worker',scoped.revision,{permissions:{network:'allow',git_push:'allow'}})
    assert.equal(lower.policy.permissions.network,'deny')
    assert.equal(lower.policy.permissions.git_push,'deny')
    assert.equal(lower.policy.permissions.install_dependency,'deny')
    assert.equal((await read(b.run)).layers.team?.permissions?.network,undefined)
    assert.equal((await read(personal.run)).hierarchy,undefined)
    assert.deepEqual(await (await checkHTTP(initial.revision)).json(),{live:false,paused:false})
    assert.deepEqual(await (await checkHTTP(lower.revision)).json(),{live:true,paused:false})
    const changed = await setCliPolicy(pool,owner,a.run,'project',lower.revision,{permissions:{git_push:'deny',install_dependency:'deny'}})
    const rolledBack = await setCliPolicy(pool,owner,a.run,'project',changed.revision,lower.layers.project)
    assert.notEqual(rolledBack.revision,lower.revision)
  })
  await t.test('only a current workspace admin can change team or project ceilings', async () => {
    const before = await read(a.run)
    await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspaceA,owner])
    for (const target of ['team','project'] as const) await assert.rejects(setCliPolicy(pool,owner,a.run,target,before.revision,{permissions:{network:'allow'}}))
    assert.equal((await read(a.run)).revision,before.revision)
    const audits = (await pool.query(`SELECT metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='agent.policy_changed' AND metadata->>'scope' IN ('team','project')`,[workspaceA])).rows
    assert.equal(audits.length,4,'failed non-admin changes leave neither policy nor audit effects')
    assert.ok(audits.every(row => Object.keys(row.metadata).sort().join(',') === 'revision,scope'))
    await pool.query(`UPDATE mikka_workspace_members SET role='admin' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspaceA,owner])
  })
  await t.test('organization defaults inherit by specificity, explicit Agent values override, forced ceilings and revisions remain binding', async () => {
    const subject=await fixture(workspaceA),crossSubject=await fixture(workspaceA,botA),defaultProject=randomUUID()
    await pool.query('UPDATE mikka_team_issues SET "teamId"=$2 WHERE "issueId"=$1',[crossSubject.issue,subject.team])
    await pool.query(`INSERT INTO workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision) VALUES($1,$2,'Defaults project','','','started','none','','','','',$3,1)`,[defaultProject,owner,JSON.stringify([subject.issue,crossSubject.issue])])
    await pool.query(`INSERT INTO mikka_team_projects("projectId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[defaultProject,subject.team,workspaceA,owner])
    const original=await read(subject.run),botOriginal=await read(b.run),origin=`http://127.0.0.1:${address.port}`
    const settings=async(runId:string,target:string,policy:unknown,cookie='owner=1')=>fetch(`${origin}/api/agent-cli-policy`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({operation:'set',runId,target,expectedRevision:(await read(runId)).revision,policy})})
    const publish=async(runId:string,target:string,policy:unknown)=>{const response=await settings(runId,target,policy);assert.equal(response.status,200);return response.json() as Promise<Awaited<ReturnType<typeof read>>>}
    try {
      await publish(b.run,'workspace',{...botOriginal.layers.workspace,defaults:{permissions:{network:'deny',git_push:'deny'},networkAllow:['bot-default.invalid'],approvalMode:'read_only'}})
      const workspace=await publish(subject.run,'workspace',{...original.layers.workspace,defaults:{permissions:{network:'ask',git_push:'ask'},networkAllow:['task-default.invalid'],approvalMode:'ask'}})
      assert.equal(workspace.policy.permissions.network,'ask');assert.deepEqual(workspace.policy.networkAllow,['task-default.invalid'])
      const teamDefaults={permissions:{network:'allow',git_push:'deny'},networkAllow:['team-default.invalid'],approvalMode:'read_only'}
      const team=await publish(subject.run,'team',{defaults:teamDefaults})
      assert.equal(team.policy.readOnly,true);assert.equal(team.policy.permissions.git_push,'deny')
      const projectDefaults={permissions:{git_push:'allow'},networkAllow:['project-default.invalid'],approvalMode:'ask'}
      const projectPolicy=await publish(subject.run,'project',{defaults:projectDefaults})
      assert.equal(projectPolicy.policy.permissions.network,'allow');assert.equal(projectPolicy.policy.permissions.git_push,'allow')
      assert.equal(projectPolicy.policy.readOnly,undefined);assert.equal(projectPolicy.policy.permissions.install_dependency,'deny')
      assert.deepEqual(projectPolicy.policy.networkAllow,['project-default.invalid'])
      const inherited=await read(crossSubject.run)
      assert.deepEqual(inherited.defaultSources.map(source=>[source.scope,source.scopeId]),[['workspace',workspaceA],['team',subject.team],['project',defaultProject]])
      assert.equal(inherited.policy.permissions.network,'allow');assert.equal(inherited.policy.permissions.git_push,'allow','another workspace cannot contribute defaults or ceilings to this task')
      assert.equal(inherited.policy.permissions.install_dependency,'deny','the actual task workspace ceiling remains binding')
      assert.equal((await read(b.run)).policy.permissions.git_push,'deny','the other workspace retains its own forced ceiling')
      assert.deepEqual(inherited.policy.networkAllow,['project-default.invalid']);assert.equal(inherited.policy.readOnly,undefined)
      const explicit=await publish(subject.run,'agent',{permissions:{network:'ask',git_push:'deny'},networkAllow:['explicit.invalid'],approvalMode:'ask'})
      assert.equal(explicit.policy.permissions.network,'ask');assert.equal(explicit.policy.permissions.git_push,'deny');assert.deepEqual(explicit.policy.networkAllow,['explicit.invalid'])
      await publish(subject.run,'team',{permissions:{network:'deny'},defaults:teamDefaults})
      const constrained=await publish(subject.run,'agent',{permissions:{network:'allow',git_push:'allow'},networkAllow:['explicit.invalid']})
      assert.equal(constrained.policy.permissions.network,'deny');assert.equal(constrained.policy.permissions.install_dependency,'deny')
      assert.equal((await settings(subject.run,'agent',{defaults:{permissions:{network:'allow'}}})).status,409)
      assert.equal((await settings(subject.run,'worker',{defaults:{permissions:{network:'allow'}}})).status,409)
      assert.equal((await settings(subject.run,'project',{defaults:{permissions:{computer_use:'allow'}}})).status,409)
      const beforeDenied=await read(subject.run)
      await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspaceA,owner])
      try {assert.equal((await settings(subject.run,'project',{defaults:projectDefaults})).status,409)}
      finally {await pool.query(`UPDATE mikka_workspace_members SET role='admin' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspaceA,owner])}
      assert.equal((await read(subject.run)).revision,beforeDenied.revision)
      await publish(subject.run,'agent',original.layers.agent)
      await publish(subject.run,'team',{defaults:teamDefaults})
      const before=await read(subject.run),store=new AgentToolApprovalStore(pool),actor={userId:owner,deviceId:device}
      const snapshot=issuePolicySnapshot(policyDistributionContext(origin,owner,device,subject.run,before),before.policy)
      const changed=await publish(subject.run,'project',{defaults:{...projectDefaults,networkAllow:['changed-default.invalid']}})
      assert.notEqual(changed.revision,before.revision)
      assert.notEqual(issuePolicySnapshot(policyDistributionContext(origin,owner,device,subject.run,changed),changed.policy).payload.policyHash,snapshot.payload.policyHash)
      assert.equal(await store.check(actor,subject.run,before.revision),false)
      assert.equal((await fetch(`${origin}/v1/runs/${subject.run}/policy-snapshot`,{method:'POST',headers:{'x-mikka-client-version':'0.0.456',authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({deviceId:device,snapshot})})).status,409)
      const reverted=await publish(subject.run,'project',{defaults:projectDefaults})
      assert.notEqual(reverted.revision,before.revision)
      const readResponse=await fetch(`${origin}/api/agent-cli-policy`,{method:'POST',headers:{cookie:'owner=1',origin,'content-type':'application/json'},body:JSON.stringify({operation:'read',runId:subject.run})})
      assert.equal(readResponse.status,200);assert.deepEqual((await readResponse.json()).defaults,reverted.defaults)
      const audits=(await pool.query(`SELECT metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='agent.policy_changed'`,[workspaceA])).rows
      assert.ok(audits.some(row=>row.metadata.scope==='workspace'))
      assert.ok(audits.every(row=>Object.keys(row.metadata).sort().join(',')==='revision,scope'))
    } finally {
      await setCliPolicy(pool,owner,subject.run,'agent',(await read(subject.run)).revision,original.layers.agent)
      await setCliPolicy(pool,owner,subject.run,'workspace',(await read(subject.run)).revision,original.layers.workspace)
      await setCliPolicy(pool,owner,b.run,'workspace',(await read(b.run)).revision,botOriginal.layers.workspace)
    }
  })
  await t.test('joining a stricter project invalidates an already admitted run', async () => {
    const control = await fixture(workspaceA), candidate = await fixture(workspaceA), scopedProject = randomUUID()
    await pool.query(`UPDATE mikka_team_issues SET "teamId"=$2 WHERE "issueId"=$1`,[candidate.issue,control.team])
    await pool.query(`INSERT INTO workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision) VALUES($1,$2,'Stricter policy project','','','started','none','','','','',$3,1)`,[scopedProject,owner,JSON.stringify([control.issue])])
    await pool.query(`INSERT INTO mikka_team_projects("projectId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`,[scopedProject,control.team,workspaceA,owner])
    const controlPolicy = await read(control.run)
    await setCliPolicy(pool,owner,control.run,'project',controlPolicy.revision,{permissions:{git_push:'deny'}})
    const old = await read(candidate.run)
    // The default before the stricter layer: push is the GitHub App grant (allow), never ask.
    assert.equal(old.policy.permissions.git_push,'allow')
    await pool.query(`UPDATE workspace_projects SET "issueIds"=$2,revision=revision+1 WHERE id=$1`,[scopedProject,JSON.stringify([control.issue,candidate.issue])])
    await assert.rejects(read(candidate.run),/agentPolicyChanged/)
    assert.equal((await checkHTTP(old.revision,candidate.run)).status,409)
    const fresh = randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,'running',now()+interval '5 minutes')`,[fresh,owner,candidate.issue,agent,device])
    assert.equal((await read(fresh)).policy.permissions.git_push,'deny')
  })
  await t.test('changing to a stricter team invalidates an admitted run in the same workspace', async () => {
    const control = await fixture(workspaceA), candidate = await fixture(workspaceA)
    const controlPolicy = await read(control.run)
    await setCliPolicy(pool,owner,control.run,'team',controlPolicy.revision,{permissions:{git_push:'deny'}})
    const old = await read(candidate.run)
    // The default before the stricter layer: push is the GitHub App grant (allow), never ask.
    assert.equal(old.policy.permissions.git_push,'allow')
    await pool.query(`UPDATE mikka_team_issues SET "teamId"=$2 WHERE "issueId"=$1`,[candidate.issue,control.team])
    await assert.rejects(read(candidate.run),/agentPolicyChanged/)
    assert.equal((await checkHTTP(old.revision,candidate.run)).status,409)
    const fresh = randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,'running',now()+interval '5 minutes')`,[fresh,owner,candidate.issue,agent,device])
    assert.equal((await read(fresh)).policy.permissions.git_push,'deny')
  })
  await t.test('leaving a project rejects an admitted run instead of widening it; new runs resolve current relations', async () => {
    const admitted = await read(a.run)
    await pool.query(`UPDATE workspace_projects SET "issueIds"='[]'::jsonb WHERE id=$1`,[project])
    await assert.rejects(read(a.run),/agentPolicyChanged/)
    assert.equal((await checkHTTP(admitted.revision)).status,409)
    const fresh = randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,'running',now()+interval '5 minutes')`,[fresh,owner,a.issue,agent,device])
    const current = await read(fresh)
    assert.equal(current.hierarchy?.projectId,null)
    assert.equal(current.hierarchy?.teamId,a.team)
    assert.equal(current.layers.project,undefined)
    assert.equal(current.policy.permissions.network,'deny')
    // The task's current workspace is still authoritative; an admitted hierarchy
    // cannot cross tenant scope even if the owner belongs to both workspaces.
    await pool.query(`UPDATE mikka_team_issues SET "workspaceId"=$2,"teamId"=$3 WHERE "issueId"=$1`,[a.issue,workspaceB,b.team])
    await assert.rejects(read(a.run))
    await pool.query(`UPDATE mikka_team_issues SET "workspaceId"=$2,"teamId"=$3 WHERE "issueId"=$1`,[a.issue,workspaceA,a.team])
    await pool.query(`UPDATE workspace_projects SET "issueIds"=$2,revision=revision+1 WHERE id=$1`,[project,JSON.stringify([a.issue])])
  })
  await t.test('task membership revocation denies the next live check and policy read', async () => {
    const store = new AgentToolApprovalStore(pool), current = await read(a.run)
    await pool.query('UPDATE mikka_workspace_members SET status=\'removed\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceA, owner])
    await assert.rejects(read(a.run))
    await assert.rejects(store.check({ userId: owner, deviceId: device }, a.run, current.revision))
    assert.equal((await checkHTTP(current.revision)).status, 409)
    assert.equal((await read(b.run)).policy.permissions.git_push, 'deny')
    assert.equal((await read(personal.run)).workspaceId, personalWorkspace)
  })
})

test('task policy transfers metadata without document bodies and retains complete metadata parsing', { skip: !target }, async t => {
  const admin = new Pool({ connectionString: target })
  const schema = `policy_projection_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.query(`CREATE TABLE "${schema}".issues (id uuid PRIMARY KEY,"userId" text,scope text,"scopeVersion" int,content jsonb,"workspaceId" uuid,"ownershipState" text)`)
  const database = new Pool({ connectionString: target, options: `-c search_path=${schema}` })
  t.after(async () => { client.release(); await database.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  const id = randomUUID(), owner = randomUUID()
  const workspaceId = await seedFixtureWorkspace(admin, owner)
  const client = await database.connect()
  const marker = 'SYNTHETIC_DOCUMENT_BODY_'
  const document = { type: 'doc', attrs: { mikka: { labels: [{ name: 'fixture', color: 'blue' }] } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: marker.repeat(50000) }] }] }
  await client.query('INSERT INTO issues VALUES($1,$2,\'personal\',1,$3,$4,\'bound\')', [id,owner,document,workspaceId])
  const original = client.query.bind(client)
  let returned: { content: unknown }[] = []
  const measured = new Proxy(client, { get(object, key) {
    if (key === 'query') return async (text: string, args: unknown[]) => {
      const result = await original(text,args); returned = result.rows; return result
    }
    const value = Reflect.get(object,key,object)
    return typeof value === 'function' ? value.bind(object) : value
  } })
  const stream = (client as unknown as { connection: { stream: { bytesRead: number } } }).connection.stream
  const fullStart = stream.bytesRead
  await client.query('SELECT "userId",scope,"scopeVersion",content FROM issues WHERE id=$1',[id])
  const fullBytes = stream.bytesRead-fullStart
  const projectedStart = stream.bytesRead
  assert.deepEqual(await lockCliTaskScope(measured,owner,id), { issueId:id,scopeVersion:1,workspaceId })
  const projectedBytes = stream.bytesRead-projectedStart
  assert.equal(JSON.stringify(returned).includes(marker),false,'policy authorization must not fetch a document body')
  assert.ok(projectedBytes < fullBytes/100, 'large synthetic documents must not cross the policy connection')
  t.diagnostic(JSON.stringify({ fullDocumentProtocolBytes:fullBytes,metadataProtocolBytes:projectedBytes }))

  const deleted = '2026-11-03T12:00:00.000Z'
  const fixtures: unknown[] = [
    { type:'doc',attrs:{mikka:{deletedAt:deleted}} },
    { type:'doc',attrs:{orvilo:{deletedAt:deleted}} },
    { type:'doc',attrs:{mikka:null,orvilo:{deletedAt:deleted}} },
    { type:'doc',attrs:{mikka:{},orvilo:{deletedAt:deleted}} },
    { type:'doc',attrs:{mikka:{deletedAt:deleted,labels:'invalid-entire-metadata'}} },
    { type:'doc',attrs:{mikka:0,orvilo:{deletedAt:deleted}} },
    { type:'doc',attrs:null }, { type:'doc',attrs:'invalid-attrs' }, {}, [], 'invalid-root', 17, null,
  ]
  for (const content of fixtures) {
    await client.query('UPDATE issues SET content=$2 WHERE id=$1',[id,JSON.stringify(content)])
    let expected = 'allowed'
    try { if (readIssueMetadata(content as Parameters<typeof readIssueMetadata>[0]).deletedAt) expected = 'Error' }
    catch (error) { expected = (error as Error).name }
    let actual = 'allowed'
    try { await lockCliTaskScope(measured,owner,id) }
    catch (error) { actual = (error as Error).name }
    assert.equal(actual,expected,'projection must preserve legacy/null/invalid metadata semantics')
    if (content !== null) assert.deepEqual(readIssueMetadata(returned[0].content as Parameters<typeof readIssueMetadata>[0]),readIssueMetadata(content as Parameters<typeof readIssueMetadata>[0]))
  }
  await client.query('UPDATE issues SET content=\'{"type":"doc"}\' WHERE id=$1',[id])
  await assert.rejects(lockCliTaskScope(measured,'another-owner',id),/agentPolicyUnavailable/)
  await assert.rejects(lockCliTaskScope(measured,owner,randomUUID()),/agentPolicyUnavailable/)
})

test('direct machine policy changes stop exactly their admitted scope in the same transaction', { skip: !target }, async t => {
  const admin = new Pool({ connectionString: target })
  const schema = `policy_stop_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const database = new Pool({ connectionString: target, options: `-c search_path=${schema}` })
  t.after(async () => { await database.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() })
  await database.query(`CREATE TABLE bots (id uuid PRIMARY KEY,"workspaceId" uuid);
    CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"agentId" uuid,"botId" uuid,"issueId" uuid,"deviceId" uuid,
      "machineAuthority" boolean,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz,cli_policy_hierarchy jsonb,"workspaceId" uuid)`)
  const [wa, wb, ba, bb, aa, ab, ia, ib, ic, ta, tb, pa, pb, device] = Array.from({ length: 14 }, () => randomUUID())
  await database.query('INSERT INTO bots VALUES($1,$2),($3,$4)', [ba, wa, bb, wb])
  const rows = [
    { owner: 'a', agent: aa, bot: ba, issue: ia, workspace: wa, team: ta, project: pa, direct: true, status: 'running' },
    { owner: 'a', agent: aa, bot: bb, issue: ib, workspace: wb, team: tb, project: pb, direct: true, status: 'paused' },
    { owner: 'a', agent: ab, bot: bb, issue: ic, workspace: wa, team: ta, project: pb, direct: true, status: 'running' },
    { owner: 'b', agent: aa, bot: ba, issue: ia, workspace: wa, team: ta, project: pa, direct: true, status: 'running' },
    { owner: 'a', agent: aa, bot: ba, issue: ia, workspace: wa, team: ta, project: pa, direct: false, status: 'running' },
    { owner: 'a', agent: aa, bot: ba, issue: ia, workspace: wa, team: ta, project: pa, direct: true, status: 'completed' },
  ].map(row => ({ ...row, id: randomUUID() }))
  for (const row of rows) await database.query(`INSERT INTO agent_runs VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,now()+interval '5 minutes',now(),$9,$10)`,
    [row.id, row.owner, row.agent, row.bot, row.issue, device, row.direct, row.status, { workspaceId: row.workspace, teamId: row.team, projectId: row.project }, row.workspace])
  const cases: [RunPolicyStopScope, number[]][] = [
    [{ kind: 'worker', ownerId: 'a', agentId: aa }, [0, 1]],
    [{ kind: 'agent', ownerId: 'a', botId: ba }, [0]],
    [{ kind: 'workspace', workspaceId: wa }, [0, 2, 3]],
    [{ kind: 'workspace', workspaceId: wa, ownerId: 'a' }, [0, 2]],
    [{ kind: 'team', scopeId: ta }, [0, 2, 3]],
    [{ kind: 'team', scopeId: ta, ownerId: 'a' }, [0, 2]],
    [{ kind: 'project', scopeId: pa }, [0, 3]],
    [{ kind: 'task', issueId: ia }, [0, 3]],
    [{ kind: 'tasks', issueIds: [ib, ic] }, [1, 2]],
    [{ kind: 'tasks', issueIds: [] }, []],
  ]
  for (const [scope, expected] of cases) {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const compiled = new PgDialect().sqlToQuery(runPolicyStopSQL(scope))
      const stopped = await client.query(compiled.sql, compiled.params)
      assert.deepEqual(stopped.rows.filter(row => row.stopped).map(row => row.id).sort(), expected.map(index => rows[index]!.id).sort(), scope.kind)
      const state = await client.query('SELECT id,"stopRequestedAt" IS NOT NULL AS stopped,"leaseExpiresAt"<=clock_timestamp() AS expired FROM agent_runs ORDER BY id')
      assert.deepEqual(state.rows.filter(row => row.stopped).map(row => row.id), expected.map(index => rows[index]!.id).sort())
      assert.ok(state.rows.filter(row => row.stopped).every(row => row.expired))
      assert.equal(state.rows.find(row => row.id === rows[4]!.id).stopped, false, 'legacy daemons keep their existing control contract')
    } finally { await client.query('ROLLBACK'); client.release() }
    assert.equal((await database.query('SELECT count(*)::int AS count FROM agent_runs WHERE "stopRequestedAt" IS NOT NULL')).rows[0].count, 0, 'a rolled-back policy mutation cannot stop a machine')
  }
})
