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

const url = new URL(process.env.COMPUTER_TEST_DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'disposable local database only')
assert.ok(process.env.E2B_API_KEY && process.env.E2B_COMPUTER_TEMPLATE)
const schema = `computer_live_${randomUUID().replaceAll('-', '')}`
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
  const id = (await pool.query('SELECT "sandboxId" FROM cloud_machines')).rows[0].sandboxId
  sandbox = await Sandbox.connect(id, { apiKey: process.env.E2B_API_KEY })
  assert.equal((await store.state(actor, bot.id)).machine, 'running')
  const view = await store.operate(actor, bot.id, 'viewer')
  assert.ok(view?.url.startsWith('wss://'))
  await assert.rejects(store.operate({ ...actor, userId: 'different-owner' }, bot.id, 'takeover'), { status: 404 })
  await assert.rejects(store.operate(actor, bot.id, 'viewer', 'control'), { status: 403 })
  await store.operate(actor, bot.id, 'takeover')
  assert.equal((await store.state(actor, bot.id)).control, 'user')
  await store.operate(actor, bot.id, 'handback')
  assert.equal((await store.state(actor, bot.id)).control, 'agent')
  await sandbox.files.write('/workspace/acceptance-marker', 'preserved')
  await sandbox.betaPause()
  assert.equal((await store.state(actor, bot.id)).machine, 'sleeping')
  await new ComputerStore(pool).operate(actor, bot.id, 'wake')
  sandbox = await Sandbox.connect(id, { apiKey: process.env.E2B_API_KEY })
  assert.equal(await sandbox.files.read('/workspace/acceptance-marker'), 'preserved')
  const privilege = await sandbox.commands.run('if sudo -n true >/dev/null 2>&1; then exit 1; fi; if cat /run/mikka-viewer/key >/dev/null 2>&1; then exit 1; fi', { user: 'user' })
  assert.equal(privilege.exitCode, 0)
  console.log(JSON.stringify({ provision: true, persistentBot: true, viewer: true, takeover: true, handback: true, ownerDenial: true, sleepResume: true, diskPreserved: true, keyIsolated: true }))
} finally {
  // Recover the ID from the ledger even when acceptance failed mid-provision.
  const ids = await pool.query('SELECT "sandboxId" FROM cloud_machines WHERE "sandboxId" IS NOT NULL').catch(() => ({ rows: [] }))
  for (const { sandboxId } of ids.rows) await Sandbox.kill(sandboxId, { apiKey: process.env.E2B_API_KEY })
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
}
