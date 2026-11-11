import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { enterprisePrincipal } from './principal'
import { tokenWorkspace } from '../tokens/principal'

const target = process.env.E2E_DATABASE_URL
const allowed = !!target && disposableDatabase(process.env, target)
if (process.env.REQUIRE_DB === '1' && !allowed) throw new Error('Enterprise execution tests require isolated loopback *_e2e targets')
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  return 'cause' in error ? errorCode(error.cause) : undefined
}

test('Enterprise execution authority keeps verified device/workflow/cron provenance and current tenant policy with pools of one', { skip: !allowed, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: target, max: 1 })
  const database = 'enterprise_execution_' + randomUUID().replaceAll('-', '') + '_e2e'
  await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0')
  const isolated = new URL(target!); isolated.pathname = '/' + database
  const url = isolated.toString()
  const control = new Pool({ connectionString: url, max: 3 })
  const app = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=10000 -c lock_timeout=5000' })
  const workspace = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=10000 -c lock_timeout=5000' })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  const envKeys = ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL',
    'MIKKA_EDITION', 'MIKKA_BYOS_ENABLED', 'VERCEL_ENV', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET',
    'WORKSPACE_SECRETS_KEY', 'CRON_SECRET', 'NEXT_PUBLIC_POSTHOG_KEY'] as const
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url, ORVILO_DATABASE_URL: url,
    MIKKA_EDITION: 'cloud', MIKKA_BYOS_ENABLED: '1', BETTER_AUTH_URL: 'http://localhost:3100', NEXT_PUBLIC_POSTHOG_KEY: '',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
    CRON_SECRET: randomBytes(32).toString('hex') })
  delete process.env.VERCEL_ENV
  globals.mikkaPool = app; globals.workspacePool = workspace
  let flush: (() => Promise<void>) | undefined, restoreSwitches: (() => void) | undefined
  let restoreTimer: (() => void) | undefined
  t.after(async () => {
    await flush?.()
    restoreTimer?.(); restoreSwitches?.(); mock.restoreAll()
    globals.mikkaPool = previousPools.app; globals.workspacePool = previousPools.workspace
    await dropTestDatabase(admin, database, app, workspace, control)
    await admin.end()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  assert.equal(Math.floor(Number((await control.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17)
  const directory = new URL('../../drizzle/', import.meta.url)
  for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
    await control.query(await readFile(new URL(name, directory), 'utf8'))

  const context = await import('../../apps/api/src/context')
  const framework = await import('next/headers')
  mock.module('next/headers', { namedExports: { ...framework,
    headers: async () => context.requireRequestScope().headers,
    cookies: async () => context.requireRequestScope().cookies,
  } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next,
    after: (work: () => unknown) => context.requireRequestScope().after.add(work),
  } })
  const requestScope = async <T,>(request: Request, work: (request: Request) => Promise<T>): Promise<T> => {
    const scope = context.createRequestScope(request)
    try { return await context.runRequestScope(scope, () => work(request)) }
    finally { await scope.after.finish() }
  }

  // Request headers/cookies/after above use the real API request context.
  // Only the Workflow executor/World transport boundary is replaced here.
  // Runtime proof is absent by default and scoped to one explicit fixture step.
  // Native authentication, tokens, SSO/PAT selection, lease receipts, Factory
  // owners, membership, frozen identities and every policy query use real PG.
  // OIDC/SAML protocol completion is separately exercised by http.db.test.ts.
  type Runtime = { workflowName: string; workflowRunId: string; stepId: string }
  const runtime = new AsyncLocalStorage<Runtime>()
  const names = { coordinator: 'workflow//enterprise-fixture/coordinator', recovery: 'workflow//enterprise-fixture/recovery',
    factory: 'workflow//enterprise-fixture/factory', thread: 'workflow//enterprise-fixture/thread' }
  const actualWorkflow = await import('workflow')
  mock.module('workflow', { cache: true, namedExports: { ...actualWorkflow,
    getWorkflowMetadata: () => {
      const value = runtime.getStore()
      if (!value) throw new Error('No Workflow executor context')
      return { workflowName: value.workflowName, workflowRunId: value.workflowRunId, workflowStartedAt: new Date(), url: 'http://localhost:3100', features: { encryption: false } }
    },
    getStepMetadata: () => {
      const value = runtime.getStore()
      if (!value) throw new Error('No Workflow executor context')
      return { stepId: value.stepId, stepName: 'step//enterprise-fixture/owner', stepStartedAt: new Date(), attempt: 1 }
    },
  } })
  const registration = (workflowId: string) => Object.assign(async () => { throw new Error('This fixture must not execute another Workflow') }, { workflowId })
  mock.module(new URL('../../workflows/coordinator/workflow.ts', import.meta.url).href, { cache: true, namedExports: { coordinatorTurn: registration(names.coordinator) } })
  mock.module(new URL('../../workflows/due-timer/workflow.ts', import.meta.url).href, { cache: true, namedExports: { dueTimer: registration(names.recovery) } })
  mock.module(new URL('../../workflows/factory-stage/workflow.ts', import.meta.url).href, { cache: true, namedExports: { factoryCloudStageHandoff: registration(names.factory) } })
  mock.module(new URL('../../workflows/thread-machine/workflow.ts', import.meta.url).href, { cache: true, namedExports: { threadMachineLifecycle: registration(names.thread) } })
  const actualApi = await import('workflow/api')
  let hookRunId: string | undefined
  mock.module('workflow/api', { cache: true, namedExports: { ...actualApi,
    getHookByToken: async (token: string) => {
      assert.equal(token, (await import('../workflow-wake-tokens')).wakeTokens.dueTimer('run-recovery'))
      if (!hookRunId) throw new Error('Fixture has no durable recovery owner')
      return { token, runId: hookRunId }
    },
  } })
  const { isolateCoordinatorWakes } = await import('../../tests/support/coordinator-wake')
  const wakes = await isolateCoordinatorWakes(t); flush = wakes.flush
  const { dueTimerTransport } = await import('../due-timer')
  const previousStart = dueTimerTransport.start
  dueTimerTransport.start = async () => ({ runId: 'isolated-execution-timer' })
  restoreTimer = () => { if (previousStart) dueTimerTransport.start = previousStart; else delete dueTimerTransport.start }
  const { overrideDeploymentSwitch } = await import('../deployment-switches')
  for (const name of ['factoryRouting', 'factoryLifecycle', 'issueTools', 'byos'] as const) overrideDeploymentSwitch(name, true)
  restoreSwitches = () => { for (const name of ['factoryRouting', 'factoryLifecycle', 'issueTools', 'byos'] as const) overrideDeploymentSwitch(name, undefined) }

  const { seedUser, seedWorkspace, seedBot, seedAgent } = await import('../../tests/support/workspace-admin-db')
  const userId = await seedUser(control, 'enterprise-execution')
  const otherUser = await seedUser(control, 'enterprise-execution-other')
  const alpha = (await seedWorkspace(control, userId, [{ userId, role: 'admin' }])).id
  const beta = (await seedWorkspace(control, userId, [{ userId, role: 'admin' }])).id
  const alphaBot = await seedBot(control, alpha, userId), betaBot = await seedBot(control, beta, userId)
  const agentId = await seedAgent(control, userId), deviceId = randomUUID()
  await control.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt")
    VALUES($1,$2,'Enterprise device fixture','local',true,3,now())`, [deviceId, userId])
  const organizationId = randomUUID()
  await control.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,$2,$3)', [organizationId, 'Execution fixture', userId])
  for (const workspaceId of [alpha, beta]) await control.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [workspaceId, organizationId])
  await control.query('INSERT INTO enterprise_org_policy("organizationId","enforceSso","allowMachineCredentials") VALUES($1,false,true)', [organizationId])
  const { pool } = await import('../db')
  const { withDatabaseClient } = await import('../db/request-scope')
  const { actAs } = await import('../acting-user')
  const { withTaskWorkspace } = await import('../task-workspace')
  const { enterpriseWorkspaceAllowed } = await import('./access')
  const authority = await import('./execution-authority')
  const { withDeviceRoute } = await import('../device-route')
  const { issueDeviceToken, hashDeviceToken } = await import('../device-link')
  const { CLIENT_VERSION_HEADER } = await import('@mikka/protocol/version')
  const { claimLocalRun } = await import('../computer/claim')
  const { completeRunForDevice, dispatchCompletedIssue } = await import('../run-completion')
  const { freezeExecutionIdentity } = await import('../execution-identity')
  const { factoryForBot } = await import('../factory/server')
  const { factoryRuntimeForBot, guardFactoryClaim } = await import('../factory/runtime')
  const factories = new Map([[alpha, factoryRuntimeForBot(alphaBot)], [beta, factoryRuntimeForBot(betaBot)]])
  let issueNumber = 0
  async function task(workspaceId: string, botId: string) {
    const issueId = randomUUID(), sourceEventId = randomUUID()
    await control.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority)
      VALUES($1,$2,$3,'bound','workspace','Execution authority fixture',$4,'todo','normal')`,
    [issueId, userId, workspaceId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++issueNumber } }, content: [] })])
    await control.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
      VALUES($1::uuid,$2,$3,$4,'user_message',$1::text,'{"text":"Execution authority fixture"}')`, [sourceEventId, userId, botId, issueId])
    const result = await factoryForBot(botId).route(userId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Verify original authority', needsSpec: false })
    return { issueId, task: result.task }
  }
  const a = await task(alpha, alphaBot), b = await task(beta, betaBot)
  const definition = await freezeExecutionIdentity(control, { userId, botId: alphaBot, deviceId,
    agentDefinition: {} as NonNullable<Parameters<typeof freezeExecutionIdentity>[1]['agentDefinition']> }, undefined, alpha)
  async function queuedRun(requester = userId, issueId = a.issueId) {
    const id = randomUUID()
    await control.query(`INSERT INTO agent_runs(id,"userId","workspaceId","botId","issueId","agentId","deviceId",status,prompt,"agentDefinition")
      VALUES($1,$2,$3,$4,$5,$6,$7,'queued','Synthetic native claim; no executor',$8)`,
    [id, userId, alpha, alphaBot, issueId, agentId, deviceId, JSON.stringify({ executionIdentity: { ...definition, requester } })])
    return id
  }
  await control.query('UPDATE enterprise_org_policy SET "enforceSso"=true WHERE "organizationId"=$1', [organizationId])
  const deviceToken = await issueDeviceToken(userId, 'Enterprise execution fixture')
  const tokenId = (await control.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [hashDeviceToken(deviceToken)])).rows[0].id as string
  const cronRequest = new Request('http://localhost:3100/api/cron/run-recovery', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } })
  const denied = (error: unknown) => ['workspaceAccessDenied', 'factoryNotFound'].includes(errorCode(error) ?? '')
  const readA = () => factories.get(alpha)!.store.read(userId, a.task.id)
  const readB = () => factories.get(beta)!.store.read(userId, b.task.id)
  const plain = { id: randomUUID(), token: randomBytes(32).toString('hex') }
  await control.query(`INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`,
    [plain.id, plain.token, userId])
  const native = async <T>(work: () => Promise<T>, options: { token?: string; deviceId?: string; runId?: string } = {}) => {
    const handler = withDeviceRoute(async () => {
      try { return Response.json({ value: await work() }) }
      catch (error) { if (denied(error)) return Response.json({ error: 'workspaceAccessDenied' }, { status: 403 }); throw error }
    })
    const request = new Request('http://localhost:3100/v1/devices/' + (options.deviceId ?? deviceId) + '/runs/' + (options.runId ?? randomUUID()) + '/claim', {
      method: 'POST', headers: { authorization: 'Bearer ' + (options.token ?? deviceToken), [CLIENT_VERSION_HEADER]: '999.0.0' },
    })
    return requestScope(request, handler)
  }
  const step = <T>(workflowName: string, workflowRunId: string, work: () => Promise<T>) =>
    runtime.run({ workflowName, workflowRunId, stepId: 'step_' + randomUUID() }, work)
  const withCron = <T>(work: () => Promise<T>) => authority.withRecoveryCronAuthority(cronRequest, work)

  await t.test('a real device bearer admits a queued claim, completion and later Factory read without fabricated admission', async () => {
    const id = await queuedRun()
    let hook = false
    const claimed = await native(() => claimLocalRun(pool, id, deviceId, new Date(Date.now() + 60_000), undefined, async tx => {
      await guardFactoryClaim(tx, userId, deviceId, id, new Date(Date.now() + 60_000).toISOString()); hook = true
    }), { runId: id })
    assert.equal(claimed.status, 200); assert.equal((await claimed.json()).value, 'claimed'); assert.equal(hook, true)
    assert.equal((await control.query('SELECT status,"machineAuthority" FROM agent_runs WHERE id=$1', [id])).rows[0].status, 'preparing')
    const completed = await native(() => completeRunForDevice(userId, { id, issueId: a.issueId }, { stopReason: 'cancelled' }), { runId: id })
    assert.equal(completed.status, 200); assert.equal((await completed.json()).value.userId, userId)
    assert.equal((await control.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status, 'cancelled')
    const read = await native(readA, { runId: id })
    assert.equal(read.status, 200); assert.equal((await read.json()).value.task.id, a.task.id)

    // Publication owns a separate APP transaction after completion. Exercise
    // its fresh Enterprise admission with the same pools of one and real
    // result, without a provider request or changing the existing Factory task.
    const publicationIssue = randomUUID()
    await control.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,"linearSyncPolicy",title,content,status,priority)
      VALUES($1,$2,$3,'bound','workspace','explicit','Execution publication fixture',$4,'todo','normal')`,
    [publicationIssue, userId, alpha, JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++issueNumber } }, content: [] })])
    const publicationRun = await queuedRun(userId, publicationIssue)
    const publicationClaim = await native(() => claimLocalRun(pool, publicationRun, deviceId, new Date(Date.now() + 60_000)), { runId: publicationRun })
    assert.equal(publicationClaim.status, 200); assert.equal((await publicationClaim.json()).value, 'claimed')
    const scheduled: string[] = []
    const publication = await native(async () => {
      const result = await completeRunForDevice(userId, { id: publicationRun, issueId: publicationIssue }, {
        stopReason: 'submitted', report: { summary: 'Synthetic publication fixture', filesChanged: [],
          verify: { status: 'passed' }, openQuestions: [], nextStep: null },
      })
      assert.ok(result?.review)
      assert.equal(await dispatchCompletedIssue(result, issueId => { scheduled.push(issueId) }), true)
      return result
    }, { runId: publicationRun })
    assert.equal(publication.status, 200)
    assert.equal((await publication.json()).value.review.id, publicationIssue)
    assert.deepEqual(scheduled, [publicationIssue])
    assert.equal((await control.query('SELECT status FROM agent_runs WHERE id=$1', [publicationRun])).rows[0].status, 'succeeded')
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })

  await t.test('protected Secret renewal rechecks current Enterprise authority on the same admitted run with pools of one', async () => {
    const { createWorkspaceSecret } = await import('../secrets/store')
    const { taskSecretInjection } = await import('../secrets/runtime')
    const { issueEgressCapability, openEgressCapability } = await import('../secrets/egress-capability')
    const { renewTaskSecretAccess } = await import('../secrets/task-renewal')
    const connectionId = randomUUID(), directoryId = randomUUID(), providerId = 'secret-renewal-' + randomUUID()
    const runId = await queuedRun(), canary = 'synthetic-enterprise-secret-' + randomBytes(24).toString('hex')
    const name = 'ENTERPRISE_RENEWAL_TOKEN'
    const http = { origin: 'https://api.example.invalid', header: 'authorization' as const, prefix: 'Bearer ',
      rules: [{ method: 'GET' as const, path: '/v1/items', match: 'exact' as const }] }
    const state = async () => (await control.query(`SELECT "workspaceId",status,"leaseExpiresAt","stopRequestedAt",attempt,"deviceTokenId","machineAuthority"
      FROM agent_runs WHERE id=$1`, [runId])).rows[0]
    assert.deepEqual((await control.query('SELECT "enforceSso","allowMachineCredentials" FROM enterprise_org_policy WHERE "organizationId"=$1', [organizationId])).rows[0],
      { enforceSso: true, allowMachineCredentials: true })
    await control.query(`INSERT INTO enterprise_sso_provider(id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","domainTokenHash")
      VALUES($1,$2,$3,$4,'https://secret-renewal.example.invalid',$5,true,'{}',$6)`,
    [randomUUID(), providerId, organizationId, userId, randomUUID() + '.example.invalid', randomBytes(32).toString('hex')])
    await control.query('INSERT INTO enterprise_scim_connection(id,"organizationId","providerId","tokenHash") VALUES($1,$2,$3,$4)',
      [connectionId, organizationId, providerId, randomBytes(32).toString('hex')])
    await control.query(`INSERT INTO enterprise_scim_user(id,"connectionId","organizationId","externalId","userName","userId",active,document)
      VALUES($1,$2,$3,$4,$5,$6,true,'{}')`, [directoryId, connectionId, organizationId, randomUUID(), userId + '@example.invalid', userId])
    try {
      const created = await native(() => createWorkspaceSecret(userId, alpha, { name, kind: 'secret', value: canary,
        delivery: { mode: 'protected', http } }), { runId })
      assert.equal(created.status, 200)
      const secretId = (await created.json()).value.id as string
      const lease = new Date(Date.now() + 120_000)
      const claimed = await native(() => claimLocalRun(pool, runId, deviceId, lease, undefined, undefined, async tx => {
        // Match the original claim's host-written token lineage; no authority
        // constructor or membership bypass is added to the renewal under test.
        await tx.query('UPDATE agent_runs SET "deviceTokenId"=$2,"machineAuthority"=$4 WHERE id=$1 AND "userId"=$3',
          [runId, tokenId, userId, true])
      }), { runId })
      assert.equal(claimed.status, 200); assert.equal((await claimed.json()).value, 'claimed')
      const admitted = await state()
      assert.equal(admitted.workspaceId, alpha); assert.equal(admitted.deviceTokenId, tokenId)
      assert.equal(admitted.leaseExpiresAt.toISOString(), lease.toISOString())
      const injection = await taskSecretInjection(alpha, null, process.env, undefined, userId)
      const secret = injection.protectedSecrets.find(value => value.id === secretId)
      assert.ok(secret?.revision)
      const binding = { ownerId: userId, workspaceId: alpha, repository: null, runId, deviceId, deviceTokenId: tokenId, attempt: admitted.attempt }
      const grant = issueEgressCapability({ ...binding, name, secret: canary, secretId, revision: secret.revision, http, leaseExpiresAt: lease })
      const renew = () => renewTaskSecretAccess({ caller: { userId, tokenId }, deviceId,
        runs: [{ runId, secretCapabilities: [grant.capability] }], leases: { [runId]: lease.toISOString() },
        endpoint: id => `https://mikka.example.invalid/v1/task-secrets/${id}` })
      const checkRenewal = async (authorized: boolean) => {
        const response = await native(renew, { runId })
        assert.equal(response.status, 200)
        const wire = await response.text(), result = JSON.parse(wire).value
        for (const value of [canary, Buffer.from(canary).toString('base64')]) assert.equal(wire.includes(value), false)
        if (authorized) {
          assert.deepEqual(result.revoked, [])
          assert.equal(result.taskSecrets[runId].grants.length, 1)
          const claims = openEgressCapability(result.taskSecrets[runId].grants[0].capability, binding)
          assert.equal(claims.secret, canary); assert.equal(claims.secretId, secretId)
          assert.ok(claims.expiresAt <= lease.getTime())
        } else {
          assert.deepEqual(result, { taskSecrets: {}, revoked: [runId] })
          assert.equal(wire.includes('mikka-egress-v1.'), false, 'refused authority returns no sealed capability')
        }
        assert.deepEqual(await state(), admitted, 'renewal does not extend or rewrite the admitted run lease, attempt or token')
        assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
      }
      await checkRenewal(true)
      await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=false WHERE "organizationId"=$1', [organizationId])
      await checkRenewal(false)
      await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=true WHERE "organizationId"=$1', [organizationId])
      await checkRenewal(true)
      await control.query('UPDATE enterprise_scim_user SET active=false WHERE id=$1', [directoryId])
      assert.equal((await control.query('SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, userId])).rows[0].status,
        'active', 'SCIM authority alone must refuse even before Workspace membership delivery')
      await checkRenewal(false)
      await control.query('UPDATE enterprise_scim_user SET active=true WHERE id=$1', [directoryId])
      await checkRenewal(true)
    } finally {
      await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=true WHERE "organizationId"=$1', [organizationId])
      await control.query('DELETE FROM enterprise_scim_user WHERE id=$1', [directoryId])
      await control.query('DELETE FROM enterprise_scim_connection WHERE id=$1', [connectionId])
      await control.query('DELETE FROM enterprise_sso_provider WHERE "providerId"=$1', [providerId])
      await control.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`, [runId])
    }
  })

  await t.test('original human/PAT authority always wins and absence or forged fields cannot inherit server authority', async () => {
    const { getApiSession } = await import('../api-auth')
    const request = new Request('http://localhost:3100/mikka/api/factory/tasks', { headers: { authorization: 'Bearer ' + plain.token } })
    const session = await requestScope(request, req => getApiSession({ headers: req.headers, query: { disableCookieCache: true } }))
    assert.ok(session)
    assert.equal(session.user[enterprisePrincipal]?.kind, 'session')
    await assert.rejects(withCron(() => actAs(session.user, readA)), denied)
    await assert.rejects(withCron(() => actAs({ id: userId, [enterprisePrincipal]: { kind: 'pat', tokenId: randomUUID(), workspaceId: alpha } }, readA)), denied)
    await assert.rejects(withCron(() => actAs({ id: userId, [tokenWorkspace]: beta }, readA)), denied)
    await assert.rejects(actAs(userId, readA), denied)
    const forged = { id: userId, enterprisePrincipal: { kind: 'execution', workflowRunId: 'supplied-by-client' } }
    await assert.rejects(actAs(forged, readA), denied)
    const stillPlain = await native(readA, { token: plain.token })
    assert.equal(stillPlain.status, 401, 'a native human session is not a daemon credential')
    assert.equal((await withCron(readA)).task.id, a.task.id)
  })

  await t.test('machine policy, membership, SCIM, token revocation and frozen requester changes deny without claim writes', async () => {
    for (const reason of ['policy', 'member', 'scim', 'token', 'frozen'] as const) {
      const id = await queuedRun(reason === 'frozen' ? otherUser : userId)
      if (reason === 'policy') await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=false WHERE "organizationId"=$1', [organizationId])
      if (reason === 'member') await control.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, userId])
      if (reason === 'token') await control.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
      const connectionId = randomUUID(), directoryId = randomUUID(), providerId = 'execution-' + randomUUID()
      if (reason === 'scim') {
        await control.query(`INSERT INTO enterprise_sso_provider(id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","domainTokenHash")
          VALUES($1,$2,$3,$4,'https://execution.example.invalid',$5,true,'{}',$6)`,
        [randomUUID(), providerId, organizationId, userId, randomUUID() + '.example.invalid', randomBytes(32).toString('hex')])
        await control.query('INSERT INTO enterprise_scim_connection(id,"organizationId","providerId","tokenHash") VALUES($1,$2,$3,$4)', [connectionId, organizationId, providerId, randomBytes(32).toString('hex')])
        await control.query(`INSERT INTO enterprise_scim_user(id,"connectionId","organizationId","externalId","userName","userId",active,document) VALUES($1,$2,$3,$4,$5,$6,false,'{}')`,
          [directoryId, connectionId, organizationId, randomUUID(), userId + '@example.invalid', userId])
      }
      try {
        const response = await native(() => claimLocalRun(pool, id, deviceId, new Date(Date.now() + 60_000)), { runId: id })
        assert.equal(response.status, reason === 'token' ? 401 : 200, reason)
        if (reason !== 'token') assert.equal((await response.json()).value, 'unavailable', reason)
        assert.equal((await control.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status, 'queued', reason)
      } finally {
        await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=true WHERE "organizationId"=$1', [organizationId])
        await control.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, userId])
        await control.query('UPDATE device_tokens SET "revokedAt"=null WHERE id=$1', [tokenId])
        if (reason === 'scim') {
          await control.query('DELETE FROM enterprise_scim_user WHERE id=$1', [directoryId])
          await control.query('DELETE FROM enterprise_scim_connection WHERE id=$1', [connectionId])
          await control.query('DELETE FROM enterprise_sso_provider WHERE "providerId"=$1', [providerId])
        }
      }
    }
    const id = await queuedRun()
    await assert.rejects(control.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,workspaceId}',to_jsonb($2::text)) WHERE id=$1`, [id, beta]),
      error => errorCode(error) === '23514', 'database ownership cannot be bypassed with frozen JSON')
  })

  await t.test('cloud-scoped native credentials retain exact device, Workspace and live machine constraints', async () => {
    const cloudDevice = randomUUID(), runId = randomUUID(), cloudTokenId = randomUUID(), cloudToken = randomBytes(32).toString('base64url')
    await control.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"protocolVersion") VALUES($1,$2,'Cloud fixture','cloud',true,3)`, [cloudDevice, userId])
    await control.query(`INSERT INTO agent_runs(id,"userId","workspaceId","botId","issueId","agentId","deviceId",status,prompt) VALUES($1,$2,$3,$4,$5,$6,$7,'queued','No provider')`,
      [runId, userId, alpha, alphaBot, a.issueId, agentId, cloudDevice])
    await control.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId","botId") VALUES($1,$2,$3,'fixture',$4,'running',$5,$6)`,
      [runId, alpha, userId, randomUUID(), cloudDevice, alphaBot])
    await control.query(`INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`,
      [cloudTokenId, userId, hashDeviceToken(cloudToken), cloudDevice, alpha])
    const options = { token: cloudToken, deviceId: cloudDevice, runId }
    const good = await native(readA, options); assert.equal(good.status, 200)
    const foreign = await native(readB, options); assert.equal(foreign.status, 403)
    await control.query('UPDATE devices SET enabled=false WHERE id=$1', [cloudDevice])
    assert.equal((await native(readA, options)).status, 403)
    await control.query('UPDATE devices SET enabled=true WHERE id=$1', [cloudDevice])
    await control.query(`UPDATE thread_machines SET state='ended' WHERE "runId"=$1`, [runId])
    assert.equal((await native(readA, options)).status, 401)
  })

  await t.test('Coordinator runtime registration and its current durable Bot lease bind user and Workspace', async () => {
    const holder = 'wrun_' + randomUUID()
    await control.query(`INSERT INTO coordinator_sessions("userId","botId","leaseHolder","leaseUntil") VALUES($1,$2,$3,now()+interval '1 minute')
      ON CONFLICT("userId","botId") DO UPDATE SET "leaseHolder"=excluded."leaseHolder","leaseUntil"=excluded."leaseUntil"`, [userId, alphaBot, holder])
    const invoke = <T>(work: () => Promise<T>, run = holder, name = names.coordinator) => step(name, run, () => actAs(userId, work))
    assert.equal((await invoke(readA)).task.id, a.task.id)
    await assert.rejects(invoke(readB), denied)
    await assert.rejects(invoke(readA, 'wrun_other'), denied)
    await assert.rejects(invoke(readA, holder, names.coordinator + '/lookalike'), denied)
    await assert.rejects(step(names.coordinator, holder, () => actAs({ id: userId, [enterprisePrincipal]: { kind: 'session', sessionId: plain.id } }, readA)), denied)
    await control.query('UPDATE coordinator_sessions SET "leaseUntil"=now()-interval \'1 second\' WHERE "userId"=$1 AND "botId"=$2', [userId, alphaBot])
    await assert.rejects(invoke(readA), denied)
    await control.query('UPDATE coordinator_sessions SET "leaseUntil"=now()+interval \'1 minute\' WHERE "userId"=$1 AND "botId"=$2', [userId, alphaBot])
    await control.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, userId])
    try { await assert.rejects(invoke(readA), denied) }
    finally { await control.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, userId]) }
  })

  await t.test('cron credentials are rechecked and callback authority expires instead of becoming ambient user privilege', async () => {
    let called = false
    await assert.rejects(authority.withRecoveryCronAuthority(new Request('http://localhost/api/cron/run-recovery', { headers: { authorization: 'Bearer incorrect' } }),
      async () => { called = true }), denied)
    assert.equal(called, false)
    let escaped: (() => Promise<unknown>) | undefined
    await withCron(async () => {
      assert.equal((await readA()).task.id, a.task.id)
      escaped = AsyncLocalStorage.bind(() => actAs(userId, readA))
    })
    await assert.rejects(escaped!(), denied)
    const originalSecret = process.env.CRON_SECRET
    await withCron(async () => {
      process.env.CRON_SECRET = randomBytes(32).toString('hex')
      try { await assert.rejects(actAs(userId, readA), denied) }
      finally { process.env.CRON_SECRET = originalSecret }
    })
    // A delayed cron consumer starts a new bounded callback after validating
    // the same real request again; it never revives the escaped old capability.
    assert.equal((await withCron(() => actAs(userId, readA))).task.id, a.task.id)
  })

  await t.test('the real recovery hook receipt and exact step context are required for timer work', async () => {
    const holder = 'wrun_' + randomUUID()
    const invoke = (work: () => Promise<unknown>) => step(names.recovery, holder, () => authority.withRecoveryWorkflowAuthority(work))
    hookRunId = 'wrun_different'
    await assert.rejects(invoke(() => actAs(userId, readA)), denied)
    hookRunId = holder
    assert.ok(await invoke(() => actAs(userId, readA)))
    await assert.rejects(authority.withRecoveryWorkflowAuthority(() => actAs(userId, readA)), denied)
    await invoke(async () => {
      hookRunId = 'wrun_successor'
      await assert.rejects(actAs(userId, readA), denied)
    })
    hookRunId = undefined
  })

  await t.test('thread step capability rechecks persisted computer binding and frozen identity for queued and ended work', async () => {
    const runId = await queuedRun(), holder = 'wrun_' + randomUUID()
    await control.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [runId, alphaBot, alpha, userId])
    const invoke = (work: () => Promise<unknown>, actor = { userId, workspaceId: alpha }, name = names.factory) =>
      step(name, holder, () => authority.withThreadWorkflowAuthority(actor, runId, () => actAs(userId, work)))
    assert.ok(await invoke(readA))
    await assert.rejects(invoke(readB), denied)
    await assert.rejects(invoke(readA, { userId: otherUser, workspaceId: alpha }), denied)
    await assert.rejects(invoke(readA, { userId, workspaceId: beta }), denied)
    await assert.rejects(invoke(readA, { userId, workspaceId: alpha }, names.factory + '/lookalike'), denied)
    await assert.rejects(authority.withThreadWorkflowAuthority({ userId, workspaceId: alpha }, runId, () => actAs(userId, readA)), denied)
    await control.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`, [runId])
    assert.ok(await invoke(readA, { userId, workspaceId: alpha }, names.thread))
    await control.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,requester}',to_jsonb($2::text)) WHERE id=$1`, [runId, otherUser])
    await assert.rejects(invoke(readA), denied)
    await control.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,requester}',to_jsonb($2::text)) WHERE id=$1`, [runId, userId])
    await control.query('DELETE FROM computer_run_bindings WHERE "runId"=$1', [runId])
    await assert.rejects(invoke(readA), denied)

    // Production retirement commits the terminal run, ended machine and
    // removed cloud device before afterRunEnded invokes the Factory owner.
    const retiredDevice = randomUUID(), retiredRun = randomUUID(), keyId = randomUUID()
    await control.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"protocolVersion") VALUES($1,$2,'Retired thread fixture','cloud',true,3)`, [retiredDevice, userId])
    const { sealSecret } = await import('../secrets/crypto')
    const sealed = sealSecret('isolated-fixture-never-sent-to-a-provider', 'enterprise-execution-fixture')
    await control.query(`INSERT INTO model_api_keys(id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4) VALUES($1,$2,'openai','openai',$3,$4,$5,'only')`,
      [keyId, userId, sealed.ciphertext, sealed.iv, sealed.keyVersion])
    await control.query(`INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,$2,$3,$4,'only')`,
      [userId, sealed.ciphertext, sealed.iv, sealed.keyVersion])
    const cloudDefinition = { apiKey: { keyId } } as NonNullable<Parameters<typeof freezeExecutionIdentity>[1]['agentDefinition']>
    const frozen = await withCron(() => freezeExecutionIdentity(control, { userId, botId: alphaBot, deviceId: retiredDevice, agentDefinition: cloudDefinition }, undefined, alpha))
    await control.query(`INSERT INTO agent_runs(id,"userId","workspaceId","botId","issueId","agentId","deviceId",status,prompt,"agentDefinition")
      VALUES($1,$2,$3,$4,$5,$6,$7,'queued','No cloud executor or provider call',$8)`,
      [retiredRun, userId, alpha, alphaBot, a.issueId, agentId, retiredDevice, JSON.stringify({ ...cloudDefinition, executionIdentity: frozen })])
    await control.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [retiredRun, alphaBot, alpha, userId])
    await control.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId","botId") VALUES($1,$2,$3,'fixture',$4,'running',$5,$6)`,
      [retiredRun, alpha, userId, randomUUID(), retiredDevice, alphaBot])
    const invokeRetired = () => step(names.thread, holder, () => authority.withThreadWorkflowAuthority({ userId, workspaceId: alpha }, retiredRun, () => actAs(userId, readA)))
    const retirement = await control.connect()
    try {
      await retirement.query('BEGIN')
      await retirement.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=now() WHERE id=$1`, [retiredRun])
      await retirement.query(`UPDATE thread_machines SET state='ended',"endedAt"=now() WHERE "runId"=$1`, [retiredRun])
      await retirement.query('UPDATE devices SET "removedAt"=now() WHERE id=$1', [retiredDevice])
      await retirement.query('COMMIT')
    } catch (error) { await retirement.query('ROLLBACK'); throw error }
    finally { retirement.release() }
    assert.equal((await invokeRetired()).task.id, a.task.id, 'the exact retired thread can still finalize its Factory lifecycle')
    await control.query(`UPDATE thread_machines SET state='running' WHERE "runId"=$1`, [retiredRun])
    await assert.rejects(invokeRetired(), denied, 'a removed device with a live machine is not a retirement receipt')
    await control.query(`UPDATE thread_machines SET state='ended' WHERE "runId"=$1`, [retiredRun])
    await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=false WHERE "organizationId"=$1', [organizationId])
    try { await assert.rejects(invokeRetired(), denied, 'terminal cleanup cannot override current machine policy') }
    finally { await control.query('UPDATE enterprise_org_policy SET "allowMachineCredentials"=true WHERE "organizationId"=$1', [organizationId]) }
    await control.query('DELETE FROM thread_machines WHERE "runId"=$1', [retiredRun])
    await assert.rejects(invokeRetired(), denied, 'an absent retirement receipt cannot authorize a removed device')
  })

  await t.test('fresh execution checks reuse the held APP executor after WS admission with both pools at one', async () => {
    const response = await native(() => withTaskWorkspace(userId, alpha, async (_workspace, workspaceTx) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await withDatabaseClient(client, () => enterpriseWorkspaceAllowed(userId, alpha, undefined, workspaceTx, client))
        assert.equal(result, true)
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }))
    assert.equal(response.status, 200); assert.equal((await response.json()).value, true)
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })
})
