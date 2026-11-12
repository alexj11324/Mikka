import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { reconcileDue } from './reconcile-due'
import { cleanupWorkspaceEphemera } from './coding-workspace/retention'

// #1371: the one safety-net check. It is true for a job only when that job has
// work already due that its own wake or timer did not pick up, and false on an
// idle database. Tables are copied into a private schema so the answer is this test's.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Reconcile tests require matching isolated loopback _e2e URLs')

const TABLES = ['coordinator_events', 'coordinator_sessions', 'user_schedules', 'schedule_occurrences', 'agent_runs', 'devices', 'cloud_machines',
  'thread_machines', 'coding_review_sessions', 'issues', 'sandbox_kill_retries', 'group_turns', 'group_task_bindings', 'factory_tasks', 'factory_attempts', 'factory_events',
  'factory_deliverable_acceptances', 'factory_candidates', 'factory_merges', 'account_deletion_jobs', 'chat_attachments', 'chat_attachment_retirements',
  'workspace_audit_retention', 'workspace_audit_events', 'workspace_deletions', 'workspace_audit_outbox', 'mobile_push_receipts', 'coding_workspace_requests', 'coding_workspace_mentions']

test('the safety-net check names exactly the jobs with work already due', { skip: !valid }, async t => {
  const schema = `reconcile_due_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of TABLES) await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
  // LIKE copies the origin column's NOT NULL, but not its generating trigger.
  // Reuse the installed production function instead of hard-coding a seed key.
  const originTrigger = (await admin.query<{ definition: string }>(`SELECT pg_get_triggerdef(oid) AS definition
    FROM pg_trigger WHERE tgrelid='public.user_schedules'::regclass AND tgname='schedule_request_origin'`)).rows[0]
  if (originTrigger) await admin.query(originTrigger.definition.replace('ON public.user_schedules ', `ON ${schema}.user_schedules `))
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 2 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  const due = (factoryLifecycle = true) => reconcileDue(pool, { factoryLifecycle, workspace: pool })
  const none = { wakes: false, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }
  const clear = async () => { for (const table of TABLES) await pool.query(`DELETE FROM ${table}`) }
  const event = (values: string) => pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,"nextWakeAt","wakeLeaseUntil",tier,"deliveredAt") VALUES ($1,'owner',$2,'user_message',$3,'{}',${values})`, [randomUUID(), randomUUID(), randomUUID()])

  await t.test('idle: nothing is due, so the sweep does nothing else', async () => {
    assert.deepEqual(await due(), none)
  })

  await t.test('a pending wake whose start was lost is due; one leased, delivered, background or in the future is not', async () => {
    await event(`now()+interval '1 minute',NULL,NULL,NULL`)
    await event(`now()-interval '1 minute',now()+interval '1 minute',NULL,NULL`)
    await event(`now()-interval '1 minute',NULL,NULL,now()`)
    await event(`now()-interval '1 minute',NULL,'background',NULL`)
    assert.deepEqual(await due(), none)
    await event(`now()-interval '1 minute',now()-interval '1 second',NULL,NULL`)
    assert.deepEqual(await due(), { ...none, wakes: true })
    await clear()
  })

  await t.test('a turn holding a chat lease is checked for an interrupted run', async () => {
    await pool.query(`INSERT INTO coordinator_sessions ("userId","botId","leaseHolder","leaseUntil") VALUES ('owner',$1,'wrun_fixture',now()+interval '5 minutes')`, [randomUUID()])
    assert.deepEqual(await due(), { ...none, wakes: true })
    await clear()
  })

  await t.test('schedule work is due at or after its time, not before', async () => {
    const insert = (at: string) => pool.query(`INSERT INTO user_schedules (id,owner_id,source_event_id,request_id,definition,request_definition,status,next_at) VALUES ($1,'owner',$2,$3,'{}','{}','active',${at})`, [randomUUID(), randomUUID(), randomUUID()])
    await insert(`now()+interval '10 minutes'`)
    assert.deepEqual(await due(), none)
    await insert(`now()-interval '1 second'`)
    assert.deepEqual(await due(), { ...none, schedules: true })
    await clear()
  })

  await t.test('run recovery is due for an expired lease, not for a live one', async () => {
    const run = (lease: string) => pool.query(`INSERT INTO agent_runs (id,"userId","agentId",kind,status,"leaseExpiresAt") VALUES ($1,'owner',$2,'local','running',${lease})`, [randomUUID(), randomUUID()])
    await run(`now()+interval '5 minutes'`)
    assert.deepEqual(await due(), none)
    await run(`now()-interval '1 second'`)
    assert.deepEqual(await due(), { ...none, recovery: true })
    await clear()
  })
  await t.test('a revoked review lease with a near close retry needs recovery even with Factory off', async () => {
    const id = randomUUID()
    await pool.query(`INSERT INTO coding_review_sessions
      (id,kind,"taskId","runId","ownerId","workspaceId","deviceId","repoId","deviceTokenId","bindingId","sandboxId",
       "machineEpoch","machineOperationId","credentialKind","credentialId","expiresAt")
      VALUES ($1,'terminal',$1,$1,'owner',$1,$1,$1,$1,$2,'fixture',0,$1,'session','credential',now()+interval '5 minutes')`,
    [id, 'a'.repeat(64)])
    assert.deepEqual(await due(false), none)
    await pool.query(`UPDATE coding_review_sessions SET "revokedAt"=now(),reason='run_control',"retryAt"=now()+interval '30 seconds' WHERE id=$1`, [id])
    assert.deepEqual(await due(false), { ...none, recovery: true })
    await pool.query('DELETE FROM coding_review_sessions WHERE id=$1', [id])
    assert.deepEqual(await due(false), none)
  })
  await t.test('an account deletion is due once requested; a retired object at its notBefore', async () => {
    await pool.query(`INSERT INTO chat_attachment_retirements ("storageKey","userId","notBefore") VALUES ('key','owner',now()+interval '5 minutes')`)
    assert.deepEqual(await due(), none)
    await pool.query(`INSERT INTO account_deletion_jobs (id,"subjectUserId","subjectEmailHash",stage) VALUES ($1,'subject',$2,'requested')`, [randomUUID(), 'a'.repeat(64)])
    assert.deepEqual(await due(), { ...none, deletions: true })
    await clear()
  })
  await t.test('audit work is due for an expired event or an undelivered receipt (checked on the workspace database)', async () => {
    const ws = randomUUID()
    await pool.query(`INSERT INTO workspace_audit_retention ("workspaceId","retentionDays","legalHold","configuredBy") VALUES ($1,30,false,'admin')`, [ws])
    await pool.query(`INSERT INTO workspace_audit_events (id,"workspaceId","actorType","actorName",action,category,"createdAt") VALUES ($1,$2,'system','System','audit.test','audit',now()-interval '10 days')`, [randomUUID(), ws])
    assert.deepEqual(await due(), none)
    await pool.query(`UPDATE workspace_audit_events SET "createdAt"=now()-interval '40 days'`)
    assert.deepEqual(await due(), { ...none, audit: true })
    await clear()
    await pool.query(`INSERT INTO workspace_audit_outbox (id,"workspaceId") VALUES ($1,$2)`, [randomUUID(), randomUUID()])
    assert.deepEqual(await due(), { ...none, audit: true })
    assert.deepEqual(await reconcileDue(pool, { factoryLifecycle: true }), none, 'without the workspace database the outbox is not read')
    await clear()
  })
  await t.test('a push receipt is due after its lost wake, excluding a live lease or future check', async () => {
    await pool.query("INSERT INTO mobile_push_receipts(id,user_id,provider,secret,next_check_at) VALUES($1,'owner','cloud','{}',now()+interval '15 minutes')", [randomUUID()])
    assert.deepEqual(await due(), none)
    await pool.query("UPDATE mobile_push_receipts SET next_check_at=now()-interval '1 second',lease_until=now()+interval '2 minutes'")
    assert.deepEqual(await due(), none)
    await pool.query("UPDATE mobile_push_receipts SET lease_until=now()-interval '1 second'")
    assert.deepEqual(await due(), { ...none, pushReceipts: true })
    await clear()
  })
  await t.test('workspace crash residues expire through the existing sweep without deleting live references', async () => {
    const expired = randomUUID(), live = randomUUID()
    for (const [id, ttl] of [[expired, '-1 second'], [live, '5 minutes']]) {
      await pool.query(`INSERT INTO coding_workspace_mentions(id,"ownerId","workspaceId","runId","repoId","bindingId",files,"expiresAt")
        VALUES($1,'owner',$2,$3,$4,'binding','[{}]',now()+$5::interval)`, [id, randomUUID(), randomUUID(), randomUUID(), ttl])
      await pool.query(`INSERT INTO coding_workspace_requests(id,"ownerId","workspaceId","runId","repoId","deviceId","tokenId",identity,request,"expiresAt")
        VALUES($1,'owner',$2,$3,$4,$5,$6,'{}','{}',now()+$7::interval)`, [id, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), ttl])
    }
    assert.deepEqual(await due(), { ...none, workspaceEphemera: true })
    assert.deepEqual(await cleanupWorkspaceEphemera(pool), { requests: 1, mentions: 1 })
    for (const table of ['coding_workspace_requests', 'coding_workspace_mentions'])
      assert.deepEqual((await pool.query(`SELECT id FROM ${table}`)).rows, [{ id: live }])
    assert.deepEqual(await due(), none)
    await clear()
  })
})
