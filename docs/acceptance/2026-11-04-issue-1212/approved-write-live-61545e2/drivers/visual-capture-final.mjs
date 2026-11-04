// Screenshot-only. Actual isolated production HTTP/PG + normal TestPool login.
// Synthetic card contents and an in-process provider; no external effect/model.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const root = process.env.MIKKA_APPROVED_REPO ?? '/vercel/sandbox/mikka-approved-live'
assert.ok(['/vercel/sandbox/mikka-approved-live', '/home/agent/workspace/mikka-approved-live'].includes(root), 'isolated approval worktree required')
const sha = process.env.MIKKA_APPROVED_VISUAL_SHA
assert.match(sha ?? '', /^[0-9a-f]{40}$/)
const short = sha.slice(0,7)
const require = createRequire(root + '/package.json')
const { Pool } = require('pg'), { chromium } = require('@playwright/test')
const { loadEnvironment, assertDeploymentIdentity } = await import(root + '/scripts/test-accounts/environment.mjs')
const { TestAccountPool } = await import(root + '/scripts/test-accounts/pool.mjs')
const { acquireTestAccounts, auditEvidence } = await import(root + '/scripts/test-accounts/session.mjs')
process.chdir(root)
const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
assert.equal(environment.deploymentSha, sha)
assert.equal(Boolean(process.env.DEVICE_GATEWAY_URL || process.env.DEVICE_GATEWAY_PUSH_SECRET), false)
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4 })
const directory = '/tmp/mikka-approved-' + short + '-screenshots'
const journal = [], messageId = randomUUID()
const manifest = { commit: sha, environmentId: environment.id, origin: environment.origin, startedAt: new Date().toISOString(),
  captures: [], fixture: { messageId, proposals: journal }, limits: [
    'Synthetic display cards created by actual approval service with a local provider, real production build/HTTP/PostgreSQL and normal TestPool sign-up/sign-in.',
    'No model/provider request, browser test runner, interception, production traffic or healthy WebSocket acceptance.',
    'TestPool has no pending_actions/operation_ledger resource adapter; exact locally created IDs are journaled separately and removed owner-scoped, and the test account pair is quarantined.',
  ], consoleErrors: [], httpFailures: [] }
let scope, browser, messageReserved = false, userId
await mkdir(directory, { recursive: true })
const save = () => writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2))
try {
  await new TestAccountPool(db, environment).prepare({ pairs: 6 })
  scope = await acquireTestAccounts({ database: db, environment, runId: 'approved-visual-' + randomUUID(), workerId: 'normal-production-screenshot', requestId: randomUUID(), ttlMs: 300000 })
  await scope.assertActive(); userId = scope.owner.userId
  // The public switcher establishes the normal personal workspace first.
  const switcher = await scope.owner.request('/api/workspace/switcher')
  assert.equal(switcher.status, 200)
  const { coordinatorBot } = await import(root + '/lib/coordinator/coordinator-bot.ts')
  const bot = await coordinatorBot(userId, null)
  await scope.recordResource({ type: 'coordinator_messages', id: messageId, ownerId: userId }); messageReserved = true
  await db.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,1,$4)',
    [messageId, userId, bot.botId, { role: 'assistant', content: '已准备待确认的操作。Your approval cards are ready.' }])
  const sessions = await db.query('SELECT id FROM "session" WHERE "userId"=$1 AND "expiresAt">now()', [userId])
  assert.equal(sessions.rowCount, 1, 'use the one actual TestPool HTTP session')
  const actor = { userId, sessionId: sessions.rows[0].id }
  const { createApprovedWrites } = await import(root + '/lib/operations/approved-writes.ts')
  let uncertain = false
  const provider = { name: 'isolated-display-provider',
    prepare: async () => ({ accountId: 'Local display account', version: 'display-v1', context: null }),
    execute: async input => { await input.beforeSend(); if (uncertain) throw Error('isolated unconfirmed result'); throw Error('external effects forbidden') },
    lookup: async () => null,
  }
  const service = createApprovedWrites(db, provider, 'append_notion_paragraph', { actor })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath, viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.on('pageerror', error => manifest.consoleErrors.push({ name: error.name, message: error.message.slice(0, 240) }))
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === environment.origin && response.status() >= 400) manifest.httpFailures.push({ path: url.pathname, status: response.status() }) })
  for (const state of ['pending', 'uncertain', 'expired']) {
    const intentId = randomUUID(), text = '核对上线说明和验收记录。\nReview the release notes and acceptance record.'
    const proposal = await service.propose(userId, { page_id: randomUUID(), text }, intentId)
    journal.push({ id: proposal.actionId, intentId, state }); await save()
    if (state === 'uncertain') { uncertain = true; assert.equal((await service.decide(actor, proposal.actionId, true)).status, 'running'); uncertain = false }
    if (state === 'expired') await db.query('UPDATE pending_actions SET "createdAt"=now()-interval \'8 days\' WHERE id=$1 AND "userId"=$2', [proposal.actionId, userId])
    for (const locale of ['zh-CN', 'en']) for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
      const height = width === 390 ? 844 : 960
      await scope.assertActive()
      await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme })
      await page.goto(environment.origin + environment.basePath + '/' + locale + '?bot=' + bot.botId, { waitUntil: 'domcontentloaded' })
      await page.getByText(text, { exact: true }).waitFor({ state: 'visible' })
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const name = (locale === 'en' ? 'en' : 'zh') + '-' + state + '-' + width + '-' + scheme + '.png'
      const path = directory + '/' + name
      await page.screenshot({ path })
      manifest.captures.push({ name, locale, width, height, scheme, state, at: new Date().toISOString(), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
      await save()
    }
    // Display-only cleanup between states; never reconcile/retry an unknown operation.
    await db.query('DELETE FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2', [proposal.actionId, userId])
    await db.query('DELETE FROM pending_actions WHERE id=$1 AND "userId"=$2', [proposal.actionId, userId])
  }
  assert.deepEqual(manifest.consoleErrors, [])
  assert.deepEqual(manifest.httpFailures, [])
  manifest.finishedAt = new Date().toISOString(); await save()
  manifest.audit = await auditEvidence([directory], { environment }); await save()
  console.log(JSON.stringify({ captured: manifest.captures.length, commit: sha, manifest: directory + '/manifest.json', audit: manifest.audit }))
} finally {
  await browser?.close()
  if (scope) {
    for (const item of journal) {
      await db.query('DELETE FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2', [item.id, userId])
      await db.query('DELETE FROM pending_actions WHERE id=$1 AND "userId"=$2', [item.id, userId])
    }
    if (messageReserved) {
      await db.query('DELETE FROM coordinator_messages WHERE id=$1 AND "userId"=$2', [messageId, userId])
      await scope.markResourceCleaned({ type: 'coordinator_messages', id: messageId })
    }
    const released = await scope.release({ outcome: 'dirty' })
    manifest.cleanup = { fixtureResourcesRemoved: true, leaseState: released?.state, reason: 'TestPool account pair quarantined; exact local display cards removed', at: new Date().toISOString() }
    await save()
  }
  await db.end()
}
