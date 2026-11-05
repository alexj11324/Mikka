// Actual local production HTTP + PostgreSQL and normal TestAccountPool login.
// Explicit display fixtures, no model request, browser interception or paid operation.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = '/vercel/sandbox/mikka-lists-1291-pending-diagnostic'
const sha = 'c68fc0bc9ddea0ee59a5c33afd3735283a7e0542'
const tree = '4a291d12049d0e9fc04d82ed1061cdae570229a8'
const directory = '/vercel/acceptance/lists-1291-c68fc0b/screenshots'
const require = createRequire(root + '/package.json')
const { Pool } = require('pg'), { chromium } = require('@playwright/test')
const { loadEnvironment, assertDeploymentIdentity } = await import(root + '/scripts/test-accounts/environment.mjs')
const { TestAccountPool } = await import(root + '/scripts/test-accounts/pool.mjs')
const { acquireTestAccounts, auditEvidence } = await import(root + '/scripts/test-accounts/session.mjs')
process.chdir(root)
const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
assert.equal(environment.deploymentSha, sha)
assert.equal(environment.origin, 'http://localhost:3373')
assert.equal(Boolean(process.env.DEVICE_GATEWAY_URL || process.env.DEVICE_GATEWAY_PUSH_SECRET), false)
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4 })
const ids = { bots: [randomUUID(), randomUUID(), randomUUID()], issues: [randomUUID(), randomUUID(), randomUUID()],
  runs: [randomUUID(), randomUUID(), randomUUID()], agent: randomUUID(), message: randomUUID(), settingsWorkspace: randomUUID() }
const botNames = ['Design / 设计', 'Build / 实施', 'Review / 复核']
const titles = ['Review permissions / 核对权限', 'Prepare release notes / 整理发布说明', 'Verify saved changes / 核验已保存修改']
const replies = ['Reviewing permissions / 核对权限边界', 'Ready for owner review / 等待负责人确认', 'Changes and checks completed / 修改与检查已完成']
const chatText = 'Review the release checklist. / 请核对发布清单。'
const groupTitle = 'Release review / 发布复核'
const reserved = []
let scope, browser, page, userId, workspaceId, groupId, fixtureInserted = false
const manifest = { sha, tree, environmentId: environment.id, origin: environment.origin, startedAt: new Date().toISOString(),
  status: 'running', captures: [], checks: [], pageErrors: [], httpFailures: [], apiReads: [], fixture: ids,
  limits: [
    'Actual local production build and authorized HTTP reads with normal TestAccountPool sign-up/sign-in; isolated local PostgreSQL only.',
    'Task, run and message rows are explicitly synthetic display fixtures. They do not establish any model execution, worker claim or production acceptance.',
    'Group creation uses the actual authorized POST with owned Bots and creates no group turn.',
    'No browser test runner, HTTP interception, provider/model call, decision POST or production traffic.',
    'No Device Gateway configured locally: the authorized ticket GET returns 200 with a null URL; this is degraded transport, not healthy WebSocket acceptance.',
    'Healthy transport, owner changes, visibility and the former 60-second polling boundary are covered separately by the actual React/SWR suite.',
    'The members page uses an explicit isolated team workspace with the TestPool owner and peer; personal workspaces correctly redirect away from team-only settings.',
    'All exact fixture IDs are removed and the pair quarantined; the parent process then drops its own database and role.',
  ] }
