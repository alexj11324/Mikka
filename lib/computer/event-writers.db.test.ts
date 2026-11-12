import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, beforeEach, mock, test } from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import type { LiveScope } from '../live/scope'
import type { LiveInvalidation } from '../live/events'
import type { ComputerEventPage } from './event-page'
import type { VisualObservation } from '../cloud-computer/visual-contract'
import type { judgeVisualBrowserAction } from '../cloud-computer/visual-model'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer event writer database required')
if (databaseURL && !isE2eTarget(databaseURL)) throw new Error('Computer event writer tests require an isolated loopback e2e database')
const schema = `event_writers_${randomUUID().replaceAll('-', '')}`
const actor = { userId: 'event-writer-owner', workspaceId: randomUUID() }
const botId = randomUUID()
let admin: Pool, pool: Pool, observer: Pool
let store: InstanceType<typeof import('../cloud-computer/subagents').SubagentStore>
let browserAction: typeof import('../cloud-computer/action-reviews').browserAction
let proposeCredentialOperation: typeof import('../cloud-computer/credential-reviews').proposeCredentialOperation
let readComputerEvents: typeof import('./event-log').readComputerEvents
type Notice = { scope: LiveScope; events: LiveInvalidation[]; page: ComputerEventPage }
let notices: Notice[] = []
let probes: Promise<void>[] = []
let runtimeCalls = 0
const target = {
  targetId: 'fixture-target', origin: 'https://example.invalid', endpoint: 'https://fixture.invalid', expiresAt: Date.now() + 600_000,
  observedInputs: [{ backendNodeId: 12, credentialRole: 'password' as const, loaderId: 'fixture-document', epoch: 1, permissionVersion: 0 }],
}

