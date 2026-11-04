// Screenshot and local HTTP acceptance driver; no browser test runner or route interception.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { chromium } from '@playwright/test'
import { loadEnvironment, assertDeploymentIdentity } from '../test-accounts/environment.mjs'
import { TestAccountPool } from '../test-accounts/pool.mjs'
import { acquireTestAccounts, auditEvidence } from '../test-accounts/session.mjs'

const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 })
const directory = '/tmp/mikka-web-group-screenshots'
const workspaceId = randomUUID()
const ownBots = [randomUUID(), randomUUID(), randomUUID()]
const foreignBot = randomUUID(), otherWorkspaceBot = randomUUID()
const names = ['Interface / 界面', 'Coding / 代码', 'Testing with a long descriptive name / 测试与验证']
let scope, browser
const manifest = { commit: environment.deploymentSha, environmentId: environment.id, origin: environment.origin,
  startedAt: new Date().toISOString(), captures: [], checks: [], requests: [],
  limits: ['Local production build and isolated PostgreSQL only; no model calls, interception, browser suite, or production acceptance.'] }
const save = async () => writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2))
try {
  await new TestAccountPool(db, environment).prepare({ pairs: 5 })
  scope = await acquireTestAccounts({ database: db, environment, runId: 'group-create-visual-' + randomUUID(),
    workerId: 'normal-ui-capture', requestId: randomUUID(), ttlMs: 300_000 })
  await scope.assertActive()
  const ownHomeResponse = await scope.owner.request('/api/workspace')
  assert.equal(ownHomeResponse.status, 200)
  const ownHome = (await ownHomeResponse.json()).workspace.id
  for (const id of [...ownBots, otherWorkspaceBot]) await scope.recordResource({ type: 'bots', id, ownerId: scope.owner.userId })
  await scope.recordResource({ type: 'bots', id: foreignBot, ownerId: scope.peer.userId })
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    await tx.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,$3,$4)',
      [workspaceId, scope.owner.userId, 'Group creation fixture', 'team'])
    await tx.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) SELECT $1,id,name,email,$2,$3 FROM "user" WHERE id=ANY($4)',
      [workspaceId, 'admin', 'active', [scope.owner.userId, scope.peer.userId]])
    for (let i = 0; i < ownBots.length; i++) await tx.query('INSERT INTO bots(id,"workspaceId","ownerId",name,color,shape) VALUES($1,$2,$3,$4,$5,$6)',
      [ownBots[i], workspaceId, scope.owner.userId, names[i], ['bleu', 'vert', 'violet'][i], 'cercle'])
    await tx.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',
      [foreignBot, workspaceId, scope.peer.userId, 'Peer private bot', otherWorkspaceBot, ownHome, scope.owner.userId, 'Other workspace bot'])
    await tx.query('COMMIT')
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  manifest.fixture = { workspaceId, ownerId: scope.owner.userId, ownBots, foreignBot, otherWorkspaceBot }
  for (const [name, memberId] of [['foreign-owner', foreignBot], ['different-workspace', otherWorkspaceBot]]) {
    const response = await scope.owner.request('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, title: 'Rejected group fixture', members: [{ memberType: 'bot', memberId }] }) })
    assert.equal(response.status, 404, name + ' must be rejected by the actual server')
    manifest.checks.push({ name, status: response.status })
  }
  assert.equal((await db.query('SELECT count(*)::int AS count FROM conversations WHERE "workspaceId"=$1', [workspaceId])).rows[0].count, 0)
  browser = await chromium.launch({ headless: false, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath, viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const page = await context.newPage()
  const pendingResponses = []
  page.on('response', response => {
    const request = response.request()
    if (new URL(response.url()).pathname === environment.basePath + '/api/conversations' && request.method() === 'POST') {
      pendingResponses.push((async () => {
        const value = await response.json().catch(() => null)
        manifest.requests.push({ at: new Date().toISOString(), method: request.method(), status: response.status(),
          input: JSON.parse(request.postData()), result: value && { id: value.id, title: value.title } })
      })())
    }
  })
  const copy = {}
  for (const locale of ['zh-CN', 'en']) copy[locale] = JSON.parse(await readFile('messages/' + locale + '.json', 'utf8'))
  await page.goto(environment.origin + environment.basePath, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: copy['zh-CN'].Nav.workspaceMenu, exact: true }).click()
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('menuitem', { name: 'Group creation fixture', exact: true }).click(),
  ])
  await page.getByRole('button', { name: copy['zh-CN'].Nav.workspaceMenu, exact: true }).filter({ hasText: 'Group creation fixture' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: copy['zh-CN'].Nav.create, exact: true }).waitFor({ state: 'visible' })
  await mkdir(directory, { recursive: true })
  async function shot(name, details) {
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(async () => {
      const root = document.querySelector('[role="dialog"]') ?? document.documentElement
      await Promise.all(root.getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const path = directory + '/' + name + '.png'
    await page.screenshot({ path })
    manifest.captures.push({ name: name + '.png', ...details, at: new Date().toISOString(),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
    await save()
  }
  async function openDialog(locale, width) {
    const t = copy[locale]
    if (width < 768) await page.getByRole('button', { name: t.Workspace.toggleSidebar, exact: true }).click()
    await page.getByRole('button', { name: t.Nav.create, exact: true }).click()
    await page.getByRole('menuitem', { name: t.Nav.newGroup, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: t.Shell.newGroup.title, exact: true })
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.getByRole('checkbox').count(), 3)
    await dialog.getByRole('textbox', { name: t.Shell.newGroup.name, exact: true }).fill('Design review / 设计评审')
    await dialog.getByRole('checkbox', { name: names[0], exact: true }).check()
    await dialog.getByRole('checkbox', { name: names[1], exact: true }).check()
    assert.equal(await dialog.getByRole('button', { name: t.Shell.newGroup.create, exact: true }).isEnabled(), true)
    return dialog
  }
  for (const locale of ['zh-CN', 'en']) for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
    await scope.assertActive()
    const height = width === 390 ? 844 : 960
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(environment.origin + environment.basePath + '/' + locale + '?bot=' + ownBots[0], { waitUntil: 'domcontentloaded' })
    const dialog = await openDialog(locale, width)
    await shot((locale === 'en' ? 'en' : 'zh') + '-create-' + width + '-' + scheme, { locale, width, height, scheme, state: 'ready' })
    await dialog.getByRole('button', { name: copy[locale].Common.cancel, exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    manifest.checks.push({ name: 'cancel-focus', locale, width, scheme,
      focused: await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), connected: Boolean(document.activeElement?.isConnected) })) })
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(environment.origin + environment.basePath + '/zh-CN?bot=' + ownBots[0], { waitUntil: 'domcontentloaded' })
  const dialog = await openDialog('zh-CN', 1440)
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === environment.basePath + '/api/conversations' && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: copy['zh-CN'].Shell.newGroup.create, exact: true }).click()
  const result = await createdResponse
  assert.equal(result.status(), 201)
  const group = await result.json()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: group.title, exact: true }).first().waitFor({ state: 'visible' })
  const read = await scope.owner.request('/api/conversations/' + group.id + '/messages')
  assert.equal(read.status, 200)
  const members = (await db.query('SELECT "memberType","memberId" FROM conversation_members WHERE "conversationId"=$1 AND "leftAt" IS NULL ORDER BY "memberType","memberId"', [group.id])).rows
  assert.deepEqual(members.filter(row => row.memberType === 'bot').map(row => row.memberId).sort(), ownBots.slice(0, 2).sort())
  assert.equal(members.filter(row => row.memberType === 'user').length, 1)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM group_turns WHERE "conversationId"=$1', [group.id])).rows[0].count, 0)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM conversations WHERE "workspaceId"=$1', [workspaceId])).rows[0].count, 1)
  const peerRead = await scope.peer.request('/api/conversations/' + group.id + '/messages')
  assert.equal(peerRead.status, 404)
  manifest.created = { id: group.id, status: result.status(), members, readStatus: read.status, peerReadStatus: peerRead.status, groupTurnCount: 0 }
  await shot('zh-created-1440-light', { locale: 'zh-CN', width: 1440, height: 960, scheme: 'light', state: 'created' })
  await page.setViewportSize({ width: 390, height: 844 })
  await shot('zh-created-390-light', { locale: 'zh-CN', width: 390, height: 844, scheme: 'light', state: 'created' })
  await Promise.all(pendingResponses)
  assert.equal(manifest.requests.length, 1)
  manifest.finishedAt = new Date().toISOString()
  await save()
  const audit = await auditEvidence([directory], { environment })
  console.log(JSON.stringify({ captures: manifest.captures.length, checks: manifest.checks, created: manifest.created, audit,
    manifest: directory + '/manifest.json', fixtureDisposition: 'retained local fixtures; account lease quarantined' }))
} finally {
  await browser?.close()
  await scope?.release({ outcome: 'dirty' })
  await db.end()
}
