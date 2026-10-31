import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cancelAccountDeletion, exportAccountDeletionManifest, readAccountDeletion, requestAccountDeletion, resumeAccountDeletion } from './deletion-jobs'

// Only disposable, matching loopback targets pass the shared fixture's guard.
test('durable deletion stages preserve data until authorization/cleanup and resume after real DB/object failures', { skip: !dbUrl }, async t => {
  const main = new Pool({ connectionString: dbUrl, max: 5 }), workspace = new Pool({ connectionString: dbUrl, max: 5 })
  const options = { mainPool: main, workspacePool: workspace, externalCleanup: async () => [] as string[] }
  t.after(async () => { await Promise.all([main.end(), workspace.end()]) })
  const tracked = new Set<string>()
  const fact = (userId: string) => main.query(`INSERT INTO user_facts(id,"userId",kind,subject,"subjectKey",confidence,"firstSeenAt","lastSeenAt") VALUES($1,$2,'interest','test',$3,0.5,now(),now())`, [randomUUID(), userId, randomUUID()])
  const request = async (userId: string) => {
    const requested = await requestAccountDeletion(userId, `${userId}@example.invalid`, randomUUID(), options)
    assert.equal(requested.ok, true)
    if (!requested.ok) throw new Error('unexpected refusal')
    tracked.add(requested.id)
    return requested.id
  }
  await t.test('sole admin refusal changes no account data; a requested deletion can be cancelled only by its owner', async () => {
    const owner = await seedUser(main, 'delete-admin'), peer = await seedUser(main, 'delete-peer')
    const ws = await seedWorkspace(workspace, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
    assert.deepEqual(await requestAccountDeletion(owner, `${owner}@example.invalid`, randomUUID(), options), { ok: false, soleAdminOf: [ws.name] })
    await fact(owner)
    assert.equal((await main.query('SELECT count(*)::int n FROM account_deletion_guards WHERE "subjectId"=$1', [owner])).rows[0].n, 0)
    await workspace.query('UPDATE mikka_workspace_members SET role=\'admin\' WHERE "workspaceId"=$1 AND "userId"=$2', [ws.id, peer])
    const id = await request(owner)
    await assert.rejects(readAccountDeletion(peer, id, options), /accountDeletionUnavailable/)
    await assert.rejects(cancelAccountDeletion(peer, id, options), /accountDeletionUnavailable/)
    await assert.rejects(fact(owner), /account_deletion_pending/)
    assert.equal(await cancelAccountDeletion(owner, id, options), true)
    await fact(owner)
  })
  await t.test('owner-filtered external cleanup must acknowledge success before local secrets/mappings disappear', async () => {
    const user = await seedUser(main, 'delete-external'), id = await request(user)
    await assert.rejects(fact(user), /account_deletion_pending/)
    const blocked = await resumeAccountDeletion(id, { ...options, externalCleanup: async () => ['subscription_custody_cleanup_required'] })
    assert.equal(blocked.stage, 'external_pending')
    assert.equal((await main.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [user])).rows[0].n, 1)
    assert.equal(await cancelAccountDeletion(user, id, options), false)
    assert.equal((await resumeAccountDeletion(id, options)).stage, 'completed')
    assert.equal((await resumeAccountDeletion(id, options)).stage, 'completed')
    assert.equal((await main.query('SELECT count(*)::int n FROM account_deletion_guards WHERE "subjectId"=$1', [user])).rows[0].n, 1, 'restore suppression outlives the user row')
    await assert.rejects(fact(user), /account_deletion_pending/)
  })
  await t.test('a failed object DELETE stays pending and is retried from the committed object list', async () => {
    const user = await seedUser(main, 'delete-object'), key = `${user}/orphaned-old-avatar.png`
    await main.query('INSERT INTO account_storage_retirements("userId","storageKey") VALUES($1,$2)', [user, key])
    const id = await request(user), seen: string[] = []
    const failed = await resumeAccountDeletion(id, { ...options, deleteObject: async name => { seen.push(name); throw new Error('unavailable') } })
    assert.equal(failed.stage, 'storage_pending'); assert.deepEqual(failed.pendingObjects, [key])
    assert.equal((await main.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [user])).rows[0].n, 0)
    const complete = await resumeAccountDeletion(id, { ...options, deleteObject: async name => { seen.push(name) } })
    assert.equal(complete.stage, 'completed'); assert.deepEqual(complete.pendingObjects, [])
    assert.deepEqual(seen, [key, key])
  })
  await t.test('outstanding capture upload grants delay final object deletion and staging keys are retained', async () => {
    const user = await seedUser(main, 'delete-upload'), agent = await seedAgent(main, user), run = await seedRun(main, { userId: user, agentId: agent })
    const capture = randomUUID(), expires = new Date(Date.now() + 60_000), verified = `${user}/verified.png`
    await main.query(`INSERT INTO run_captures(id,"userId","runId",kind,"contentType",source,status,title,"storageKey",size,sha256,"expiresAt") VALUES($1,$2,$3,'image','image/png','local','ready','Capture',$4,1,'abc',$5)`, [capture, user, run, verified, expires])
    const id = await request(user), removed: string[] = []
    const waiting = await resumeAccountDeletion(id, { ...options, deleteObject: async key => { removed.push(key) } })
    assert.equal(waiting.stage, 'storage_pending'); assert.deepEqual(waiting.blockedReasons, ['upload_grants_not_expired'])
    assert.equal(removed.length, 0)
    const staging = `capture-uploads/${user}/runs/${run}/captures/${capture}.png`
    assert.deepEqual([...waiting.pendingObjects].sort(), [verified, staging].sort())
    assert.equal((await resumeAccountDeletion(id, { ...options, now: () => new Date(expires.getTime() + 1), deleteObject: async key => { removed.push(key) } })).stage, 'completed')
    assert.deepEqual(removed.sort(), [verified, staging].sort())
  })
  await t.test('a failed workspace commit keeps the main-deleted phase and survives a new pool/process', async () => {
    const user = await seedUser(main, 'delete-workspace'), ws = await seedWorkspace(workspace, user, [{ userId: user, role: 'admin' }])
    const outsider = await seedUser(main, 'delete-outsider'), id = await request(user)
    await assert.rejects(workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [ws.id, outsider, `${outsider}@example.invalid`]), /account_deletion_pending/)
    const suffix = randomUUID().replaceAll('-', ''), fn = `deletion_fail_${suffix}`
    await workspace.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${ws.id}'::uuid THEN RAISE EXCEPTION 'simulated_workspace_failure'; END IF; RETURN OLD; END $$`)
    await workspace.query(`CREATE TRIGGER ${fn} BEFORE DELETE ON mikka_workspaces FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    try {
      await assert.rejects(resumeAccountDeletion(id, options), (error: unknown) => String((error as { cause?: unknown }).cause).includes('simulated_workspace_failure'))
      assert.equal((await readAccountDeletion(user, id, options)).stage, 'main_deleted')
      assert.equal((await main.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [user])).rows[0].n, 0)
      assert.equal((await workspace.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [ws.id])).rows[0].n, 1)
    } finally {
      await workspace.query(`DROP TRIGGER ${fn} ON mikka_workspaces`); await workspace.query(`DROP FUNCTION ${fn}()`)
    }
    const restarted = new Pool({ connectionString: dbUrl, max: 4 })
    try { assert.equal((await resumeAccountDeletion(id, { ...options, mainPool: restarted })).stage, 'completed') }
    finally { await restarted.end() }
    assert.equal((await workspace.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [ws.id])).rows[0].n, 0)
  })
  await t.test('request waits for an in-flight owner write, then rejects later INSERTs even on owner tables without FKs', async () => {
    const user = await seedUser(main, 'delete-race'), writer = await main.connect()
    await writer.query('BEGIN')
    await writer.query('SELECT mikka_account_assert_writable($1)', [user])
    await writer.query(`INSERT INTO user_facts(id,"userId",kind,subject,"subjectKey",confidence,"firstSeenAt","lastSeenAt") VALUES($1,$2,'interest','racing','racing',0.5,now(),now())`, [randomUUID(), user])
    let settled = false
    const pending = request(user).finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 75))
    assert.equal(settled, false, 'deletion barrier waits for the open writer transaction')
    await writer.query('COMMIT'); writer.release()
    const id = await pending
    await assert.rejects(fact(user), /account_deletion_pending/)
    assert.equal((await resumeAccountDeletion(id, options)).stage, 'completed')
    assert.equal((await main.query('SELECT count(*)::int n FROM user_facts WHERE "userId"=$1', [user])).rows[0].n, 0)
  })
  await t.test('journal export survives JSON serialization and carries no credentials/email/content', async () => {
    const manifest = await exportAccountDeletionManifest(options)
    assert.equal(JSON.parse(JSON.stringify(manifest)).digest, manifest.digest)
    assert.equal(manifest.jobs.filter(job => tracked.has(job.id)).every(job => job.stage === 'completed'), true)
    assert.equal(JSON.stringify(manifest).includes('@example.invalid'), false)
    assert.equal(manifest.jobs.every(job => job.retentionUntil === null), true, 'no arbitrary retention policy')
  })
})
