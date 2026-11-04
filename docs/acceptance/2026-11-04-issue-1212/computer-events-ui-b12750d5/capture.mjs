// Screenshot-only driver. Copy to scripts/acceptance/c-preview-capture.mjs in
// the final C worktree; run with server-test + tsx after next build/start.
// Uses real local HTTP/PG. No route interception and no browser test runner.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { Pool } from 'pg'
import { chromium } from '@playwright/test'
import { loadEnvironment, assertDeploymentIdentity } from '../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'
import { acquireTestAccounts, auditEvidence } from '../scripts/test-accounts/session.mjs'
import { SubagentStore } from '../lib/cloud-computer/subagents.ts'

const WORKSPACE = '00000000-0000-4000-8000-0000000000c0'
const BOT = '00000000-0000-4000-8000-0000000000b0'
const SUB = '00000000-0000-4000-8000-0000000000a1'
const directory = '/tmp/mikka-c-b127-screenshots'
const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
assert.equal(Boolean(process.env.DEVICE_GATEWAY_URL || process.env.DEVICE_GATEWAY_PUSH_SECRET), false,
  'this capture proves local JSON/foreground behavior, with the remote gateway unconfigured')
const database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 })
const accounts = new TestAccountPool(database, environment)
let scope, browser, chromeProcess, chromeProfile
const manifest = {
  commit: environment.deploymentSha, environmentId: environment.id, origin: environment.origin,
  startedAt: new Date().toISOString(), fixture: { workspaceId: WORKSPACE, botId: BOT, subagentId: SUB },
  captures: [], eventReads: [], limits: ['Local screenshot evidence; no external login, model execution, or healthy-WebSocket production acceptance.'],
}
try {
  await accounts.prepare({ pairs: 2 })
  scope = await acquireTestAccounts({ database, environment, runId: `computer-events-visual-${randomUUID()}`,
    workerId: 'local-screen-review', requestId: randomUUID(), ttlMs: 300_000 })
  const actor = { userId: scope.owner.userId, workspaceId: WORKSPACE }
  await scope.assertActive()
  assert.equal((await database.query(`SELECT 1 FROM mikka_workspaces WHERE id=$1
    UNION ALL SELECT 1 FROM bot_subagents WHERE id=$2`, [WORKSPACE, SUB])).rowCount, 0, 'fresh fixture IDs required')
  // bots is an existing supported resource type. The workspace and subagent are
  // also recorded in this manifest and retained with a dirty/quarantined lease;
  // do not expand the account adapter's resource allowlist for a screenshot.
  await scope.recordResource({ type: 'bots', id: BOT, ownerId: actor.userId })
  const tx = await database.connect()
  try {
    await tx.query('BEGIN')
    await tx.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Computer events visual fixture')`, [WORKSPACE, actor.userId])
    await tx.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
      SELECT $1,id,name,email,'admin','active' FROM "user" WHERE id=$2`, [WORKSPACE, actor.userId])
    await tx.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,'Computer events visual fixture')`, [BOT, WORKSPACE, actor.userId])
    // This synthetic subagent has no cloud machine and never runs a model. Its
    // visible state changes below go through the actual SubagentStore writer.
    await tx.query(`INSERT INTO bot_subagents(id,"ownerId","workspaceId","botId",task,status)
      VALUES($1,$2,$3,$4,'Read the local visual fixture','running')`, [SUB, actor.userId, WORKSPACE, BOT])
    await tx.query('COMMIT')
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  const store = new SubagentStore(database)
  await store.update(actor, BOT, SUB, 'needs_you', 'Waiting for sign-in', { kind: 'login', site: 'example.test' })
  await store.update(actor, BOT, SUB, 'needs_you', 'Waiting for sign-in', { kind: 'login', site: 'example.test' })
  const response = await scope.owner.request(`/api/computer/events?workspace=${WORKSPACE}&after=0`)
  assert.equal(response.status, 200)
  const initial = await response.json()
  assert.equal(initial.events.length, 2)
  assert.ok(initial.events.every(event => event.data.subagentId === SUB && event.data.state === 'needs_you'))
  const ticket = await scope.owner.request(`/api/live/ticket?workspace=${WORKSPACE}`)
  assert.equal(ticket.status, 200)
  assert.deepEqual(await ticket.json(), { url: null, protocol: null, expiresAt: null },
    'the actual ticket route must confirm that no remote gateway is configured')
  manifest.gateway = { configured: false, ticketStatus: ticket.status }
  manifest.initialRead = { status: response.status, cursor: initial.cursor, eventCount: initial.events.length }
  manifest.fixture.ownerId = actor.userId

  // Ordinary Playwright contexts force focus emulation on, making every tab
  // report visible. A fresh native Chrome + the documented noDefaults option
  // observes the browser's real Page Visibility state in its default context.
  chromeProfile = await mkdtemp('/tmp/mikka-c-events-chrome-')
  chromeProcess = spawn('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${chromeProfile}`, 'about:blank'],
  { stdio: 'ignore' })
  let port
  for (let attempt = 0; attempt < 50; attempt++) {
    try { port = (await readFile(`${chromeProfile}/DevToolsActivePort`, 'utf8')).split('\n')[0]; break } catch {}
    await pause(100)
  }
  assert.match(port ?? '', /^\d+$/, 'native Chrome must expose its local debug endpoint')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
  const context = browser.contexts()[0]
  const state = JSON.parse(await readFile(scope.owner.storageStatePath, 'utf8'))
  assert.deepEqual(state.origins, [], 'the supported TestPool browser state uses cookies only')
  // This is the state produced by normal TestPool sign-up/sign-in above, as in
  // newContext({ storageState }); values are never logged or put in evidence.
  await context.addCookies(state.cookies)
  const page = context.pages()[0] ?? await context.newPage()
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  manifest.browser = { version: browser.version(), mode: 'native headed Chrome, Openbox/Xvfb',
    connection: 'connectOverCDP noDefaults=true; real visibility, no focus emulation' }
  const reads = []
  page.on('response', result => {
    const url = new URL(result.url())
    if (url.origin !== environment.origin || url.pathname !== `${environment.basePath}/api/computer/events`) return
    reads.push((async () => {
      const payload = result.status() === 200 ? await result.json() : null
      manifest.eventReads.push({ at: new Date().toISOString(), after: url.searchParams.get('after'), status: result.status(),
        cursor: payload?.cursor, hasMore: payload?.hasMore,
        events: payload?.events.map(event => ({ id: event.id, subagentId: event.data.subagentId, state: event.data.state })) })
    })())
  })
  await mkdir(directory, { recursive: true })
  for (const locale of ['zh-CN', 'en']) {
    await scope.assertActive()
    await page.goto(`${environment.origin}${environment.basePath}/${locale}/preview/subagent-login`, { waitUntil: 'networkidle' })
    await page.getByTestId('subagent-login-needs').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('subagent-login-needs').getByRole('button').count(), 1, 'two committed events render one card')
    await page.evaluate(() => document.fonts.ready)
    for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
      await scope.assertActive()
      const height = width === 390 ? 844 : 960
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const name = `${locale === 'en' ? 'en' : 'zh'}-login-${width}-${scheme}.png`
      const path = `${directory}/${name}`
      await page.screenshot({ path })
      manifest.captures.push({ name, locale, width, height, scheme, at: new Date().toISOString(),
        sha256: createHash('sha256').update(await readFile(path)).digest('hex'), text: await page.locator('body').innerText() })
      await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2))
    }
  }
  const away = await context.newPage()
  await away.goto('about:blank')
  await away.bringToFront()
  await page.waitForFunction(() => document.visibilityState === 'hidden', null, { timeout: 5000 })
  assert.equal(await page.evaluate(() => document.visibilityState), 'hidden', 'the browser must actually background the captured page')
  manifest.background = { visibilityState: 'hidden', observedAt: new Date().toISOString(), method: 'another real tab brought to front' }
  await scope.assertActive()
  await store.update(actor, BOT, SUB, 'running', 'Continuing the local fixture', null)
  await page.bringToFront()
  await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 5000 })
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
  await page.getByTestId('subagent-login-needs').waitFor({ state: 'hidden', timeout: 15_000 })
  await Promise.all(reads)
  assert.ok(manifest.eventReads.some(read => read.status === 200 && BigInt(read.after ?? '0') > BigInt(0)
    && read.events?.some(event => event.subagentId === SUB && event.state === 'running')), 'foreground catch-up reads the committed incremental event')
  manifest.foregroundCatchUp = { cardRemoved: true, observedAt: new Date().toISOString() }
  manifest.finishedAt = new Date().toISOString()
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2))
  const audit = await auditEvidence([directory], { environment })
  console.log(JSON.stringify({ captures: manifest.captures.length, manifest: `${directory}/manifest.json`, audit,
    foregroundCatchUp: manifest.foregroundCatchUp, fixtureDisposition: 'local fixtures retained; account pair quarantined' }))
} finally {
  await browser?.close()
  chromeProcess?.kill('SIGTERM')
  if (chromeProfile) { await pause(200); await rm(chromeProfile, { recursive: true, force: true }) }
  await scope?.release({ outcome: 'dirty' })
  await database.end()
}
