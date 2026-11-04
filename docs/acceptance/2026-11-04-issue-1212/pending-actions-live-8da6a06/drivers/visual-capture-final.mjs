// Screenshot-only: actual isolated production HTTP/PG and normal TestPool login.
// Email/browser rows are display fixtures; App proposals use the actual store.
// No approval button is clicked and no external effect/model is invoked.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const root = process.env.MIKKA_PENDING_REPO ?? '/vercel/sandbox/mikka-pending-live'
assert.equal(root, '/vercel/sandbox/mikka-pending-live')
const sha = process.env.MIKKA_PENDING_VISUAL_SHA
assert.match(sha ?? '', /^[0-9a-f]{40}$/)
const short = sha.slice(0, 7)
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
const directory = '/tmp/mikka-pending-' + short + '-screenshots'
const journal = [], messageId = randomUUID()
const manifest = { commit: sha, environmentId: environment.id, origin: environment.origin, startedAt: new Date().toISOString(), captures: [],
  fixture: { messageId, proposals: journal }, limits: [
    'Synthetic display cards, actual production build/HTTP/PostgreSQL, and normal TestPool sign-up/sign-in.',
    'App card created by actual proposeAppToolCall; email/browser cards are explicit isolated database display fixtures, not execution-authorized browser operations.',
    'No model/provider request, decision POST, request interception, browser test runner, production traffic or healthy WebSocket acceptance.',
    'TestPool has no pending_actions resource adapter; exact local IDs are journaled, removed owner-scoped, and the test pair quarantined.',
  ], consoleErrors: [], httpFailures: [], apiReads: [] }
let scope, browser, messageReserved = false, userId
await mkdir(directory, { recursive: true })
const save = () => writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2))
try {
  await new TestAccountPool(db, environment).prepare({ pairs: 6 })
  scope = await acquireTestAccounts({ database: db, environment, runId: 'pending-visual-' + randomUUID(), workerId: 'normal-production-screenshot', requestId: randomUUID(), ttlMs: 300000 })
  await scope.assertActive(); userId = scope.owner.userId
  assert.equal((await scope.owner.request('/api/workspace/switcher')).status, 200)
  const { coordinatorBot } = await import(root + '/lib/coordinator/coordinator-bot.ts')
  const { proposeAppToolCall } = await import(root + '/lib/pending-action-store.ts')
  const { parseActionInput } = await import(root + '/lib/composio-actions.ts')
  const bot = await coordinatorBot(userId, null)
  await scope.recordResource({ type: 'coordinator_messages', id: messageId, ownerId: userId }); messageReserved = true
  await db.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,1,$4)',
    [messageId, userId, bot.botId, { role: 'assistant', content: '请核对待处理操作。Review the pending action.' }])
  const scenarios = [
    { state: 'email', action: 'send_email', visible: '核对上线说明和验收记录。\nReview the release notes and acceptance record.',
      input: { to: ['reviewer@example.invalid'], cc: ['team@example.invalid'], subject: '上线验收记录 / Release acceptance record', body: '核对上线说明和验收记录。\nReview the release notes and acceptance record.' } },
    { state: 'app', action: 'app_tool_call', visible: '整理验收清单 / Prepare acceptance checklist',
      input: { toolkit: 'notion', tool: 'NOTION_APPEND_BLOCK_CHILDREN', name: '整理验收清单 / Prepare acceptance checklist', version: 'isolated-display-v1', arguments: { page: 'isolated-display-page', text: '核对版本、日志与截图。Review version, logs and screenshots.' } } },
    { state: 'browser', action: 'browser_operation', visible: '核对发布设置 / Review release settings',
      input: { summary: '核对发布设置 / Review release settings', origin: 'https://isolated-display.example.invalid', operation: 'submit' } },
  ]
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath, viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.on('pageerror', error => manifest.consoleErrors.push({ name: error.name, message: error.message.slice(0, 240) }))
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === environment.origin && response.status() >= 400) manifest.httpFailures.push({ path: url.pathname, status: response.status() }) })
  for (const fixture of scenarios) {
    let id
    if (fixture.action === 'app_tool_call') {
      const result = await proposeAppToolCall(userId, fixture.input, null, bot.botId)
      assert.equal(result.status, 'awaiting_approval'); assert.equal(typeof result.actionId, 'string'); id = result.actionId
    } else {
      if (fixture.action === 'send_email') assert.ok(parseActionInput(fixture.action, fixture.input))
      id = randomUUID()
      await db.query('INSERT INTO pending_actions(id,"userId","botId",action,input,status) VALUES($1,$2,$3,$4,$5,\'pending\')', [id, userId, bot.botId, fixture.action, fixture.input])
    }
    journal.push({ id, state: fixture.state, action: fixture.action, creation: fixture.state === 'app' ? 'actual_proposeAppToolCall' : 'isolated_display_fixture' }); await save()
    const response = await scope.owner.request('/api/pending-actions')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-mikka-viewer'), encodeURIComponent(userId))
    assert.ok(Number.isFinite(Date.parse(response.headers.get('x-mikka-observed-at'))))
    const rows = await response.json(); assert.equal(rows.length, 1); assert.equal(rows[0].id, id)
    manifest.apiReads.push({ state: fixture.state, status: response.status, exactOwnedRow: true, viewerVerified: true, observedAtPresent: true })
    for (const locale of ['zh-CN', 'en']) for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
      const height = width === 390 ? 844 : 960
      await scope.assertActive(); await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme })
      await page.goto(environment.origin + environment.basePath + '/' + locale + '?bot=' + bot.botId, { waitUntil: 'domcontentloaded' })
      await page.getByText(fixture.visible, { exact: true }).waitFor({ state: 'visible' })
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const name = (locale === 'en' ? 'en' : 'zh') + '-' + fixture.state + '-' + width + '-' + scheme + '.png'
      const path = directory + '/' + name; await page.screenshot({ path })
      manifest.captures.push({ name, locale, width, height, scheme, state: fixture.state, at: new Date().toISOString(), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }); await save()
    }
    await db.query('DELETE FROM pending_actions WHERE id=$1 AND "userId"=$2', [id, userId])
  }
  assert.deepEqual(manifest.consoleErrors, []); assert.deepEqual(manifest.httpFailures, [])
  manifest.finishedAt = new Date().toISOString(); await save()
  manifest.audit = await auditEvidence([directory], { environment }); await save()
  console.log(JSON.stringify({ captured: manifest.captures.length, commit: sha, manifest: directory + '/manifest.json', audit: manifest.audit }))
} finally {
  await browser?.close()
  if (scope) {
    for (const item of journal) await db.query('DELETE FROM pending_actions WHERE id=$1 AND "userId"=$2', [item.id, userId])
    if (messageReserved) {
      await db.query('DELETE FROM coordinator_messages WHERE id=$1 AND "userId"=$2', [messageId, userId])
      await scope.markResourceCleaned({ type: 'coordinator_messages', id: messageId })
    }
    const released = await scope.release({ outcome: 'dirty' })
    manifest.cleanup = { fixtureResourcesRemoved: true, leaseState: released?.state, reason: 'Exact local display fixtures removed; test pair quarantined', at: new Date().toISOString() }; await save()
  }
  await db.end()
}
