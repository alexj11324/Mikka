// Real PostgreSQL regression coverage for the claim and use-time Secret checks
// (decision 2026-11-17-2215: no renewal; every use re-reads the live run).
// No provider calls, real credentials, HTTP proxy or test authentication bypasses.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { DeviceCaller } from '../lib/device-link'
import type { SecretHttpPolicy } from '../lib/secrets/delivery'
import type { ProjectExecutionSnapshot } from '../lib/project-resources/contracts'
import { dbUrl, seedAgent, seedIssue, seedPersonalWorkspace, seedProjectTasks, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('protected task Secret claims and use-time checks against PostgreSQL', { skip: !dbUrl }, async t => {
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const env = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const store = await import('../lib/secrets/store')
  const personal = await import('../lib/secrets/user-store')
  const runtime = await import('../lib/secrets/runtime')
  const { freezeWorkerDefinition } = await import('../lib/agent-kit/worker')
  const { freezeExecutionIdentity } = await import('../lib/execution-identity')
  const { sealSecret, userE2bKeyAad } = await import('../lib/secrets/crypto')
  const { hashDeviceToken } = await import('../lib/device-link')
  const { issueEgressCapability, openEgressCapability } = await import('../lib/secrets/egress-capability')
  const { egressBindingActive } = await import('../lib/secrets/egress-binding')
  const { authorizedClaimResponse } = await import('../lib/run-claim-response')
  const { CodedError } = await import('@mikka/protocol/coded-error')
  t.after(async () => {
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY
    else process.env.WORKSPACE_SECRETS_KEY = previousKey
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const http: SecretHttpPolicy = { origin: 'https://api.example.com', header: 'authorization', prefix: 'Bearer ', rules: [{ method: 'GET', path: '/v1/items', match: 'exact' }] }

  const fixture = async (options: { kind?: 'local' | 'cloud'; status?: string; personalScope?: boolean; legacy?: boolean; environment?: boolean; personalOverride?: boolean } = {}) => {
    const owner = await seedUser(pool, 'secret-access')
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const kind = options.kind ?? 'local', workspaceId = options.personalScope ? await seedPersonalWorkspace(pool, owner) : ws.id
    const now = new Date(), lease = new Date(now.getTime() + 120_000)
    const deviceId = randomUUID(), tokenId = randomUUID(), runId = randomUUID(), repoId = randomUUID()
    const agentId = await seedAgent(pool, owner), issueId = await seedIssue(pool, owner, workspaceId)
    const name = 'PROTECTED_TOKEN', value = 'synthetic-canary-' + randomBytes(24).toString('hex')
    const saved = options.personalScope
      ? await personal.createUserSecret(owner, { name, kind: 'secret', value, delivery: { mode: 'protected', http } }, {})
      : await store.createWorkspaceSecret(owner, ws.id, { name, kind: 'secret', value, delivery: { mode: 'protected', http } })
    await pool.query('insert into devices (id,"ownerId",name,kind,"sessionOpenedAt") values ($1,$2,$3,$4,now())', [deviceId, owner, 'secret-access-device', kind])
    await pool.query('insert into device_tokens (id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") values ($1,$2,$3,$4,$5,$6)', [tokenId, owner, hashDeviceToken('dt_' + randomBytes(24).toString('hex')), kind === 'cloud' ? deviceId : null, kind === 'cloud' ? workspaceId : null, lease])
    const repositoryKey = 'v2/github.com/acme/secret-fixture'
    await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl") values ($1,$2,$3,$4,$5)', [repoId, deviceId, owner, options.environment ? repositoryKey : `/tmp/${repoId}`, 'https://github.com/acme/secret-fixture.git'])
    let subscription: { id: string; modelId: string; route: string } | undefined
    if (kind === 'cloud') {
      // Cloud execution identities require their real model/runtime authority
      // rows. These synthetic fixtures never open a provider connection.
      const connection = randomUUID(), binding = randomUUID()
      await pool.query('insert into byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") values ($1,$2,$3,\'codex\',\'connected\',1,$4,$5,\'synthetic-subject\')', [connection, owner, workspaceId, `synthetic-${connection}`, 'a'.repeat(64)])
      await pool.query('insert into byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") values ($1,$2,$3,$4,$5,1,\'codex_cli\',\'gpt-6-luna\')', [binding, owner, workspaceId, agentId, connection])
      const e2b = sealSecret('synthetic-e2b-fixture', userE2bKeyAad(owner), env)
      await pool.query('insert into user_e2b_keys ("userId",ciphertext,iv,"keyVersion",last4) values ($1,$2,$3,$4,\'test\')', [owner, e2b.ciphertext, e2b.iv, e2b.keyVersion])
      subscription = { id: binding, modelId: 'gpt-6-luna', route: 'codex_cli' }
    }
    let projectExecution: ProjectExecutionSnapshot | undefined
    let shadow: Awaited<ReturnType<typeof store.createWorkspaceSecret>> | undefined
    let override: Awaited<ReturnType<typeof personal.createUserSecret>> | undefined
    if (options.environment) {
      assert.equal(workspaceId, ws.id)
      const resources = await import('../lib/project-resources/store')
      shadow = await store.createWorkspaceSecret(owner, ws.id, { name, kind: 'secret', value: 'unselected-repository-' + randomBytes(16).toString('hex'),
        scope: { type: 'repository', repository: 'acme/secret-fixture' }, delivery: { mode: 'protected', http } })
      if (options.personalOverride) override = await personal.createUserSecret(owner, { name, kind: 'secret', value,
        delivery: { mode: 'protected', http }, overrideWorkspace: true }, { workspaceId: ws.id })
      const environment = await resources.saveEnvironment(owner, { workspaceId: ws.id, name: 'Secret access Environment',
        configuration: { runtime: kind, harness: 'codex', variables: { REGION: 'selected-environment' }, secretIds: [saved.id], repositoryKeys: [repositoryKey] } })
      const projectId = randomUUID()
      await pool.query(`insert into workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
        values($1,$2,$3,'Secret access Project','','','planned','none','','','','','[]',1)`, [projectId, owner, ws.id])
      await (await import('../lib/resource-access/projects')).registerProjectAccess(owner, projectId, ws.id)
      await seedProjectTasks(pool, projectId, [issueId])
      await resources.saveProjectResources(owner, { workspaceId: ws.id, projectId, revision: 1,
        repositories: [{ repositoryKey, baseBranch: null, environmentId: environment.id, isPrimary: true }], environmentIds: [environment.id], defaultEnvironmentId: environment.id })
      projectExecution = await resources.withProjectExecution({ userId: owner, workspaceId: ws.id, issueId, repositoryKey, baseBranch: null, runtime: kind, harness: 'codex' }, async snapshot => snapshot)
      assert.deepEqual(projectExecution.environment?.secretIds, [saved.id])
    }
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'Synthetic secret fixture', parent: null, executionId: null, subscription })
    if (projectExecution) definition.projectExecution = projectExecution
    if (!options.legacy) definition.executionIdentity = await freezeExecutionIdentity(pool, { userId: owner, botId: null, deviceId, agentDefinition: definition }, pool, workspaceId)
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",status,"leaseExpiresAt",attempt,"workspaceId") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)', [runId, owner, issueId, agentId, deviceId, repoId, tokenId, definition, options.status ?? 'running', lease, workspaceId])
    const caller: DeviceCaller = { userId: owner, tokenId, ...(kind === 'cloud' ? { scopeDeviceId: deviceId, scopeWorkspaceId: workspaceId } : {}) }
    const injection = projectExecution?.environment
      ? await runtime.environmentSecretInjection(ws.id, 'acme/secret-fixture', projectExecution.environment, env, owner)
      : await runtime.taskSecretInjection(workspaceId, 'acme/secret-fixture', env, undefined, owner)
    const secret = injection.protectedSecrets.find(item => item.id === (override?.id ?? saved.id))
    assert.ok(secret?.revision)
    assert.match(injection.snapshot!, /^[a-f0-9]{64}$/)
    const binding = { ownerId: owner, workspaceId, repository: 'acme/secret-fixture', runId, deviceId, deviceTokenId: tokenId, attempt: 1 }
    const grantInput = { ...binding, name, secretId: secret.id!, revision: secret.revision, secret: value, http, leaseExpiresAt: lease }
    const grant = issueEgressCapability(grantInput, now.getTime(), env)
    /** What the egress route does at every use: open the bearer, then read the live run. */
    const use = (capability = grant.capability) => egressBindingActive(openEgressCapability(capability, { runId }, now.getTime() + 5, env))
    const activeAgain = () => pool.query('update agent_runs set status=\'running\',"stopRequestedAt"=null,"leaseExpiresAt"=$2 where id=$1', [runId, lease])
    return { owner, ws, workspaceId, now, lease, deviceId, tokenId, runId, repoId, agentId, issueId, saved, name, value, caller, injection, binding, grantInput, grant, use, activeAgain, projectExecution, shadow }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const grantWith = (f: Fixture, changes: Partial<typeof f.grantInput>) => issueEgressCapability({ ...f.grantInput, ...changes }, f.now.getTime(), env).capability

  await t.test('the capability expires with the run lease and its bound run is accepted while it holds the lease and session', async () => {
    const f = await fixture()
    assert.equal(f.grant.expiresAt, f.lease.toISOString(), 'no 90-second bound: the lease is the expiry')
    assert.equal(await f.use(), true)
    const claims = openEgressCapability(f.grant.capability, f.binding, f.now.getTime() + 5, env)
    assert.equal(claims.secret, f.value)
    assert.equal(claims.secretId, f.saved.id)
  })

  await t.test('another owner, workspace, device, credential or attempt is refused at use', async () => {
    const f = await fixture()
    for (const changes of [{ ownerId: 'someone-else' }, { workspaceId: randomUUID() }, { deviceId: randomUUID() }, { deviceTokenId: randomUUID() }, { attempt: 2 }])
      assert.equal(await f.use(grantWith(f, changes)), false, JSON.stringify(changes))
  })

  await t.test('a stopped, ended or lease-less run, or an ended lease, is refused at its next use', async () => {
    const f = await fixture()
    for (const change of [`"stopRequestedAt"=now()`, `status='succeeded'`, `status='queued'`, `"leaseExpiresAt"=now()`, `"leaseExpiresAt"=NULL`]) {
      await pool.query(`update agent_runs set ${change} where id=$1`, [f.runId])
      assert.equal(await f.use(), false, change)
      await f.activeAgain()
      assert.equal(await f.use(), true)
    }
  })

  await t.test('a closed device session, a disabled or removed device, and a revoked credential are refused at use', async () => {
    const f = await fixture()
    const { applyDeviceSessionReport } = await import('../lib/device-session')
    assert.equal((await applyDeviceSessionReport(f.deviceId, { state: 'connected', at: new Date().toISOString(), socketId: 'socket-access01' })).applied, true)
    assert.equal(await f.use(), true)
    assert.equal((await applyDeviceSessionReport(f.deviceId, { state: 'disconnected', at: new Date().toISOString(), socketId: 'socket-access01' })).applied, true)
    assert.equal(await f.use(), false, 'the disconnect ended the lease and the session')
    await f.activeAgain()
    assert.equal(await f.use(), false, 'even with a lease, a closed session refuses')
    await pool.query('update devices set "sessionOpenedAt"=clock_timestamp(),"sessionClosedAt"=NULL where id=$1', [f.deviceId])
    assert.equal(await f.use(), true)
    for (const [change, restore] of [['enabled=false', 'enabled=true'], ['"removedAt"=now()', '"removedAt"=NULL']]) {
      await pool.query(`update devices set ${change} where id=$1`, [f.deviceId])
      assert.equal(await f.use(), false, change)
      await pool.query(`update devices set ${restore} where id=$1`, [f.deviceId])
    }
    await pool.query('update device_tokens set "revokedAt"=now() where id=$1', [f.tokenId])
    assert.equal(await f.use(), false, 'revoked claim credential')
  })

  await t.test('rotating or deleting the Secret stops its consumers, so the old capability is refused at use', async () => {
    for (const mutation of ['rotation', 'deletion'] as const) {
      const f = await fixture()
      assert.equal(await f.use(), true)
      if (mutation === 'rotation') await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, value: f.value + '-rotated' })
      else await store.deleteWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id })
      assert.equal(await f.use(), false, mutation)
    }
  })

  await t.test('Environment claim fences the frozen selection and current references under the final run lock', async () => {
    const claim = (f: Fixture, snapshot: string, respond: () => Response) => authorizedClaimResponse(f.owner,
      { id: f.runId, issueId: f.issueId, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId }, f.lease.toISOString(), respond,
      async (current, tx) => {
        const configuration = current.agentDefinition?.projectExecution?.environment
        assert.ok(current.workspaceId && configuration)
        try { return await runtime.environmentSecretSnapshot(current.workspaceId, f.binding.repository, configuration, f.owner, tx) === snapshot }
        catch (error) {
          if (error instanceof CodedError && error.code === 'task_secret_unavailable') return false
          throw error
        }
      })
    for (const mutation of ['rotation', 'deletion', 'delivery', 'scope', 'selection', 'missing_under_override'] as const) {
      const f = await fixture({ status: 'queued', environment: true, personalOverride: mutation === 'missing_under_override' })
      assert.ok(f.injection.snapshot)
      if (mutation === 'rotation') await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, value: f.value + '-rotated' })
      if (mutation === 'deletion' || mutation === 'missing_under_override') await store.deleteWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id })
      if (mutation === 'delivery') await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, delivery: { mode: 'direct', exposeToAgent: true } })
      if (mutation === 'scope') await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, value: f.value, scope: { type: 'repository', repository: 'acme/other' } })
      if (mutation === 'selection') await pool.query(`update agent_runs set "agentDefinition"=jsonb_set("agentDefinition",'{projectExecution,environment,secretIds}','[]') where id=$1`, [f.runId])
      const { rows: [row] } = await pool.query('update agent_runs set status=\'preparing\' where id=$1 returning "stopRequestedAt"', [f.runId])
      assert.equal(row.stopRequestedAt, null, 'queued preparation has no issued Environment grant to revoke')
      let responses = 0
      const result = await claim(f, f.injection.snapshot, () => { responses++; return Response.json({ grant: f.grant }) })
      assert.equal(result, null, mutation)
      assert.equal(responses, 0, 'no token, grant or prepared Secret leaves a refused response')
      const { rows: [effects] } = await pool.query(`select
        (select count(*)::int from run_tokens where "runId"=$1) as tokens,
        (select count(*)::int from coordinator_events where "runId"=$1) as events`, [f.runId])
      assert.deepEqual(effects, { tokens: 0, events: 0 })
    }
    const f = await fixture({ status: 'preparing', environment: true })
    assert.ok(f.injection.snapshot && f.shadow)
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, note: 'safe Environment metadata edit' })
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.shadow.id, value: 'unselected-claim-change' })
    const result = await claim(f, f.injection.snapshot, () => Response.json({ grant: f.grant }))
    assert.equal(result?.status, 200, 'notes and unselected same-name repository changes preserve a valid Environment claim')
    const body = await result!.json()
    assert.equal(openEgressCapability(body.grant.capability, f.binding, f.now.getTime() + 5, env).secretId, f.saved.id)
    assert.ok(!JSON.stringify(body).includes(f.value))
  })

  await t.test('claim response checks the prepared effective snapshot under its final run lock', async () => {
    for (const mutation of ['rotation', 'deletion', 'personal_override', 'delivery'] as const) {
      const f = await fixture({ status: 'queued' })
      const prepared = f.injection.snapshot
      if (mutation === 'rotation') await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, value: f.value + '-rotated' })
      if (mutation === 'deletion') await store.deleteWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id })
      if (mutation === 'personal_override') await personal.createUserSecret(f.owner, { name: f.name, kind: 'secret', value: f.value, overrideWorkspace: true }, { workspaceId: f.ws.id })
      if (mutation === 'delivery') await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, delivery: { mode: 'direct', exposeToAgent: true } })
      const { rows: [row] } = await pool.query('update agent_runs set status=\'preparing\' where id=$1 returning "stopRequestedAt"', [f.runId])
      assert.equal(row.stopRequestedAt, null, 'queued preparation has no admitted grant to stop')
      let responses = 0
      const result = await authorizedClaimResponse(f.owner, { id: f.runId, issueId: f.issueId, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId }, f.lease.toISOString(), () => {
        responses++
        return Response.json({ grant: f.grant })
      }, async (_run, tx) => await runtime.taskSecretSnapshot(f.workspaceId, f.binding.repository, f.owner, tx) === prepared)
      assert.equal(result, null, mutation)
      assert.equal(responses, 0, 'no prepared credentials leave a refused claim')
    }
    const f = await fixture({ status: 'preparing' })
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, note: 'safe metadata edit' })
    const result = await authorizedClaimResponse(f.owner, { id: f.runId, issueId: f.issueId, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId }, f.lease.toISOString(), () => Response.json({ grant: f.grant }),
      async (_run, tx) => await runtime.taskSecretSnapshot(f.workspaceId, f.binding.repository, f.owner, tx) === f.injection.snapshot)
    assert.equal(result?.status, 200, 'an unchanged security snapshot may finish the claim')
    assert.ok(!(await result!.text()).includes(f.value))
  })
})
