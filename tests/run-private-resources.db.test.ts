import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Private resource tests require isolated loopback *_e2e PostgreSQL')
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Private resource tests cannot skip in required CI')

test('personal resource disclosure remains exclusive, immutable and bound to the actual machine history', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `private_resources_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 5 })
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    const files = orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))
    const boundary = '20261110020040_scoped_secrets_and_private_resources.sql'
    for (const file of files.filter(file => file < boundary)) await pool.query(await readFile(new URL(file, directory), 'utf8'))
    const owner = 'private-resource-owner', peer = 'private-resource-peer', workspaceId = randomUUID(), otherWorkspace = randomUUID(), agentId = randomUUID()
    for (const user of [owner, peer]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@fixture.invalid\',true,now(),now())', [user])
    await pool.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Fixture Agent\')', [agentId, owner])
    const makeTask = async (workspace = workspaceId) => {
      const id = randomUUID()
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'Fixture Task\',\'{"type":"doc"}\',\'todo\',\'normal\')', [id, owner, workspace])
      return id
    }
    const modelKeyId = randomUUID()
    const modelDefinition = (kind: 'api_key' | 'subscription' | 'native_login' = 'api_key', credentialId = modelKeyId, actorId = owner, credentialOwnerId = owner) => ({
      contextIsolation: 'shared_clean',
      ...(kind === 'api_key' ? { apiKey: { keyId: credentialId } } : kind === 'subscription' ? { subscription: { bindingId: credentialId } } : {}),
      executionIdentity: { version: 2, actor: actorId, executionPrincipal: owner,
        billingAccount: { model: { kind, resourceId: credentialId, ownerId: credentialOwnerId } } },
    })
    const makeRun = async (taskId: string, deviceId: string | null = null, source: string | null = null, workspace = workspaceId) => {
      const id = randomUUID()
      await pool.query('INSERT INTO agent_runs(id,"userId","workspaceId","agentId","issueId","deviceId","continuesRunId","agentDefinition",attempt,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,\'queued\')', [id, owner, workspace, agentId, taskId, deviceId, source, modelDefinition()])
      await pool.query("UPDATE resource_access_policies SET visibility='shared' WHERE kind='thread' AND id=$1", [id])
      return id
    }
    const makeDevice = async (kind = 'cloud') => {
      const id = randomUUID()
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Fixture Machine\',$3)', [id, owner, kind])
      return id
    }
    const legacyTask = await makeTask(), legacyDevice = await makeDevice(), legacyRun = await makeRun(legacyTask, legacyDevice)
    await pool.query("UPDATE agent_runs SET status='succeeded',\"startedAt\"=now() WHERE id=$1", [legacyRun])
    await pool.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","issueId","deviceId","snapshotId","operationId",state,"sandboxId") VALUES($1,$2,$3,$4,$5,\'codex\',$6,\'paused\',\'fixture-legacy-sandbox\')', [legacyRun, workspaceId, owner, legacyTask, legacyDevice, randomUUID()])
    for (const file of files.filter(file => file >= boundary)) await pool.query(await readFile(new URL(file, directory), 'utf8'))
    const { resourcePersonalResourcesAllowed, runPersonalResourcesAllowed, runCleanExecutionAllowed, runModelCredentialHistoryAllowed, runResourceContext, recordRunResourceDisclosure } = await import('../lib/run-private-resources')
    const { recordThreadSandbox } = await import('../lib/cloud-computer/thread-machines')
    const executor = drizzle(pool)
    const setPrivate = (kind: string, id: string) => pool.query("UPDATE resource_access_policies SET visibility='private' WHERE kind=$1 AND id=$2", [kind, id])
    const grant = (kind: string, id: string, capabilities: string[], expiresAt: Date | null = null) => pool.query('INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities,"expiresAt") VALUES($1,$2,\'account\',$3,$4,$5)', [kind, id, peer, capabilities, expiresAt])
    const freshMachine = async (runId: string, taskId: string, kind = 'cloud') => {
      const lease = randomUUID(), sandbox = `fixture-${randomUUID()}`, operation = randomUUID()
      await pool.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","issueId","snapshotId","operationId",state,"workerLeaseId") VALUES($1,$2,$3,$4,\'codex\',$5,\'starting\',$6)', [runId, workspaceId, owner, taskId, operation, lease])
      assert.equal(await recordThreadSandbox(pool, runId, sandbox, lease, true), true)
      const deviceId = await makeDevice(kind)
      await pool.query('UPDATE thread_machines SET "deviceId"=$2 WHERE "runId"=$1', [runId, deviceId])
      await pool.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [runId, deviceId])
      return deviceId
    }
    const disclose = async (runId: string, deviceId: string) => executor.transaction(async tx => {
      const context = await runResourceContext(runId, workspaceId, owner, tx)
      return recordRunResourceDisclosure(tx, context, { id: runId, attempt: 1, deviceId })
    })

    await t.test('migration keeps old attempted sessions tainted and old idle machines unknown', async () => {
      assert.deepEqual((await pool.query('SELECT "personalResources",provenance FROM run_resource_disclosures WHERE "runId"=$1', [legacyRun])).rows, [{ personalResources: true, provenance: 'legacy_unknown' }])
      assert.equal((await pool.query('SELECT "resourceIsolation" FROM thread_machines WHERE "runId"=$1', [legacyRun])).rows[0].resourceIsolation, 'legacy_unknown')
      assert.equal(await runCleanExecutionAllowed(pool, legacyRun, legacyDevice), false)
    })
    await t.test('a shared child behind an exclusive Private parent retains personal resources; live parent grants revoke it', async () => {
      const task = await makeTask(), run = await makeRun(task)
      await setPrivate('task', task)
      assert.equal(await resourcePersonalResourcesAllowed(pool, 'task', task, owner), true)
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), true)
      await grant('thread', run, ['canReadContent'])
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), true, 'a leaf grant cannot bypass the private parent')
      await grant('task', task, ['canReadContent', 'canSteer'])
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), false)
      await pool.query('DELETE FROM resource_access_grants WHERE "resourceKind"=\'task\' AND "resourceId"=$1', [task])
      await grant('task', task, ['canViewUsage'])
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), true, 'administrative usage cannot read private content')
      await pool.query('UPDATE resource_access_grants SET capabilities=$2,"expiresAt"=now()-interval \'1 second\' WHERE "resourceKind"=\'task\' AND "resourceId"=$1', [task, ['canReadContent']])
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), true, 'expired content permission is not live authority')
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [run, { executionIdentity: { actor: peer } }])
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), false, 'actual actor is independent from run.userId')
    })
    await t.test('unknown policy, cycles, and another owner private parent never confer personal-resource authority', async () => {
      assert.equal(await resourcePersonalResourcesAllowed(pool, 'task', randomUUID(), owner), false)
      const task = await makeTask(), run = await makeRun(task)
      await setPrivate('thread', run)
      await pool.query('UPDATE resource_access_policies SET "ownerId"=$2,visibility=\'private\' WHERE kind=\'task\' AND id=$1', [task, peer])
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), false)
      await pool.query('UPDATE resource_access_policies SET "parentKind"=\'thread\',"parentId"=$2 WHERE kind=\'task\' AND id=$1', [task, run])
      assert.equal(await resourcePersonalResourcesAllowed(pool, 'thread', run, owner), false)
    })
    await t.test('only a fresh dedicated cloud machine admits a new Shared run, including Owner=Actor', async () => {
      const task = await makeTask(), run = await makeRun(task), device = await freshMachine(run, task)
      assert.equal(await runPersonalResourcesAllowed(pool, run, owner), false)
      assert.equal(await runCleanExecutionAllowed(pool, run, device), true)
      assert.equal(await disclose(run, device), true)
      assert.equal(await disclose(run, device), true, 'the same authorized claim is idempotent')
      assert.equal((await pool.query('SELECT "personalResources" FROM run_resource_disclosures WHERE "runId"=$1', [run])).rows[0].personalResources, false)
      const local = await makeRun(task), localDevice = await freshMachine(local, task, 'local')
      assert.equal(await runCleanExecutionAllowed(pool, local, localDevice), false)
      assert.equal(await disclose(local, localDevice), false)
      await pool.query('UPDATE thread_machines SET "resourceIsolation"=\'legacy_unknown\' WHERE "runId"=$1', [run])
      assert.equal(await runCleanExecutionAllowed(pool, run, device), false, 'a missing current machine attestation cannot be replaced by an old clean run receipt')
    })
    await t.test('a private claim taints its VM permanently and later sharing cannot relabel it', async () => {
      const task = await makeTask(), run = await makeRun(task), device = await freshMachine(run, task)
      await setPrivate('thread', run)
      assert.equal(await disclose(run, device), true)
      assert.equal((await pool.query('SELECT "resourceIsolation" FROM thread_machines WHERE "runId"=$1', [run])).rows[0].resourceIsolation, 'owner_private')
      await assert.rejects(pool.query('UPDATE thread_machines SET "resourceIsolation"=\'shared_clean\' WHERE "runId"=$1', [run]), { code: '23514' })
      await pool.query('UPDATE resource_access_policies SET visibility=\'shared\' WHERE kind=\'thread\' AND id=$1', [run])
      assert.equal(await runCleanExecutionAllowed(pool, run, device), false)
      assert.equal(await disclose(run, device), false, 'Owner=Actor is not an exception')
      await assert.rejects(pool.query('UPDATE run_resource_disclosures SET "personalResources"=false WHERE "runId"=$1', [run]), { code: '23514' })
      await assert.rejects(pool.query('DELETE FROM run_resource_disclosures WHERE "runId"=$1', [run]), { code: '23514' })
      const child = await makeRun(task, null, run), cleanDevice = await freshMachine(child, task)
      assert.equal(await runCleanExecutionAllowed(pool, child, cleanDevice), false, 'a fresh VM still cannot replay a private source session/checkpoint')
      const unrelated = await makeRun(task), otherDevice = await freshMachine(unrelated, task)
      await pool.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [unrelated, device])
      await pool.query('UPDATE thread_machines SET "deviceId"=$2 WHERE "runId"=$1', [unrelated, device])
      assert.notEqual(otherDevice, device)
      assert.equal(await runCleanExecutionAllowed(pool, unrelated, device), false, 'an unrelated run cannot reuse another private attempt\'s device')
    })
    await t.test('legacy, missing disclosure and foreign-tenant source chains fail closed on fresh machines', async () => {
      const legacyChild = await makeRun(legacyTask, null, legacyRun), clean = await freshMachine(legacyChild, legacyTask)
      assert.equal(await runCleanExecutionAllowed(pool, legacyChild, clean), false)
      const task = await makeTask(), unclaimed = await makeRun(task), child = await makeRun(task, null, unclaimed), childDevice = await freshMachine(child, task)
      assert.equal(await runCleanExecutionAllowed(pool, child, childDevice), false)
      const foreignTask = await makeTask(otherWorkspace), foreign = await makeRun(foreignTask, null, null, otherWorkspace)
      await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [child, foreign])
      assert.equal(await runCleanExecutionAllowed(pool, child, childDevice), false)
    })
    await t.test('an old snapshot or unproven model identity cannot be relabeled as a clean Shared execution', async () => {
      const task = await makeTask(), run = await makeRun(task), device = await freshMachine(run, task)
      await pool.query('UPDATE agent_runs SET "agentDefinition"="agentDefinition"-\'contextIsolation\' WHERE id=$1', [run])
      assert.equal(await runCleanExecutionAllowed(pool, run, device), false)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [run, { ...modelDefinition(), executionIdentity: {} }])
      assert.equal(await disclose(run, device), false)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [run, modelDefinition()])
      assert.equal(await disclose(run, device), true)
    })
    await t.test('model receipts retain exact key ownership and reject a different key, owner or unknown historical credential', async () => {
      const task = await makeTask(), run = await makeRun(task), device = await freshMachine(run, task)
      assert.equal(await disclose(run, device), true)
      const scope = { sourceRunId: run, deviceId: device, actorId: peer, executionOwnerId: owner,
        credentialKind: 'api_key' as const, credentialId: modelKeyId, credentialOwnerId: owner }
      assert.equal(await runModelCredentialHistoryAllowed(pool, scope), true, 'matching history is necessary, not a substitute for the separate live collaboration receipt')
      assert.equal(await runModelCredentialHistoryAllowed(pool, { ...scope, credentialId: randomUUID() }), false)
      assert.equal(await runModelCredentialHistoryAllowed(pool, { ...scope, credentialOwnerId: peer }), false)
      assert.deepEqual((await pool.query('SELECT "credentialKind","credentialId","credentialOwnerId" FROM run_resource_disclosures WHERE "runId"=$1', [run])).rows,
        [{ credentialKind: 'api_key', credentialId: modelKeyId, credentialOwnerId: owner }])
      await assert.rejects(pool.query('UPDATE run_resource_disclosures SET "credentialId"=$2 WHERE "runId"=$1', [run, randomUUID()]), { code: '23514' })
      await pool.query('INSERT INTO run_resource_disclosures("runId",attempt,"workspaceId","ownerId","actorId","deviceId","personalResources","policySnapshot",provenance) VALUES($1,2,$2,$3,$3,$4,false,\'old-receipt\',\'claim\')', [run, workspaceId, owner, device])
      assert.equal(await runModelCredentialHistoryAllowed(pool, scope), false, 'a historical receipt without credential provenance stays unknown')
    })
    await t.test('Owner may use a clean native subscription, but replacing the latest model cannot lend its historical session to another actor', async () => {
      const task = await makeTask(), run = await makeRun(task), device = await freshMachine(run, task), bindingId = randomUUID()
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [run, modelDefinition('subscription', bindingId)])
      assert.equal(await runCleanExecutionAllowed(pool, run, device), true)
      assert.equal(await disclose(run, device), true)
      assert.equal((await pool.query('SELECT "personalResources","credentialKind" FROM run_resource_disclosures WHERE "runId"=$1', [run])).rows[0].personalResources, false)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [run, modelDefinition()])
      assert.equal(await disclose(run, device), false, 'the same attempt cannot rewrite its model credential receipt')
      const child = await makeRun(task, null, run), cleanDevice = await freshMachine(child, task)
      assert.equal(await runCleanExecutionAllowed(pool, child, cleanDevice), true, 'the same owner may explicitly select another model account')
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [child, modelDefinition('api_key', modelKeyId, peer)])
      assert.equal(await runCleanExecutionAllowed(pool, child, cleanDevice), false, 'cross-actor source history still contains a personal subscription')
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [child, modelDefinition('native_login', cleanDevice, peer)])
      assert.equal(await runCleanExecutionAllowed(pool, child, cleanDevice), false, 'native login is never a delegated model credential')
    })
  } finally {
    await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  }
})
