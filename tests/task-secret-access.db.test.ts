// Real PostgreSQL regression coverage for the claim/heartbeat control plane.
// No provider calls, real credentials, HTTP proxy or test authentication bypasses.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { PoolClient } from 'pg'
import type { DeviceCaller } from '../lib/device-link'
import type { SecretHttpPolicy } from '../lib/secrets/delivery'
import { dbUrl, seedAgent, seedIssue, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('protected task Secret claims and renewals against PostgreSQL', { skip: !dbUrl }, async t => {
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
  const { renewTaskSecretAccess } = await import('../lib/secrets/task-renewal')
  const { authorizedClaimResponse } = await import('../lib/run-claim-response')
  t.after(async () => {
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY
    else process.env.WORKSPACE_SECRETS_KEY = previousKey
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const http: SecretHttpPolicy = { origin: 'https://api.example.com', header: 'authorization', prefix: 'Bearer ', rules: [{ method: 'GET', path: '/v1/items', match: 'exact' }] }
  const endpoint = (runId: string) => `https://mikka.example/v1/runs/${runId}/secret-egress`

  const fixture = async (options: { kind?: 'local' | 'cloud'; status?: string; personalScope?: boolean; legacy?: boolean } = {}) => {
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
    await pool.query('insert into devices (id,"ownerId",name,kind) values ($1,$2,$3,$4)', [deviceId, owner, 'secret-access-device', kind])
    await pool.query('insert into device_tokens (id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") values ($1,$2,$3,$4,$5,$6)', [tokenId, owner, hashDeviceToken('dt_' + randomBytes(24).toString('hex')), kind === 'cloud' ? deviceId : null, kind === 'cloud' ? workspaceId : null, lease])
    await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl") values ($1,$2,$3,$4,$5)', [repoId, deviceId, owner, `/tmp/${repoId}`, 'https://github.com/acme/secret-fixture.git'])
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
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'Synthetic secret fixture', parent: null, executionId: null, subscription })
    if (!options.legacy) definition.executionIdentity = await freezeExecutionIdentity(pool, { userId: owner, botId: null, deviceId, agentDefinition: definition }, pool, workspaceId)
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",status,"leaseExpiresAt",attempt,"workspaceId") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)', [runId, owner, issueId, agentId, deviceId, repoId, tokenId, definition, options.status ?? 'running', lease, workspaceId])
    await pool.query('update resource_access_policies set visibility=\'private\' where kind=\'thread\' and id=$1', [runId])
    const caller: DeviceCaller = { userId: owner, tokenId, ...(kind === 'cloud' ? { scopeDeviceId: deviceId, scopeWorkspaceId: workspaceId } : {}) }
    const injection = await runtime.taskSecretInjection(workspaceId, 'acme/secret-fixture', env, undefined, owner, { runId })
    const secret = injection.protectedSecrets.find(item => item.id === saved.id)
    assert.ok(secret?.revision)
    assert.match(injection.snapshot!, /^[a-f0-9]{64}$/)
    const binding = { ownerId: owner, workspaceId, repository: 'acme/secret-fixture', runId, deviceId, deviceTokenId: tokenId, attempt: 1 }
    const grantInput = { ...binding, name, secretId: saved.id, revision: secret.revision, secret: value, http, leaseExpiresAt: lease }
    const grant = issueEgressCapability(grantInput, now.getTime(), env)
    const input = { caller, deviceId, runs: [{ runId, secretCapabilities: [grant.capability] }], leases: { [runId]: lease.toISOString() }, endpoint }
    const renew = (overrides: Partial<Parameters<typeof renewTaskSecretAccess>[0]> = {}, at = new Date(now.getTime() + 5),
      clock: () => number = () => at.getTime()) => renewTaskSecretAccess({ ...input, ...overrides }, at, env, clock)
    const report = (capability: string) => [{ runId, secretCapabilities: [capability] }]
    const activeAgain = () => pool.query('update agent_runs set status=\'running\',"stopRequestedAt"=null,"leaseExpiresAt"=$2 where id=$1', [runId, lease])
    return { owner, ws, workspaceId, now, lease, deviceId, tokenId, runId, repoId, agentId, issueId, saved, name, value, caller, injection, binding, grantInput, grant, input, renew, report, activeAgain }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const denied = async (f: Fixture, overrides: Partial<Parameters<typeof renewTaskSecretAccess>[0]> = {}, at?: Date) => {
    const result = await f.renew(overrides, at)
    assert.deepEqual(result, { taskSecrets: {}, revoked: [f.runId] })
  }

  await t.test('the original owner/device/attempt/scope receives an opaque renewed grant; note edits preserve its security revision', async () => {
    const f = await fixture()
    assert.deepEqual(f.injection.env, {})
    const before = await runtime.taskSecretSnapshot(f.workspaceId, f.binding.repository, f.owner, undefined, { runId: f.runId })
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, note: 'description changed' })
    assert.equal(await runtime.taskSecretSnapshot(f.workspaceId, f.binding.repository, f.owner, undefined, { runId: f.runId }), before)
    const renewed = await f.renew()
    assert.deepEqual(renewed.revoked, [])
    const access = renewed.taskSecrets[f.runId]
    assert.equal(access.endpoint, endpoint(f.runId))
    assert.deepEqual(access.unavailable, [])
    assert.equal(access.grants.length, 1)
    const claims = openEgressCapability(access.grants[0].capability, f.binding, f.now.getTime() + 5, env)
    assert.equal(claims.secret, f.value)
    assert.equal(claims.secretId, f.saved.id)
    assert.equal(claims.revision, f.grantInput.revision)
    assert.ok(!JSON.stringify(renewed).includes(f.value))
    assert.ok(!JSON.stringify(renewed).includes(f.value.slice(0, 16)))
  })

  await t.test('Task deletion serializes with Secret renewal and cannot be followed by a stale new capability', async () => {
    const f = await fixture()
    const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
    const { rows: [task] } = await pool.query('select content from issues where id=$1', [f.issueId])
    const deletedContent = withIssueMetadata(task.content, { ...readIssueMetadata(task.content), deletedAt: new Date().toISOString() })
    const state = async () => (await pool.query('select "workspaceId","issueId",status,attempt,"leaseExpiresAt","stopRequestedAt" from agent_runs where id=$1', [f.runId])).rows[0]
    const before = await state()
    const writer = await pool.connect()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const originals = new Map<PoolClient, PoolClient['query']>()
    let intercepted = 0
    let pending: ReturnType<typeof f.renew> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    // Run every query against PostgreSQL. Pause only this fixture's real
    // execution-identity read, after renewal has obtained its authority rows.
    const observe = (client: PoolClient) => {
      if (originals.has(client)) return
      const query = client.query
      originals.set(client, query)
      client.query = ((...args: unknown[]) => {
        const result = Reflect.apply(query, client, args)
        if (args[0] !== 'SELECT "ownerId",kind,enabled FROM devices WHERE id=$1'
          || !Array.isArray(args[1]) || args[1][0] !== f.deviceId) return result
        intercepted++
        return Promise.resolve(result).then(async value => {
          entered.resolve()
          await release.promise
          return value
        })
      }) as PoolClient['query']
    }
    appPool.on('acquire', observe)
    try {
      pending = f.renew({}, new Date(f.now.getTime() + 5), Date.now)
      await Promise.race([entered.promise, pending.then(() => {
        throw new Error('Renewal ended before the real device authorization query')
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Renewal did not reach the real device authorization query')), 5_000)
      })])
      if (timer) { clearTimeout(timer); timer = undefined }
      assert.equal(intercepted, 1)
      await writer.query('begin')
      await writer.query("set local lock_timeout='1s'")
      let deletionCommitted = false
      try {
        // Match setIssueDeleted's Task-first lock and metadata update. The
        // old Run-only renewal lets this commit while its Task snapshot is stale.
        await writer.query('select id from issues where id=$1 for update', [f.issueId])
        await writer.query('update issues set content=$2,revision=revision+1,"updatedAt"=now() where id=$1', [f.issueId, deletedContent])
        await writer.query('commit')
        deletionCommitted = true
      } catch (error) {
        await writer.query('rollback')
        assert.equal((error as { code?: string }).code, '55P03', 'only a real PostgreSQL Task lock may defer deletion')
      }
      release.resolve()
      const renewed = await pending
      if (deletionCommitted) {
        assert.deepEqual(renewed, { taskSecrets: {}, revoked: [f.runId] },
          'Task deletion committed before issuance; renewal must not return a new capability from its old Task snapshot')
      } else {
        assert.deepEqual(renewed.revoked, [])
        const grants = renewed.taskSecrets[f.runId].grants
        assert.equal(grants.length, 1)
        const claims = openEgressCapability(grants[0].capability, f.binding, Date.now(), env)
        assert.equal(claims.secretId, f.saved.id)
        assert.equal(claims.revision, f.grantInput.revision)
        assert.equal(claims.secret, f.value)
        assert.ok(!JSON.stringify(renewed).includes(f.value))
        // Once renewal commits, the same ordinary deletion succeeds. Every
        // subsequent renewal must observe that committed tombstone.
        await writer.query('begin')
        await writer.query("set local lock_timeout='1s'")
        await writer.query('select id from issues where id=$1 for update', [f.issueId])
        await writer.query('update issues set content=$2,revision=revision+1,"updatedAt"=now() where id=$1', [f.issueId, deletedContent])
        await writer.query('commit')
      }
      await denied(f)
      assert.deepEqual(await state(), before, 'refused Secret renewal cannot mutate the existing Run or its lease')
    } finally {
      if (timer) clearTimeout(timer)
      release.resolve()
      await writer.query('rollback')
      writer.release()
      await pending?.catch(() => undefined)
      appPool.off('acquire', observe)
      for (const [client, query] of originals) client.query = query
    }
  })

  await t.test('cross-owner, device, workspace, repository, token and attempt claims are rejected', async () => {
    const f = await fixture()
    await denied(f, { caller: { ...f.caller, userId: 'another-owner' } })
    await denied(f, { deviceId: randomUUID() })
    await denied(f, { caller: { ...f.caller, tokenId: randomUUID() } })
    for (const mismatch of [{ ownerId: 'another-owner' }, { workspaceId: randomUUID() }, { repository: 'acme/other' },
      { deviceId: randomUUID() }, { deviceTokenId: randomUUID() }, { attempt: 2 }]) {
      const forgedScope = issueEgressCapability({ ...f.grantInput, ...mismatch }, f.now.getTime(), env)
      await denied(f, { runs: f.report(forgedScope.capability) })
    }
    await pool.query('update agent_runs set attempt=2 where id=$1', [f.runId])
    await denied(f)
  })

  await t.test('wrong or stale run lease, stopped/completed runs, and expired bearers cannot renew', async () => {
    const f = await fixture()
    await denied(f, { leases: {} })
    await denied(f, { leases: { [f.runId]: new Date(f.lease.getTime() + 1).toISOString() } })
    await denied(f, {}, new Date(f.now.getTime() + 90_000))
    await pool.query('update agent_runs set "stopRequestedAt"=now() where id=$1', [f.runId])
    await denied(f)
    await f.activeAgain()
    await pool.query('update agent_runs set status=\'succeeded\' where id=$1', [f.runId])
    await denied(f)
    await f.activeAgain()
    const expired = new Date(f.now.getTime() - 1)
    await pool.query('update agent_runs set "leaseExpiresAt"=$2 where id=$1', [f.runId, expired])
    await denied(f, { leases: { [f.runId]: expired.toISOString() } })
  })

  await t.test('the post-await clock refuses a bearer, current token or run lease that expires after the SQL snapshot', async () => {
    const bearer = await fixture()
    assert.deepEqual(await bearer.renew({}, new Date(bearer.now.getTime() + 5), () => bearer.now.getTime() + 90_000),
      { taskSecrets: {}, revoked: [bearer.runId] })

    const credential = await fixture()
    const tokenExpires = credential.now.getTime() + 1_000
    await pool.query('update device_tokens set "expiresAt"=$2 where id=$1', [credential.tokenId, new Date(tokenExpires)])
    assert.deepEqual(await credential.renew({}, new Date(credential.now.getTime() + 5), () => tokenExpires),
      { taskSecrets: {}, revoked: [credential.runId] })

    const lease = await fixture()
    const leaseExpires = new Date(lease.now.getTime() + 1_000)
    await pool.query('update agent_runs set "leaseExpiresAt"=$2 where id=$1', [lease.runId, leaseExpires])
    assert.deepEqual(await lease.renew({ leases: { [lease.runId]: leaseExpires.toISOString() } }, new Date(lease.now.getTime() + 5), () => leaseExpires.getTime()),
      { taskSecrets: {}, revoked: [lease.runId] })

    const live = await fixture()
    const issuedAt = live.now.getTime() + 1_000
    const renewed = await live.renew({}, new Date(live.now.getTime() + 5), () => issuedAt)
    assert.deepEqual(renewed.revoked, [])
    const claims = openEgressCapability(renewed.taskSecrets[live.runId].grants[0].capability, live.binding, issuedAt, env)
    assert.equal(claims.issuedAt, issuedAt, 'new grants start at the fresh clock after authorization reads')
    assert.equal(claims.expiresAt, Math.min(live.lease.getTime(), issuedAt + 90_000))
  })

  await t.test('human pauses retain only the current live lease; a quota pause without a lease cannot renew', async () => {
    const f = await fixture({ status: 'waiting_input' })
    assert.deepEqual((await f.renew()).revoked, [])
    await pool.query('update agent_runs set status=\'paused\',"pauseReason"=\'human_control\' where id=$1', [f.runId])
    assert.deepEqual((await f.renew()).revoked, [])
    await pool.query('update agent_runs set "pauseReason"=\'quota_exhausted\',"leaseExpiresAt"=null where id=$1', [f.runId])
    await denied(f)
  })

  await t.test('disabled/removed devices and revoked or expired current local tokens cannot renew', async () => {
    const f = await fixture()
    await pool.query('update devices set enabled=false where id=$1', [f.deviceId])
    await denied(f)
    await pool.query('update devices set enabled=true,"removedAt"=now() where id=$1', [f.deviceId])
    await denied(f)
    await pool.query('update devices set "removedAt"=null where id=$1', [f.deviceId])
    await pool.query('update device_tokens set "revokedAt"=now() where id=$1', [f.tokenId])
    await denied(f)
    await pool.query('update device_tokens set "revokedAt"=null,"expiresAt"=$2 where id=$1', [f.tokenId, new Date(f.now.getTime() - 1)])
    await denied(f)
  })

  await t.test('metadata id/revision checks reject rotation, deletion, recreation and policy withdrawal even before a stop is observed', async () => {
    const f = await fixture()
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, value: f.value + '-rotated' })
    await f.activeAgain() // Simulate a stale in-flight control response; metadata must independently fail closed.
    await denied(f)
    await store.deleteWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id })
    await f.activeAgain()
    await denied(f)
    const replacement = await store.createWorkspaceSecret(f.owner, f.ws.id, { name: f.name, kind: 'secret', value: f.value, delivery: { mode: 'protected', http } })
    assert.notEqual(replacement.id, f.saved.id)
    await f.activeAgain()
    await denied(f)
    const current = (await runtime.taskSecretMetadata(f.workspaceId, f.binding.repository, f.owner)).find(row => row.name === f.name)!
    const currentGrant = issueEgressCapability({ ...f.grantInput, secretId: current.id, revision: current.revision }, f.now.getTime(), env)
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: replacement.id, delivery: { mode: 'direct', exposeToAgent: true } })
    await f.activeAgain()
    await denied(f, { runs: f.report(currentGrant.capability) })
  })

  await t.test('missing metadata provenance, duplicate grants and personal overrides never repair an old capability', async () => {
    const f = await fixture()
    for (const missing of [{ secretId: undefined }, { revision: undefined }]) {
      const grant = issueEgressCapability({ ...f.grantInput, ...missing }, f.now.getTime(), env)
      await denied(f, { runs: f.report(grant.capability) })
    }
    await denied(f, { runs: [{ runId: f.runId, secretCapabilities: [f.grant.capability, f.grant.capability] }] })
    await personal.createUserSecret(f.owner, { name: f.name, kind: 'secret', value: f.value, delivery: { mode: 'protected', http }, overrideWorkspace: true }, { workspaceId: f.ws.id })
    await f.activeAgain()
    await denied(f)
  })

  await t.test('a repository change and a retry cannot reuse a previous grant', async () => {
    const f = await fixture()
    await pool.query('update device_repos set "remoteUrl"=$2 where id=$1', [f.repoId, 'git@github.com:acme/other.git'])
    await denied(f)
    await pool.query('update device_repos set "remoteUrl"=$2 where id=$1', [f.repoId, 'https://github.com/acme/secret-fixture.git'])
    const retryId = randomUUID()
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",status,"leaseExpiresAt",attempt,"retryOf") select $2,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",status,"leaseExpiresAt",2,id from agent_runs where id=$1', [f.runId, retryId])
    const result = await f.renew({ runs: [{ runId: retryId, secretCapabilities: [f.grant.capability] }], leases: { [retryId]: f.lease.toISOString() } })
    assert.deepEqual(result, { taskSecrets: {}, revoked: [retryId] })
  })

  await t.test('cloud token rotation retains original claim lineage; expiration differs from revocation and wrong successor scope fails', async () => {
    const f = await fixture({ kind: 'cloud' })
    const successor = randomUUID()
    await pool.query('insert into device_tokens (id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") values ($1,$2,$3,$4,$5,$6)', [successor, f.owner, hashDeviceToken('dt_' + randomBytes(24).toString('hex')), f.deviceId, f.ws.id, f.lease])
    const caller = { ...f.caller, tokenId: successor }
    await pool.query('update device_tokens set "expiresAt"=$2 where id=$1', [f.tokenId, new Date(f.now.getTime() - 1)])
    const renewed = await f.renew({ caller })
    assert.deepEqual(renewed.revoked, [])
    assert.equal(openEgressCapability(renewed.taskSecrets[f.runId].grants[0].capability, f.binding, f.now.getTime() + 5, env).deviceTokenId, f.tokenId)
    await denied(f, { caller: { ...caller, scopeWorkspaceId: randomUUID() } })
    await pool.query('update device_tokens set "boundWorkspaceId"=$2 where id=$1', [successor, randomUUID()])
    await denied(f, { caller })
    await pool.query('update device_tokens set "boundWorkspaceId"=$2 where id=$1', [successor, f.ws.id])
    await pool.query('update device_tokens set "revokedAt"=now() where id=$1', [f.tokenId])
    await denied(f, { caller })
  })

  await t.test('ordinary Personal runs keep their real tenant on local and cloud renewal', async () => {
    for (const kind of ['local', 'cloud'] as const) {
      const personalRun = await fixture({ kind, personalScope: true })
      assert.notEqual(personalRun.workspaceId, personalRun.ws.id)
      assert.equal((await pool.query('select kind from mikka_workspaces where id=$1', [personalRun.workspaceId])).rows[0].kind, 'personal')
      assert.equal(await runtime.runWorkspaceId(personalRun.runId), personalRun.workspaceId)
      const renewed = await personalRun.renew()
      assert.deepEqual(renewed.revoked, [])
      assert.equal(openEgressCapability(renewed.taskSecrets[personalRun.runId].grants[0].capability, personalRun.binding, personalRun.now.getTime() + 5, env).workspaceId, personalRun.workspaceId)
      const wrong = issueEgressCapability({ ...personalRun.grantInput, workspaceId: personalRun.ws.id }, personalRun.now.getTime(), env)
      await denied(personalRun, { runs: personalRun.report(wrong.capability) })
    }
  })

  await t.test('a claim token cannot reattribute a legacy bound run and frozen null is refused', async () => {
    const legacy = await fixture({ kind: 'cloud', legacy: true })
    assert.deepEqual((await legacy.renew()).revoked, [])
    const other = await seedWorkspace(pool, legacy.owner, [{ userId: legacy.owner, role: 'admin' }])
    await pool.query('update device_tokens set "boundWorkspaceId"=$2 where id=$1', [legacy.tokenId, other.id])
    const state = async (runId: string) => (await pool.query('select "workspaceId",status,"leaseExpiresAt","stopRequestedAt",attempt from agent_runs where id=$1', [runId])).rows[0]
    const beforeLegacy = await state(legacy.runId)
    await denied(legacy, { caller: { ...legacy.caller, scopeWorkspaceId: other.id } })
    assert.deepEqual(await state(legacy.runId), beforeLegacy, 'a refused renewal changes no run or lease')
    assert.equal(await runtime.runWorkspaceId(legacy.runId), legacy.workspaceId)

    const frozen = await fixture()
    await pool.query(`update agent_runs set "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,workspaceId}','null'::jsonb) where id=$1`, [frozen.runId])
    const beforeFrozen = await state(frozen.runId)
    await denied(frozen)
    assert.deepEqual(await state(frozen.runId), beforeFrozen, 'frozen-null refusal issues no replacement lease')
    assert.equal(await runtime.runWorkspaceId(frozen.runId), frozen.workspaceId)
  })

  await t.test('PostgreSQL rejects a foreign frozen tenant and unattributed runs receive no claim or renewal', async () => {
    const f = await fixture()
    const other = await seedWorkspace(pool, f.owner, [{ userId: f.owner, role: 'admin' }])
    await assert.rejects(pool.query(`update agent_runs set "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,workspaceId}',to_jsonb($2::text)) where id=$1`, [f.runId, other.id]), { code: '23514' })
    assert.deepEqual((await f.renew()).revoked, [], 'the refused foreign write leaves the valid run unchanged')
    const runId = randomUUID()
    await pool.query(`insert into agent_runs (id,"userId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"leaseExpiresAt",attempt)
      values ($1,$2,$3,$4,$5,$6,'running',$7,1)`, [runId, f.owner, f.agentId, f.deviceId, f.repoId, f.tokenId, f.lease])
    const state = async () => (await pool.query('select "workspaceId",status,"leaseExpiresAt","stopRequestedAt",attempt from agent_runs where id=$1', [runId])).rows[0]
    const before = await state()
    assert.equal(before.workspaceId, null)
    const grant = issueEgressCapability({ ...f.grantInput, runId, workspaceId: null }, f.now.getTime(), env)
    assert.deepEqual(await f.renew({ runs: [{ runId, secretCapabilities: [grant.capability] }], leases: { [runId]: f.lease.toISOString() } }), { taskSecrets: {}, revoked: [runId] })
    let responses = 0
    assert.equal(await authorizedClaimResponse(f.owner, { id: runId, issueId: null, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId }, f.lease.toISOString(), () => {
      responses++
      return Response.json({ grant })
    }), null)
    assert.equal(responses, 0, 'unattributed runs cannot expose prepared credentials')
    assert.deepEqual(await state(), before, 'scope refusal changes no status, attempt or lease')
  })

  await t.test('a suspended or removed workspace member cannot renew legacy or frozen workspace grants', async () => {
    for (const options of [{ kind: 'cloud', legacy: true }, { kind: 'cloud' }, { kind: 'local' }] as const) {
      const f = await fixture(options)
      assert.deepEqual((await f.renew()).revoked, [])
      await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [f.ws.id, f.owner])
      await denied(f)
      await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [f.ws.id, f.owner])
      assert.deepEqual((await f.renew()).revoked, [])
      await pool.query('delete from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [f.ws.id, f.owner])
      await denied(f)
    }
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
      }, async (_run, tx) => await runtime.taskSecretSnapshot(f.workspaceId, f.binding.repository, f.owner, tx, { runId: f.runId }) === prepared)
      assert.equal(result, null, mutation)
      assert.equal(responses, 0, 'no prepared credentials leave a refused claim')
    }
    const f = await fixture({ status: 'preparing' })
    await store.replaceWorkspaceSecret(f.owner, f.ws.id, { id: f.saved.id, note: 'safe metadata edit' })
    const result = await authorizedClaimResponse(f.owner, { id: f.runId, issueId: f.issueId, agentId: f.agentId, deviceId: f.deviceId, deviceRepoId: f.repoId }, f.lease.toISOString(), () => Response.json({ grant: f.grant }),
      async (_run, tx) => await runtime.taskSecretSnapshot(f.workspaceId, f.binding.repository, f.owner, tx, { runId: f.runId }) === f.injection.snapshot)
    assert.equal(result?.status, 200, 'an unchanged security snapshot may finish the claim')
    assert.ok(!(await result!.text()).includes(f.value))
  })
})
