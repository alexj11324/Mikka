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
    await pool.query(await readFile(new URL('../../drizzle/20261026235901_cloud_computers.sql', import.meta.url), 'utf8'))
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
      const access = await sandbox.commands.run('if test -r /run/mikka-container/docker.sock || test -w /run/mikka-container/docker.sock; then exit 1; fi', { user: 'user' })
      assert.equal(access.exitCode, 0)
      console.log('live stage: root-only container runtime available')
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
    await sandbox.files.write('/workspace/acceptance-marker', 'preserved')
    await sandbox.betaPause()
    assert.equal((await store.state(actor, bot.id)).machine, 'sleeping')
    await new ComputerStore(pool).operate(actor, bot.id, 'wake')
    sandbox = await Sandbox.connect(id, connection)
    if (process.env.E2B_TEST_CONTAINERS === '1') { await ensureContainerRuntime(sandbox); console.log('live stage: container runtime survives pause/resume') }
    assert.equal(await sandbox.files.read('/workspace/acceptance-marker'), 'preserved')
    await sandbox.commands.run('/usr/bin/python3 /opt/mikka/computer/viewer-probe.py', { user: 'root', timeoutMs: 30_000 })
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
