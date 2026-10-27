/** Explicit live acceptance only. Uses the production store/provider with an
 * isolated local PostgreSQL schema; never production user/session data.
 * Requires E2B_API_KEY, E2B_COMPUTER_TEMPLATE, COMPUTER_TEST_DATABASE_URL.
 * No subscription inference, product OAuth or UI acceptance is implied.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { ComputerStore } from '../../lib/computer/store'
import { ensureContainerRuntime } from '../../lib/computer/e2b-provider'
import { bindComputerRun } from '../../lib/computer/run-binding'
import { decideComputerReview, syncComputerReviews } from '../../lib/computer/reviews'
import { ComputerBroker } from '../../packages/daemon/src/computer/broker.mjs'
import { applyWebComputerDecisions, webComputerSnapshots } from '../../packages/daemon/src/computer/web-review'

async function main() {
  const url = new URL(process.env.COMPUTER_TEST_DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'disposable local database only')
  assert.ok(process.env.E2B_API_KEY && process.env.E2B_COMPUTER_TEMPLATE)
  const schema = `computer_live_${randomUUID().replaceAll('-', '')}`
  const connection = { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` })
  let sandbox: Sandbox | undefined
  try {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'acceptance-owner\')')
    await pool.query(await readFile(new URL('../../drizzle/20261027040500_cloud_computers.sql', import.meta.url), 'utf8'))
    await pool.query('CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, status text NOT NULL, "deviceId" uuid, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz)')
    await pool.query('CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, enabled boolean NOT NULL DEFAULT true)')
    await pool.query(await readFile(new URL('../../drizzle/20261027040501_computer_run_bindings.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027040509_local_computer_reviews.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027040512_computer_run_approvals.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027040514_workspace_computer_policy.sql', import.meta.url), 'utf8'))
    const store = new ComputerStore(pool)
    const actor = { userId: 'acceptance-owner', workspaceId: randomUUID() }
    const bot = await store.createBot(actor, 'E2B acceptance')
    await store.operate(actor, bot.id, 'wake')
    console.log('live stage: provisioned')
    const id = (await pool.query('SELECT "sandboxId" FROM cloud_machines')).rows[0].sandboxId
    sandbox = await Sandbox.connect(id, connection)
    const ingress = await fetch(`https://${sandbox.getHost(6080)}/vnc`, { signal: AbortSignal.timeout(15_000) })
    assert.equal(ingress.status, 401, 'public viewer requires a grant')
    console.log('live stage: public viewer denies anonymous traffic')
    if (process.env.E2B_TEST_CONTAINERS === '1') {
      await ensureContainerRuntime(sandbox)
      await ensureContainerRuntime(sandbox)
      const runner = await sandbox.commands.run('docker --host=unix:///run/mikka-container/docker.sock info >/dev/null 2>&1', { user: 'mikka-runner' })
      assert.equal(runner.exitCode, 0)
      const access = await sandbox.commands.run('if test -r /run/mikka-container/docker.sock || test -w /run/mikka-container/docker.sock; then exit 1; fi', { user: 'user' })
      assert.equal(access.exitCode, 0)
      console.log('live stage: trusted non-root runner and isolated task account verified')
    }
    const rawCDP = await fetch(`https://${sandbox.getHost(9201)}/json/version`, { signal: AbortSignal.timeout(15_000) })
    assert.ok([502, 503].includes(rawCDP.status), 'no public CDP listener')
    console.log('live stage: public CDP unavailable')
    const listeners = await sandbox.commands.run("ss -ltnp | grep -E 'x11vnc|chromium' || true", { user: 'root' })
    assert.equal(listeners.stdout.trim(), '', `Unexpected desktop TCP listener: ${listeners.stdout}`)
    console.log('live stage: no raw TCP desktop listeners')
    await sandbox.files.write('/opt/mikka/computer/viewer-probe.py', await readFile(new URL('./viewer-probe.py', import.meta.url), 'utf8'), { user: 'root' })
    await sandbox.commands.run('/usr/bin/python3 /opt/mikka/computer/viewer-probe.py', { user: 'root', timeoutMs: 30_000 })
    console.log('live stage: real pixels and control verified')
    assert.equal((await store.state(actor, bot.id)).machine, 'running')
    const view = await store.operate(actor, bot.id, 'viewer')
    assert.ok(view?.url.startsWith('wss://'))
    await assert.rejects(store.operate({ ...actor, userId: 'different-owner' }, bot.id, 'takeover'), { status: 404 })
    await assert.rejects(store.operate(actor, bot.id, 'viewer', 'control'), { status: 403 })
    assert.equal((await store.state(actor, bot.id)).machine, 'running', 'rejected control must not report a machine failure')
    await store.operate(actor, bot.id, 'takeover')
    assert.equal((await store.state(actor, bot.id)).control, 'user')
    await store.operate(actor, bot.id, 'handback')
    assert.equal((await store.state(actor, bot.id)).control, 'agent')
    // Real database decision -> broker -> pinned CUA driver in the E2B desktop.
    // The click is a fixed test action on a disposable blank desktop.
    const runId = randomUUID(), deviceId = randomUUID()
    await pool.query('INSERT INTO devices (id,"ownerId") VALUES ($1,$2)', [deviceId, actor.userId])
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"deviceId") VALUES ($1,$2,$3,$4)', [runId, actor.userId, 'queued', deviceId])
    await bindComputerRun(pool, actor, runId, bot.id)
    await pool.query('UPDATE agent_runs SET status=$2,"leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [runId, 'running'])
    await sandbox.files.write('/tmp/mikka-cua-driver.mjs', await readFile(new URL('../../packages/daemon/src/computer/driver.mjs', import.meta.url), 'utf8'), { user: 'user' })
    await sandbox.files.write('/tmp/mikka-cua-live.mjs', `import { detectComputerDriver, executeDriver } from './mikka-cua-driver.mjs';\nconst driver = await detectComputerDriver('/opt/mikka/computer/cua-driver');\nif (!driver) throw new Error('driver unavailable');\nawait executeDriver(driver, { name: 'click', arguments: { x: 500, y: 500 } }, ':1');\n`, { user: 'user' })
    const activeSandbox = sandbox
    let executed = 0
    const broker = new ComputerBroker({ socketPath: `/tmp/unused-e2b-${randomUUID()}`,
      driver: { installed: true, path: '/fixture', version: 'fixture', fingerprint: 'f'.repeat(64) }, permitted: value => value === runId,
      execute: async () => { await activeSandbox.commands.run('node /tmp/mikka-cua-live.mjs', { user: 'user', timeoutMs: 30_000 }); executed++; return 'clicked' },
    })
    try {
      const grant = broker.spec(runId, 'ask', { display: ':1' })!
      const operation = broker.request(grant.token, { name: 'click', arguments: { x: 500, y: 500 } })
      const snapshots = webComputerSnapshots(broker)
      await syncComputerReviews(pool, deviceId, actor.userId, snapshots)
      const pending = (await store.state(actor, bot.id)).pendingApproval!
      assert.equal(pending.id, snapshots[0].id)
      assert.equal(executed, 0)
      assert.equal(await decideComputerReview(pool, actor, pending.id, pending.digest, true), true)
      await applyWebComputerDecisions(broker, await syncComputerReviews(pool, deviceId, actor.userId, snapshots))
      assert.equal(await operation, 'clicked')
      assert.equal(executed, 1)
      console.log('live stage: database approval drove the Bot desktop via CUA')
    } finally { await broker.close() }
    await sandbox.files.write('/workspace/acceptance-marker', 'preserved')
    await sandbox.betaPause()
    console.log('live stage: paused')
    assert.equal((await store.state(actor, bot.id)).machine, 'sleeping')
    await new ComputerStore(pool).operate(actor, bot.id, 'wake')
    console.log('live stage: resumed through store')
    sandbox = await Sandbox.connect(id, connection)
    if (process.env.E2B_TEST_CONTAINERS === '1') { await ensureContainerRuntime(sandbox); console.log('live stage: container runtime survives pause/resume') }
    assert.equal(await sandbox.files.read('/workspace/acceptance-marker'), 'preserved')
    console.log('live stage: persisted file verified')
    try {
      await sandbox.commands.run('/usr/bin/python3 /opt/mikka/computer/viewer-probe.py', { user: 'root', timeoutMs: 30_000 })
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '')
      const lines = stderr.split('\n').filter(line => /^\s*File .*line \d+/.test(line) || line.startsWith('AssertionError') || line.startsWith('TimeoutError'))
      console.error('resumed viewer diagnostic:', lines.join(' | '))
      throw error
    }
    console.log('live stage: resumed viewer verified')
    const privilege = await sandbox.commands.run('if sudo -n true >/dev/null 2>&1; then exit 1; fi; if cat /run/mikka-viewer/key >/dev/null 2>&1; then exit 1; fi', { user: 'user' })
    assert.equal(privilege.exitCode, 0)
    console.log(JSON.stringify({ provision: true, persistentBot: true, viewer: true, publicIngressProtected: true, unixVncPixels: true, takeover: true, handback: true, ownerDenial: true, sleepResume: true, diskPreserved: true, keyIsolated: true }))
  } finally {
    // Recover the ID from the ledger even when acceptance failed mid-provision.
    const ids = await pool.query('SELECT "sandboxId" FROM cloud_machines WHERE "sandboxId" IS NOT NULL').catch(() => ({ rows: [] }))
    for (const { sandboxId } of ids.rows) await Sandbox.kill(sandboxId, connection)
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
}
void main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "Acceptance failed"); process.exitCode = 1 })
