import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { freezeWorkerDefinition } from '../lib/agent-kit/worker'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')

test('Organization connections use the real vault, memberships, policy, frozen identity, revocation and audit', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `organization_connections_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 5 })
  const names = ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'WORKSPACE_SECRETS_KEY', 'MIKKA_MODEL_KEY_LOOPBACK'] as const
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), MIKKA_MODEL_KEY_LOOPBACK: '1' })
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  let providerRequests = 0
  const provider = createServer((request, response) => {
    providerRequests++
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })) }
    else if (request.url === '/v1/responses') { response.writeHead(400); response.end('{}') }
    else { response.writeHead(404); response.end('{}') }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address(); assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    mock.module('next/server', { namedExports: { after() {} } })
    const { readOrganizationConnections, saveOrganizationConnection, revokeOrganizationConnection, configureOrganizationModels } = await import('../lib/organization-connections')
    const { usableApiKeys, openApiKeyForChat, apiKeyForRun, apiKeyAfterQuota, setApiKeyAfterQuota } = await import('../lib/model-api-keys')
    const { freezeExecutionIdentity, revalidateExecutionIdentity, ExecutionIdentityError } = await import('../lib/execution-identity')
    const { DEFAULT_ORGANIZATION_MODEL_POLICY } = await import('../lib/organization-model-policy')
    appPool = (await import('../lib/db')).pool; workspacePool = (await import('../lib/workspace-db')).workspacePool
    for (const user of ['admin', 'member', 'other', 'org-only']) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const org = randomUUID(), foreignOrg = randomUUID(), workspace = randomUUID(), foreignWorkspace = randomUUID()
    for (const id of [org, foreignOrg]) await pool.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,\'Fixture organization\',\'admin\')', [id])
    for (const [id, organizationId] of [[workspace, org], [foreignWorkspace, foreignOrg]]) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,\'admin\',\'Fixture workspace\',\'team\')', [id])
      await pool.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [id, organizationId])
    }
    for (const user of ['admin', 'member', 'org-only']) await pool.query('INSERT INTO mikka_organization_members("organizationId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')', [org, user, `${user}@example.invalid`, user === 'admin' ? 'owner' : 'member'])
    for (const user of ['admin', 'member', 'other']) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')', [workspace, user, `${user}@example.invalid`, user === 'admin' ? 'admin' : 'member'])
    const input = { connectionKind: 'gateway', credential: { provider: 'custom', name: 'Fixture gateway', baseUrl, protocol: 'openai', apiKey: `synthetic-${randomUUID()}` } }
    await assert.rejects(saveOrganizationConnection(org, 'member', input), { code: 'governance_denied' })
    assert.equal(providerRequests, 0, 'a non-admin cannot even probe with the submitted credential')
    const key = await saveOrganizationConnection(org, 'admin', input)
    assert.equal(key.ownership, 'organization'); assert.equal(key.organizationId, org); assert.equal(key.revision, 1)
    assert.equal(providerRequests, 2, 'the actual loopback provider handled model verification and Responses detection')
    const raw = (await pool.query('SELECT * FROM model_api_keys WHERE id=$1', [key.id])).rows[0]
    assert.equal(raw.ownerId, `organization:${org}`)
    assert.ok(!JSON.stringify(raw).includes(input.credential.apiKey), 'the persisted key is sealed')
    assert.ok(!JSON.stringify(await readOrganizationConnections(org, 'admin')).includes(input.credential.apiKey), 'admin views never return a token')
    await assert.rejects(readOrganizationConnections(org, 'member'), { code: 'governance_denied' })
    await t.test('both Organization and Workspace membership, and the tenant link, are required', async () => {
      assert.deepEqual((await usableApiKeys(pool, 'member', workspace)).map(value => value.id), [key.id])
      for (const [user, tenant] of [['other', workspace], ['org-only', workspace], ['member', foreignWorkspace]]) {
        assert.deepEqual(await usableApiKeys(pool, user, tenant), [])
        await assert.rejects(openApiKeyForChat(pool, user, tenant, key.id), { code: 'apiKeyNotFound' })
      }
      await pool.query('UPDATE mikka_organization_members SET status=\'suspended\' WHERE "organizationId"=$1 AND "userId"=\'member\'', [org])
      await assert.rejects(openApiKeyForChat(pool, 'member', workspace, key.id), { code: 'apiKeyNotFound' })
      await pool.query('UPDATE mikka_organization_members SET status=\'active\' WHERE "organizationId"=$1 AND "userId"=\'member\'', [org])
    })
    const bot = randomUUID(), device = randomUUID(), runId = randomUUID()
    await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,\'member\',$2,\'Fixture\')', [bot, workspace])
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled) VALUES($1,\'member\',\'Fixture\',\'local\',true)', [device])
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'Fixture', parent: null, executionId: null, apiKey: { keyId: key.id, model: 'fixture-model' } })
    const run = { userId: 'member', botId: bot, deviceId: device, agentDefinition: definition }
    definition.executionIdentity = await freezeExecutionIdentity(pool, run, pool)
    await pool.query('INSERT INTO agent_runs(id,"userId","workspaceId","botId","deviceId",status,"agentDefinition") VALUES($1,\'member\',$2,$3,$4,\'queued\',$5)', [runId, workspace, bot, device, definition])
    assert.deepEqual(definition.executionIdentity.modelPayer, { kind: 'organization', id: org })
    assert.deepEqual(definition.executionIdentity.computePayer, { kind: 'personal', id: 'member' })
    const native = await apiKeyForRun(pool, runId, key.id, 'codex')
    assert.equal(native.ownerId, `organization:${org}`)
    assert.equal(native.harness, 'codex')
    if (native.harness === 'codex') assert.equal(native.codex.model_providers.mikka.base_url, baseUrl, 'Codex retains direct native transport')
    await t.test('model policy reaches new choices, chat calls and frozen Run validation', async () => {
      await configureOrganizationModels(org, 'admin', { ...DEFAULT_ORGANIZATION_MODEL_POLICY, models: { 'fixture-model': { mode: 'disabled' } } })
      assert.deepEqual((await usableApiKeys(pool, 'member', workspace))[0].models, [])
      await assert.rejects(openApiKeyForChat(pool, 'member', workspace, key.id, process.env, { model: 'fixture-model' }), { code: 'apiKeyNotFound' })
      await assert.rejects(revalidateExecutionIdentity(pool, run, pool), ExecutionIdentityError)
      await configureOrganizationModels(org, 'admin', { ...DEFAULT_ORGANIZATION_MODEL_POLICY, models: { 'fixture-model': { mode: 'organization_only', connectionId: key.id } } })
      assert.ok(await revalidateExecutionIdentity(pool, run, pool))
    })
    await t.test('credential rotation changes revision, prevents silent replacement and stops queued runs', async () => {
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [runId])
      const rotated = await saveOrganizationConnection(org, 'admin', { ...input, credential: { ...input.credential, apiKey: `synthetic-${randomUUID()}` } }, key.id)
      assert.equal(rotated.id, key.id); assert.equal(rotated.revision, 2)
      await assert.rejects(revalidateExecutionIdentity(pool, run, pool), ExecutionIdentityError)
      assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt)
      await assert.rejects(openApiKeyForChat(pool, 'member', workspace, key.id, process.env, { model: 'fixture-model', credentialOwnerId: `organization:${org}`, credentialRevision: 1 }), { code: 'apiKeyNotFound' })
      await assert.rejects(pool.query('UPDATE model_api_keys SET "ownerId"=\'member\',ownership=\'personal\',"organizationId"=NULL WHERE id=$1', [key.id]), { code: '23514' }, 'a key cannot be silently transferred')
    })
    await t.test('revocation preserves history, closes fresh reads and records a secret-free audit', async () => {
      await revokeOrganizationConnection(org, 'admin', key.id)
      assert.deepEqual(await usableApiKeys(pool, 'member', workspace), [])
      await assert.rejects(openApiKeyForChat(pool, 'member', workspace, key.id), { code: 'apiKeyNotFound' })
      const history = await readOrganizationConnections(org, 'admin')
      assert.equal(history.connections.length, 1); assert.ok(history.connections[0].revokedAt)
      const audits = (await pool.query('SELECT action,metadata FROM mikka_organization_audit_events WHERE "organizationId"=$1 ORDER BY "createdAt"', [org])).rows
      for (const action of ['organization.connection_created', 'organization.connection_rotated', 'organization.connection_revoked', 'organization.model_policy_changed']) assert.ok(audits.some(row => row.action === action))
      assert.ok(!JSON.stringify(audits).includes(input.credential.apiKey))
    })
    await t.test('the old default true does not authorize paid fallback, and explicit consent is revocable', async () => {
      assert.equal(await apiKeyAfterQuota(pool, 'member'), false)
      await pool.query('UPDATE "user" SET "apiKeyAfterQuota"=true WHERE id=\'member\'')
      assert.equal(await apiKeyAfterQuota(pool, 'member'), false)
      await setApiKeyAfterQuota(pool, 'member', true); assert.equal(await apiKeyAfterQuota(pool, 'member'), true)
      await setApiKeyAfterQuota(pool, 'member', false); assert.equal(await apiKeyAfterQuota(pool, 'member'), false)
    })
  } finally {
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
    await Promise.all([pool.end(), appPool?.end(), workspacePool?.end()])
    await dropTestDatabase(admin, database)
    await admin.end()
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
  }
})