before(async () => {
  if (!databaseURL) return
  admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, max: 6 })
  observer = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, max: 2 })
  // The observer is a different real PostgreSQL connection. Holding COMMIT until
  // already-issued probes settle makes a mistakenly early notification reliably
  // observe the old committed snapshot, rather than occasionally winning a race.
  pool.on('connect', client => {
    const query = client.query
    client.query = ((...args: unknown[]) => args[0] === 'COMMIT'
      ? Promise.all(probes).then(() => Reflect.apply(query, client, args))
      : Reflect.apply(query, client, args)) as typeof client.query
  })
  await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE agent_runs(id uuid PRIMARY KEY);
    CREATE TABLE devices(id uuid PRIMARY KEY); CREATE TABLE suggestions(id uuid PRIMARY KEY,"botId" uuid);
    CREATE TABLE device_repos(id uuid PRIMARY KEY)`)
  await pool.query('INSERT INTO "user" VALUES ($1)', [actor.userId])
  for (const name of ['20261027164501_cloud_computers.sql', '20261029011635_subagents_thread_machines.sql', '20261029080000_unattended_browser_runtime.sql', '20261029080001_owner_cloud_machines.sql']) {
    await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
  }
  await pool.query(`CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY,permission text DEFAULT 'allow',version bigint DEFAULT 0,external_write_permissions jsonb DEFAULT '{}',external_write_policy_version bigint DEFAULT 0);
    CREATE TABLE agent_kit_heads(owner_id text,bot_id uuid,workspace_id uuid,external_write_permissions jsonb DEFAULT '{}',external_write_policy_version bigint DEFAULT 0);
    CREATE TABLE pending_actions(id uuid PRIMARY KEY,"botId" uuid,"userId" text NOT NULL,action text NOT NULL,input jsonb NOT NULL,status text DEFAULT 'pending',"createdAt" timestamptz DEFAULT now(),"decidedAt" timestamptz,result jsonb,error text);
    CREATE FUNCTION reject_fixture_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event->'data'->>'task'='event-write-must-rollback' THEN RAISE EXCEPTION 'fixture event write rejected'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER reject_fixture_event BEFORE INSERT ON subagent_events FOR EACH ROW EXECUTE FUNCTION reject_fixture_event()`)
  await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)', [botId, actor.userId, actor.workspaceId, 'Fixture'])
  await pool.query('INSERT INTO agent_kit_heads(owner_id,bot_id,workspace_id) VALUES($1,$2,$3)', [actor.userId, botId, actor.workspaceId])
  await pool.query('INSERT INTO workspace_computer_policies("workspaceId") VALUES($1)', [actor.workspaceId])
  await pool.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","sandboxId",state,"runtimeReady") VALUES($1,$2,$3,$4,$5,true)', [actor.workspaceId, actor.userId, randomUUID(), 'fixture-machine', 'running'])
  mock.module('@/lib/live/notify', { namedExports: {
    ...await import('@/lib/live/notify'),
    notifyLive(scope: LiveScope, events: LiveInvalidation[]) {
      const probe = readComputerEvents(observer, scope, '0').then(page => { notices.push({ scope, events, page }) })
      probes.push(probe)
    },
  } })
  // Only external compute/runtime and subscription service boundaries are fixtures.
  // The actual four writer methods, permission/row locks, event inserts and COMMIT run.
  mock.module('@/lib/computer/provision', { namedExports: { ensureCloudMachine: async () => ({ sandboxId: 'fixture-machine' }) } })
  mock.module('@/lib/subscription-runtime', { namedExports: {
    authorizeSubscriptionWorkspace: async (owner: string, workspace: string) => {
      assert.equal(owner, actor.userId); assert.equal(workspace, actor.workspaceId)
    },
  } })
  mock.module('@/lib/cloud-computer/runtime', { namedExports: {
    installSubagentRuntime: async () => undefined,
    runtimeRequest: async (_sandbox: string, _row: unknown, path: string, body: { actionId?: string }) => {
      runtimeCalls++
      if (path === '/start') return { targetId: target.targetId }
      if (path === '/action') return { accepted: true, actionId: body.actionId }
      if (path === '/stop') return {}
      throw new Error('Unexpected external runtime request')
    },
    grant: async () => { throw new Error('Unexpected credential continuation') },
    endpointPath: (endpoint: string, path: string) => endpoint + path,
  } })
  readComputerEvents = (await import('./event-log')).readComputerEvents
  store = new (await import('../cloud-computer/subagents')).SubagentStore(pool)
  browserAction = (await import('../cloud-computer/action-reviews')).browserAction
  proposeCredentialOperation = (await import('../cloud-computer/credential-reviews')).proposeCredentialOperation
})

beforeEach(async () => {
  if (!databaseURL) return
  await Promise.all(probes); probes = []; notices = []; runtimeCalls = 0
  await pool.query(`TRUNCATE bot_subagents CASCADE; DELETE FROM pending_actions;
    UPDATE workspace_computer_policies SET permission='allow',version=0,external_write_permissions='{}'`)
})

after(async () => {
  if (!databaseURL) return
  await Promise.all(probes)
  await observer.end(); await pool.end()
  await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
})

async function task(status = 'queued', title = 'Read public documentation') {
  const row = await store.create(actor, botId, title)
  if (status !== 'queued') await pool.query('UPDATE bot_subagents SET status=$2,"targetId"=$3 WHERE id=$1', [row.id, status, target.targetId])
  return row.id
}
async function notice(expectedCount: number, expectedState: string) {
  await Promise.all(probes)
  assert.equal(notices.length, expectedCount)
  const latest = notices.at(-1)!
  assert.deepEqual(latest.scope, { ownerId: actor.userId, workspaceId: actor.workspaceId })
  assert.deepEqual(latest.events, [{ kind: 'subagent_events', id: actor.workspaceId }], 'push carries no business content')
  assert.equal(latest.page.events.length, expectedCount, 'every notification observes its committed append on another connection')
  assert.equal((latest.page.events.at(-1)!.data as { state: string }).state, expectedState)
}

test('actual SubagentStore publishes queued stop, denied start and runtime start only after commit', { skip: !databaseURL }, async () => {
  const stopped = await task()
  assert.equal((await store.stop(actor, botId, stopped)).status, 'stopped')
  await notice(1, 'stopped')
  await store.stop(actor, botId, stopped)
  await Promise.all(probes); assert.equal(notices.length, 1, 'terminal replay does not append or notify')
  await assert.rejects(store.stop({ ...actor, userId: 'other-owner' }, botId, stopped), { status: 404 })
  const denied = await task()
  await pool.query("UPDATE workspace_computer_policies SET permission='deny'")
  assert.equal((await store.start(actor, botId, denied)).status, 'failed')
  await notice(2, 'failed'); assert.equal(runtimeCalls, 0, 'denied work never provisions or starts runtime')
  await pool.query("UPDATE workspace_computer_policies SET permission='allow'")
  const started = await task()
  assert.equal((await store.start(actor, botId, started)).status, 'running')
  await notice(3, 'running'); assert.equal(runtimeCalls, 1)
})

test('actual SubagentStore commits terminal suggestion updates with the event; failed event rolls both back', { skip: !databaseURL }, async () => {
  const id = await task('running')
  const suggestionId = randomUUID()
  await pool.query('INSERT INTO suggestions(id,"botId") VALUES($1,$2)', [suggestionId, botId])
  await pool.query('INSERT INTO suggestion_executions("suggestionId","ownerId","workspaceId",instruction,status,"subagentId") VALUES($1,$2,$3,$4,$5,$6)', [suggestionId, actor.userId, actor.workspaceId, 'Fixture', 'running', id])
  await store.update(actor, botId, id, 'done', 'Reviewed documentation')
  await notice(1, 'done')
  assert.equal((await observer.query('SELECT status FROM suggestion_executions WHERE "suggestionId"=$1', [suggestionId])).rows[0].status, 'done')
  const failed = await task('running', 'event-write-must-rollback')
  const rejectedSuggestion = randomUUID()
  await pool.query('INSERT INTO suggestions(id,"botId") VALUES($1,$2)', [rejectedSuggestion, botId])
  await pool.query('INSERT INTO suggestion_executions("suggestionId","ownerId","workspaceId",instruction,status,"subagentId") VALUES($1,$2,$3,$4,$5,$6)', [rejectedSuggestion, actor.userId, actor.workspaceId, 'Fixture', 'running', failed])
  await assert.rejects(store.update(actor, botId, failed, 'done', 'Must not publish'), /fixture event write rejected/)
  assert.equal((await store.get(actor, botId, failed)).status, 'running')
  assert.equal((await observer.query('SELECT status FROM suggestion_executions WHERE "suggestionId"=$1', [rejectedSuggestion])).rows[0].status, 'running')
  await Promise.all(probes); assert.equal(notices.length, 1)
})

test('actual queued stop rolls back its state and sends no notification when event insertion fails', { skip: !databaseURL }, async () => {
  const id = await task('queued', 'event-write-must-rollback')
  await assert.rejects(store.stop(actor, botId, id), /fixture event write rejected/)
  assert.equal((await store.get(actor, botId, id)).status, 'queued')
  await Promise.all(probes); assert.equal(notices.length, 0)
  assert.equal((await readComputerEvents(observer, { ownerId: actor.userId, workspaceId: actor.workspaceId }, '0')).events.length, 0)
})

test('actual credential proposal commits approval and event together; rollback leaves neither', { skip: !databaseURL }, async () => {
  const id = await task('running')
  assert.equal((await proposeCredentialOperation(pool, { ...actor, botId, subagentId: id }, target, 'fill')).status, 'needs_approval')
  await notice(1, 'needs_you')
  assert.equal((await observer.query('SELECT count(*)::int AS count FROM pending_actions')).rows[0].count, 1)
  const rejected = await task('running', 'event-write-must-rollback')
  await assert.rejects(proposeCredentialOperation(pool, { ...actor, botId, subagentId: rejected }, target, 'fill'), /fixture event write rejected/)
  assert.equal((await store.get(actor, botId, rejected)).status, 'running')
  assert.equal((await observer.query('SELECT count(*)::int AS count FROM pending_actions')).rows[0].count, 1)
  await Promise.all(probes); assert.equal(notices.length, 1)
})

test('actual browser action commits its event before notification and external action; rollback prevents action', { skip: !databaseURL }, async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, ...Array.from({ length: 40 }, () => 0), 0xff, 0xd9])
  const imageDigest = createHash('sha256').update(bytes).digest('hex')
  const observation: VisualObservation = { observationId: 'a'.repeat(32), loaderId: target.observedInputs[0].loaderId, origin: target.origin, observedAt: Date.now(), screenshot: 'data:image/jpeg;base64,' + bytes.toString('base64'), width: 1280, height: 800, observation: { url: target.origin, title: 'Fixture', text: 'Fixture', elements: [], needsLogin: false } }
  const judgment: Awaited<ReturnType<typeof judgeVisualBrowserAction>> = { scope: 'within_task', effect: 'browse', execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'synthetic-provider', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'b'.repeat(64), imageDigests: [imageDigest], vision: 'image-input-submitted' } }
  const perform = (id: string) => browserAction(pool, actor, botId, id, { action: 'click', x: 20, y: 40 }, 'Open documentation', observation, judgment)
  assert.equal((await perform(await task('running'))).state, 'running')
  await notice(1, 'running'); assert.equal(runtimeCalls, 1)
  const rejected = await task('running', 'event-write-must-rollback')
  await assert.rejects(perform(rejected), /fixture event write rejected/)
  const row = await store.get(actor, botId, rejected)
  assert.equal(row.status, 'running'); assert.equal(row.activeActionId, null)
  assert.equal((await observer.query('SELECT count(*)::int AS count FROM pending_actions')).rows[0].count, 1)
  await Promise.all(probes); assert.equal(notices.length, 1); assert.equal(runtimeCalls, 1)
})