await mkdir(directory, { recursive: true, mode: 0o700 })
const save = () => writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2))
async function reserve(type, id) {
  await scope.recordResource({ type, id, ownerId: userId })
  reserved.push({ type, id })
}
try {
  await new TestAccountPool(db, environment).prepare({ pairs: 6 })
  scope = await acquireTestAccounts({ database: db, environment, runId: 'lists-visual-' + randomUUID(),
    workerId: 'normal-production-screenshot', requestId: randomUUID(), ttlMs: 300000 })
  await scope.assertActive(); userId = scope.owner.userId
  const homeResponse = await scope.owner.request('/api/workspace')
  assert.equal(homeResponse.status, 200)
  const home = await homeResponse.json(); workspaceId = home.workspace.id
  assert.equal(home.currentUserId, userId)
  const membership = await db.query('SELECT w.kind FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id WHERE w.id=$1 AND w."userId"=$2 AND m."userId"=$2 AND m.status=\'active\'', [workspaceId, userId])
  assert.deepEqual(membership.rows.map(row => row.kind), ['personal'])
  manifest.scope = { ownerId: userId, workspaceId, personalHomeVerified: true }
  for (const id of ids.bots) await reserve('bots', id)
  await reserve('agents', ids.agent)
  for (const id of ids.issues) await reserve('issues', id)
  for (const id of ids.runs) await reserve('agent_runs', id)
  await reserve('coordinator_messages', ids.message)
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    await tx.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,$3,$4)', [ids.settingsWorkspace, userId, 'Release review team / 发布复核团队', 'team'])
    await tx.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) SELECT $1,id,name,email,CASE WHEN id=$2 THEN \'admin\' ELSE \'member\' END,\'active\' FROM "user" WHERE id=ANY($3)', [ids.settingsWorkspace, userId, [userId, scope.peer.userId]])
    for (let i = 0; i < ids.bots.length; i++) await tx.query('INSERT INTO bots(id,"ownerId","workspaceId",name,color,shape) VALUES($1,$2,$3,$4,$5,$6)', [ids.bots[i], userId, workspaceId, botNames[i], ['bleu', 'vert', 'violet'][i], 'cercle'])
    await tx.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,$3,$4)', [ids.agent, userId, 'codex', 'Display fixture agent'])
    for (let i = 0; i < ids.issues.length; i++) {
      const status = ['doing', 'todo', 'done'][i], runStatus = ['running', 'waiting_input', 'succeeded'][i]
      await tx.query('INSERT INTO issues(id,"userId",title,content,status,priority,"scopeSetBy") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [ids.issues[i], userId, titles[i], { type: 'doc', attrs: { mikka: { number: i + 1 } }, content: [] }, status, ['high', 'normal', 'low'][i], 'user'])
      await tx.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status,prompt,"lastReply","lastReplyAt",outcome,"startedAt","finishedAt","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,now()-interval \'5 minutes\',CASE WHEN $6=\'succeeded\' THEN now() ELSE NULL END,now()-interval \'5 minutes\',now())',
        [ids.runs[i], userId, ids.issues[i], ids.agent, ids.bots[i], runStatus, titles[i], replies[i], i === 2 ? 'done' : null])
    }
    await tx.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,1,$4)',
      [ids.message, userId, ids.bots[0], { role: 'assistant', content: [{ type: 'text', text: chatText }] }])
    await tx.query('COMMIT'); fixtureInserted = true
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  const created = await scope.owner.request('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, title: groupTitle, members: ids.bots.slice(0, 2).map(memberId => ({ memberType: 'bot', memberId })) }) })
  assert.equal(created.status, 201)
  groupId = (await created.json()).id; manifest.fixture.group = groupId
  assert.equal((await db.query('SELECT count(*)::int n FROM group_turns WHERE "conversationId"=$1', [groupId])).rows[0].n, 0)
  manifest.checks.push({ name: 'actual-group-create', status: 201, groupTurnCount: 0 })
  const membersResponse = await scope.owner.request('/api/workspace?workspace=' + ids.settingsWorkspace)
  assert.equal(membersResponse.status, 200)
  const memberSettings = await membersResponse.json()
  assert.equal(memberSettings.workspace.id, ids.settingsWorkspace); assert.equal(memberSettings.currentUserId, userId)
  assert.deepEqual(memberSettings.members.map(member => member.userId).sort(), [userId, scope.peer.userId].sort())
  const ownerName = memberSettings.members.find(member => member.userId === userId).name
  manifest.checks.push({ name: 'actual-team-settings-read', status: 200, exactWorkspace: true, exactMembers: 2 })
  const ticketResponse = await scope.owner.request('/api/live/ticket?workspace=' + workspaceId)
  assert.equal(ticketResponse.status, 200)
  const ticket = await ticketResponse.json()
  assert.equal(ticket.url, null); assert.equal(ticket.protocol, null); assert.equal(ticket.expiresAt, null)
  manifest.checks.push({ name: 'degraded-local-live-transport', status: 200, ticketUrlAbsent: true })
  await save()
  const copy = Object.fromEntries(await Promise.all(['zh-CN', 'en'].map(async locale => [locale, JSON.parse(await readFile(root + '/messages/' + locale + '.json', 'utf8'))])))
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath, viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => manifest.pageErrors.push({ name: error.name, message: error.message.slice(0, 300) }))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== environment.origin) return
    if (response.status() >= 400) manifest.httpFailures.push({ path: url.pathname, status: response.status() })
    if (url.pathname.startsWith(environment.basePath + '/api/')) manifest.apiReads.push({ path: url.pathname, method: response.request().method(), status: response.status() })
  })
  async function shot(name, details) {
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(async () => {
      await Promise.all(document.documentElement.getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const path = directory + '/' + name + '.png'
    await page.screenshot({ path })
    manifest.captures.push({ name: name + '.png', ...details, at: new Date().toISOString(), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
    await save()
  }
  for (const locale of ['en', 'zh-CN']) for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
    await scope.assertActive()
    const height = width === 390 ? 844 : 960, t = copy[locale], prefix = (locale === 'en' ? 'en' : 'zh')
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme })
    const details = { locale, width, height, scheme }
    await page.goto(environment.origin + environment.basePath + '/' + locale + '?section=all-issues', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: t.Shell.board.viewList, exact: true }).click()
    await page.getByText(titles[0], { exact: true }).first().waitFor({ state: 'visible' })
    await shot(prefix + '-board-' + width + '-' + scheme, { ...details, state: 'task-board-list' })
    await page.goto(environment.origin + environment.basePath + '/' + locale + '?bot=' + ids.bots[0] + '&threads=all', { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: t.Shell.panel.allThreads, exact: true }).waitFor({ state: 'visible' })
    await page.locator('[data-slot="thread-card"]').filter({ hasText: replies[0] }).first().waitFor({ state: 'visible' })
    await shot(prefix + '-threads-' + width + '-' + scheme, { ...details, state: 'all-threads' })
    await page.goto(environment.origin + environment.basePath + '/' + locale + '?bot=' + ids.bots[0], { waitUntil: 'domcontentloaded' })
    await page.getByText(chatText, { exact: true }).first().waitFor({ state: 'visible' })
    if (width < 768) await page.getByRole('button', { name: t.Workspace.toggleSidebar, exact: true }).click()
    await page.getByRole('button', { name: groupTitle, exact: true }).first().waitFor({ state: 'visible' })
    await shot(prefix + '-chats-' + width + '-' + scheme, { ...details, state: 'bot-and-group-list' })
    await page.goto(environment.origin + environment.basePath + '/' + locale + '/settings/members?workspace=' + ids.settingsWorkspace, { waitUntil: 'domcontentloaded' })
    await page.getByRole('table').waitFor({ state: 'visible' })
    await page.getByRole('table').getByText(ownerName, { exact: true }).waitFor({ state: 'visible' })
    await shot(prefix + '-settings-' + width + '-' + scheme, { ...details, state: 'members-settings' })
  }
  assert.equal(manifest.captures.length, 32)
  assert.deepEqual(manifest.pageErrors, [])
  assert.deepEqual(manifest.httpFailures, [])
  manifest.status = 'completed'; manifest.finishedAt = new Date().toISOString(); await save()
  manifest.audit = await auditEvidence([directory], { environment }); await save()
  console.log(JSON.stringify({ captures: manifest.captures.length, sha, manifest: directory + '/manifest.json', audit: manifest.audit }))
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: directory + '/failure-page.png' }).catch(() => {})
    await writeFile(directory + '/failure-body.txt', await page.locator('body').innerText().catch(() => 'unavailable'))
  }
  manifest.failedPage = page?.url() ?? null
  manifest.status = 'failed'; manifest.error = { name: error?.name ?? 'unknown', message: String(error?.message ?? '').slice(0, 400) }; await save(); throw error
} finally {
  await browser?.close()
  if (scope) {
    if (groupId) await db.query('DELETE FROM conversations WHERE id=$1 AND "workspaceId"=$2 AND "createdBy"=$3', [groupId, workspaceId, userId])
    if (fixtureInserted) {
      await db.query('DELETE FROM coordinator_messages WHERE id=$1 AND "userId"=$2', [ids.message, userId])
      await db.query('DELETE FROM agent_runs WHERE id=ANY($1) AND "userId"=$2', [ids.runs, userId])
      await db.query('DELETE FROM issues WHERE id=ANY($1) AND "userId"=$2', [ids.issues, userId])
      await db.query('DELETE FROM agents WHERE id=$1 AND "userId"=$2', [ids.agent, userId])
      await db.query('DELETE FROM bots WHERE id=ANY($1) AND "ownerId"=$2', [ids.bots, userId])
    }
    await db.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2)', [ids.settingsWorkspace, [userId, scope.peer.userId]])
    await db.query('DELETE FROM mikka_workspaces WHERE id=$1 AND "userId"=$2', [ids.settingsWorkspace, userId])
    for (const resource of reserved) await scope.markResourceCleaned(resource)
    const released = await scope.release({ outcome: 'dirty' })
    manifest.cleanup = { fixtureResourcesRemoved: true, leaseState: released?.state, reason: 'Exact local display fixtures removed; pair quarantined', at: new Date().toISOString() }; await save()
  }
  await db.end()
}
