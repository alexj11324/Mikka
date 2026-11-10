import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CASES, extendFixtures } from './ui-proof-1782-fixtures.mjs'
import { DATABASE, PRODUCT, PRODUCT_TREE, OVERLAY, closedFailure, gallery, officialInboxLocators, officialTaskLocators, openOfficialOverview, selectOfficialWorkspace, sourceEvidence } from './ui-proof-1782.mjs'

const app = resolve(process.env.MIKKA_TEST_APP_DIR ?? '')
const output = resolve(process.env.MIKKA_UI_PROOF_OUTPUT ?? '')
assert.notEqual(output, app)
for (const key of ['DATABASE_URL', 'MIKKA_DATABASE_URL', 'E2E_DATABASE_URL']) assert.equal(process.env[key], DATABASE)
assert.equal(process.env.MIKKA_EDITION, 'cloud')
assert.ok(!process.env.MIKKA_CLOUD_BACKEND_URL)
process.chdir(app)
const fromApp = path => import(pathToFileURL(join(app, path)).href)
const require = createRequire(join(app, 'package.json'))
const { chromium, expect } = require('@playwright/test')
const { acquireTestAccounts, auditEvidence } = await fromApp('scripts/test-accounts/session.mjs')
const { loadEnvironment } = await fromApp('scripts/test-accounts/environment.mjs')
const { createParityFixtures } = await fromApp('apps/desktop/test/parity-fixtures.mjs')
const { captureGeneratedWorkspaceName } = await fromApp('apps/desktop/test/generated-workspace-name.mjs')
const { screenshot } = await fromApp('apps/desktop/test/parity-images.mjs')
const { encode, decode, DESKTOP_RPC_VERSION } = await fromApp('lib/desktop-rpc/wire.ts')
const { readCompiledBuild } = await fromApp('scripts/start-app.mjs')
const messages = JSON.parse(await readFile(join(app, 'messages/en.json'), 'utf8'))
const environment = await loadEnvironment()
assert.equal(environment.deploymentSha, PRODUCT)
assert.equal(environment.origin, 'http://localhost:3000')
assert.equal(environment.basePath, '/mikka')
await mkdir(output, { recursive: true })
const report = { version: 1, product: PRODUCT, productTree: PRODUCT_TREE, overlay: OVERLAY,
  scope: 'official_ui_isolated_production_build', synthetic: true, productionAcceptance: false, responseMocks: 0,
  edition: 'cloud', externalCloudServiceConfigured: false,
  startedAt: new Date().toISOString(), fixtureCases: CASES.map(({ key, taskStatus, runStatus, outcome, group, state }) => ({ key, taskStatus, runStatus, outcome, group, state })),
  screens: [], checks: [], cleanup: { browser: false, extension: false, base: false, workspaceName: false, lease: false }, result: 'running' }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
let scope, base, extension, browser, workspaceName, phase = 'source', primaryError, humanAssigneeName
const pageErrors = []

async function rpc(action, args) {
  assert.ok(['issues.getIssue', 'agents.pollIssueThreads'].includes(action))
  const response = await scope.owner.request('/api/rpc', { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json', 'x-mikka-rpc': '1',
    'x-mikka-workspace-id': base.fixture.workspace,
  }, body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action, args: encode(args) }) })
  assert.equal(response.ok, true, 'UI_PROOF_NORMAL_RPC_TRANSPORT')
  const body = await response.json()
  assert.equal(body.version, DESKTOP_RPC_VERSION); assert.equal(body.ok, true)
  const result = decode(body.result)
  assert.ok(!result?.error, 'UI_PROOF_NORMAL_RPC_REFUSED')
  return result
}

async function assertScope() {
  const numbers = new Set(), identifiers = new Set()
  for (const row of extension.rows) {
    const result = await rpc('issues.getIssue', [row.id])
    assert.equal(result.issue.id, row.id); assert.equal(result.issue.workspaceId, base.fixture.workspace)
    assert.equal(result.issue.userId, scope.owner.userId); assert.equal(result.issue.status, row.taskStatus)
    assert.equal(String(result.issue.metadata.number), row.number)
    assert.equal(result.issue.issuedIdentifier, row.identifier); assert.equal(result.issue.identifier, row.identifier)
    numbers.add(String(result.issue.metadata.number)); identifiers.add(result.issue.issuedIdentifier)
    assert.equal(result.issue.metadata.assignee.kind, 'member'); assert.equal(result.issue.metadata.assignee.id, scope.owner.userId)
    assert.ok(typeof result.issue.metadata.assignee.name === 'string' && result.issue.metadata.assignee.name.length > 0 && result.issue.metadata.assignee.name.length <= 200)
    humanAssigneeName ??= result.issue.metadata.assignee.name
    assert.equal(result.issue.metadata.assignee.name, humanAssigneeName)
    if (row.key === 'open') {
      assert.equal(String(result.issue.metadata.number), extension.baseNumber, 'UI_PROOF_BASE_TASK_NUMBER_CHANGED')
      assert.equal(result.issue.metadata.delegate.kind, 'bot'); assert.equal(result.issue.metadata.delegate.id, base.fixture.bot)
      const history = await rpc('agents.pollIssueThreads', [row.id])
      assert.equal(history.threads.length, 1)
      assert.equal(history.threads[0].id, row.run); assert.equal(history.threads[0].status, 'succeeded')
      assert.equal(history.threads[0].outcome, 'done')
    }
  }
  assert.equal(numbers.size, 5, 'UI_PROOF_DUPLICATE_TASK_NUMBER')
  assert.equal(identifiers.size, 5, 'UI_PROOF_DUPLICATE_TASK_IDENTIFIER')
  return { ...extension.identity, normalRpcConfirmed: true }
}

async function capture(page, name, title, theme, viewport) {
  await scope.assertActive()
  const filename = `${viewport.width === 390 ? 'narrow' : 'wide'}-${theme}-${name}.png`
  assert.ok(!report.screens.some(screen => screen.filename === filename))
  const shot = await screenshot(page, join(output, filename), { identities: base.fixture.dynamicIdentityEmails })
  report.screens.push({ name, title, theme, viewport, filename, sha256: sha256(shot.bytes), masks: shot.masks })
  console.log(JSON.stringify({ stage: 'captured', screen: name, theme, width: viewport.width }))
}

async function taskList(page, theme, viewport) {
  phase = 'task_list'
  await page.goto(`${environment.origin}/mikka/en/?bot=${base.fixture.bot}`, { waitUntil: 'domcontentloaded' })
  const overviewLabels = { overviewLabel: messages.Shell.panel.overview, panelLabel: messages.Shell.panel.label, tasksLabel: messages.Shell.panel.tasks }
  const panel = await openOfficialOverview(page, overviewLabels)
  const inbox = officialInboxLocators(page, messages.Nav.inbox)
  await expect(inbox.item).toHaveCount(1)
  await expect(inbox.count).toHaveCount(1)
  await expect(inbox.count).toHaveText('1')
  await expect(inbox.count).toHaveAttribute('title', '1')
  if (viewport.width === 1440) await expect(inbox.count).toBeVisible()
  assert.deepEqual(await panel.locator('[data-task-group]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-group'))), ['pending', 'todo', 'done'])
  for (const [group, count] of [['pending', 3], ['todo', 1], ['done', 1]]) {
    const section = panel.locator(`[data-task-group="${group}"]`)
    await expect(section.getByRole('button').first()).toContainText(String(count))
    await expect(section.getByRole('button').first()).toHaveAttribute('aria-expanded', group === 'done' ? 'false' : 'true')
  }
  await expect(panel.locator('[data-task-state="done"]')).toHaveCount(0)
  await panel.locator('[data-task-group="done"]').getByRole('button').first().click()
  await expect(panel.locator('[data-task-row]')).toHaveCount(5)
  const iconEvidence = []
  for (const row of extension.rows) {
    const item = panel.locator('button[data-task-row]').filter({ hasText: row.title })
    await expect(item).toHaveCount(1)
    await expect(item).toHaveAttribute('data-task-state', row.state)
    await expect(item).toHaveAttribute('data-task-row', row.group)
    await expect(item).toContainText(row.identifier)
    const icon = item.locator('svg').first()
    await expect(icon).toBeVisible()
    const drawing = await icon.evaluate(node => ({ shape: node.innerHTML, color: getComputedStyle(node).color }))
    iconEvidence.push({ key: row.key, shapeSha256: sha256(drawing.shape), color: drawing.color })
  }
  assert.equal(new Set(iconEvidence.slice(0, 3).map(item => item.shapeSha256)).size, 3)
  assert.equal(new Set(iconEvidence.slice(0, 3).map(item => item.color)).size, 3)
  await capture(page, 'task-groups-expanded', 'Dispatcher Overview: waiting, blocked, failed, still-open and completed tasks', theme, viewport)
  await page.goto(`${environment.origin}/mikka/en/?bot=${base.fixture.coordinator}`, { waitUntil: 'domcontentloaded' })
  const empty = await openOfficialOverview(page, overviewLabels)
  await expect(empty.getByText(messages.Shell.panel.noTasks, { exact: true })).toBeVisible()
  await expect(empty.locator('[data-task-row]')).toHaveCount(0)
  const emptyInbox = officialInboxLocators(page, messages.Nav.inbox)
  await expect(emptyInbox.item).toHaveCount(1)
  await expect(emptyInbox.count).toHaveCount(1)
  await expect(emptyInbox.count).toHaveText('1')
  await expect(emptyInbox.count).toHaveAttribute('title', '1')
  if (viewport.width === 1440) await expect(emptyInbox.count).toBeVisible()
  await capture(page, 'empty-dispatcher', 'Coordinator Overview has no tasks; the global Inbox still counts one', theme, viewport)
  report.checks.push({ case: 'task_groups', theme, width: viewport.width, taskCount: 5,
    surface: 'dispatcher_overview', pendingIndicator: 'inbox', globalWaitingCount: 1,
    renderedSlots: ['app-frame', 'thread', 'bot-tasks'],
    groups: { pending: 3, running: 0, todo: 1, done: 1 }, completedInitiallyFolded: true,
    openTaskWithSuccessfulAttempt: 'todo', emptyDispatcher: true, icons: iconEvidence })
}

async function taskDetail(page, theme, viewport) {
  phase = 'task_detail'
  const row = extension.rows.find(item => item.key === 'open')
  await page.goto(`${environment.origin}/mikka/en/?issue=${row.id}`, { waitUntil: 'domcontentloaded' })
  const delegated = messages.Workspace.activity.delegated.replace('{name}', base.fixture.botName)
  const frame = officialTaskLocators(page, { title: row.title, titleLabel: messages.Workspace.detail.titleLabel,
    propertiesLabel: messages.IssueDetail.propertiesHeading,
    assigneeLabel: messages.Metadata.assignee.aria.replace('{name}', humanAssigneeName),
    delegateLabel: messages.Metadata.assignee.delegatedTo.replace('{name}', base.fixture.botName),
    activityLabel: messages.Workspace.activity.title, delegated,
    threadLabel: messages.IssueDetail.frame.openThread.replace('{name}', base.fixture.agentLabel) })
  const { task, properties } = frame
  await expect(task).toHaveCount(1)
  await expect(task).toHaveAttribute('aria-busy', 'false')
  await expect(frame.title).toHaveValue(row.title)
  await expect(properties).toHaveCount(1)
  await expect(frame.assignee).toHaveCount(1)
  await expect(frame.assignee).toBeVisible()
  await expect(frame.assignee).toHaveText(humanAssigneeName)
  await expect(frame.delegate).toHaveCount(1)
  await expect(frame.delegate).toBeVisible()
  await expect(frame.delegate).toHaveText(base.fixture.botName)
  await expect(properties.getByRole('button', { name: messages.Issue.status.doing, exact: true })).toBeVisible()
  await properties.scrollIntoViewIfNeeded()
  await capture(page, 'human-and-delegate', 'Human assignee and separate Agent Delegate', theme, viewport)
  phase = 'task_detail_activity'
  await expect(frame.activity).toHaveCount(1)
  await expect(frame.delegation).toHaveCount(1)
  await expect(frame.delegation).toBeVisible()
  phase = 'task_detail_history'
  const result = frame.result
  await expect(result).toHaveCount(1)
  await expect(result).toBeVisible()
  const resultPrefix = `${base.fixture.agentLabel} ${messages.Shell.panel.task.result.done} ·`
  assert.ok((await result.innerText()).replace(/\s+/g, ' ').trim().startsWith(`${resultPrefix} `))
  await result.scrollIntoViewIfNeeded()
  await capture(page, 'delegation-and-history', 'Delegation event and successful historical attempt; task remains open', theme, viewport)
  report.checks.push({ case: 'human_delegate_history', theme, width: viewport.width, humanAssignee: true, separateDelegate: true, delegationActivity: true,
    surface: 'hosted_task_detail_frame', renderedSlots: ['task-detail'],
    historicalAttemptResult: 'done', taskStatus: 'doing' })
}

async function projectFailure(page, theme, viewport) {
  phase = 'project_stale_form'
  await page.goto(`${environment.origin}/mikka/en/?section=projects&project=${extension.project.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: messages.Projects.form.editTitle, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: messages.Projects.form.editTitle, exact: true })
  await expect(dialog).toBeVisible()
  const name = dialog.locator('#project-name')
  await expect(name).toHaveValue(extension.project.name)
  await name.fill('Unsaved review changes')
  await extension.advanceProjectRevision()
  const actualResponse = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/mikka/api/rpc' || response.request().method() !== 'POST') return false
    try { return response.request().postDataJSON().action === 'projects.saveProject' } catch { return false }
  }, { timeout: 45_000 })
  await dialog.getByRole('button', { name: messages.Projects.form.save, exact: true }).click()
  const response = await actualResponse
  assert.equal(response.ok(), true)
  assert.equal(await response.finished(), null)
  const envelope = await response.json()
  assert.equal(envelope.version, DESKTOP_RPC_VERSION); assert.equal(envelope.ok, true)
  const business = decode(envelope.result)
  assert.deepEqual(business, { error: messages.Errors.projectStale })
  await expect(dialog.getByRole('alert')).toHaveText(messages.Errors.projectStale)
  await expect(name).toHaveValue('Unsaved review changes')
  await expect(name).toBeEditable()
  await name.fill('The draft is still editable')
  await expect(name).toHaveValue('The draft is still editable')
  await expect(dialog.getByRole('button', { name: messages.Projects.form.save, exact: true })).toBeEnabled()
  await extension.assertProjectUnchanged()
  await dialog.getByRole('alert').scrollIntoViewIfNeeded()
  await capture(page, 'project-error-editable', 'Real stale-revision error; unsaved draft remains editable', theme, viewport)
  page.once('dialog', prompt => prompt.accept())
  await dialog.getByRole('button', { name: messages.Projects.form.close, exact: true }).click()
  await expect(dialog).not.toBeVisible()
  report.checks.push({ case: 'project_stale_form', theme, width: viewport.width, normalRpcBusinessError: true,
    serverProjectUnchanged: true, draftPreserved: true, editableAfterError: true, saveEnabledAfterError: true })
}

try {
  const sources = await sourceEvidence(app, { compiled: true })
  await writeFile(join(output, 'source-pair.json'), JSON.stringify(sources, null, 2) + '\n')
  const built = await readCompiledBuild(app, { expectedRevision: PRODUCT })
  const versionResponse = await fetch(`${environment.origin}/mikka/api/version`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  assert.equal(versionResponse.ok, true)
  const version = await versionResponse.json()
  assert.equal(version.build, built.appBuild); assert.equal(version.overlaySha, OVERLAY)
  report.compiled = { revision: built.revision, appBuild: built.appBuild, rendererBuild: sources.build.rendererBuild,
    lockSha256: built.lockSha256, routesSha256: built.routesSha256, tracingSha256: built.tracingSha256, servedBuildMatches: true, servedOverlayMatches: true }
  phase = 'acquire'
  const started = Date.now()
  scope = await acquireTestAccounts({ runId: `ui1782-${started}`, requestId: `ui1782-${started}`, workerId: 'official-ui-proof-1782', ttlMs: 300_000 })
  phase = 'workspace_name_baseline'
  workspaceName = await captureGeneratedWorkspaceName(scope)
  report.workspaceNameCleanup = workspaceName.read()
  phase = 'base_seed'
  base = await createParityFixtures(scope)
  phase = 'extension_seed'
  extension = await extendFixtures(scope, base.fixture)
  phase = 'scope'
  report.fixtureIdentity = await assertScope()
  phase = 'browser_launch'
  browser = await chromium.launch({ headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const theme of ['light', 'dark']) {
      phase = 'browser_context'
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'UTC', reducedMotion: 'reduce', colorScheme: theme })
      try {
        await context.addCookies(JSON.parse(await readFile(scope.owner.storageStatePath, 'utf8')).cookies)
        const page = await context.newPage()
        page.setDefaultTimeout(45_000)
        page.on('pageerror', error => pageErrors.push({ name: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError'].includes(error.name) ? error.name : 'OtherError' }))
        phase = 'browser_home'
        await page.goto(`${environment.origin}/mikka/en`, { waitUntil: 'domcontentloaded' })
        await selectOfficialWorkspace(page, { workspaceName: base.fixture.workspaceName, basePath: '/mikka', onPhase: value => { phase = value } })
        phase = 'theme_persist'
        await page.evaluate(value => localStorage.setItem('theme', value), theme)
        phase = 'theme_reload'
        await page.reload({ waitUntil: 'domcontentloaded' })
        phase = 'theme_ready'
        await page.waitForFunction(value => document.documentElement.classList.contains(value), theme)
        await taskList(page, theme, viewport)
        await taskDetail(page, theme, viewport)
        await projectFailure(page, theme, viewport)
        assert.deepEqual(await assertScope(), report.fixtureIdentity)
      } finally { await context.close() }
    }
  }
  assert.equal(report.screens.length, 20)
  assert.equal(report.checks.length, 12)
  assert.deepEqual(pageErrors, [], 'UI_PROOF_UNCAUGHT_PAGE_ERRORS')
  phase = 'source_after'
  assert.deepEqual(await sourceEvidence(app, { compiled: true }), sources)
  report.result = 'passed'
} catch (error) {
  primaryError = error
  report.result = 'failed'
  report.failure = closedFailure(phase, error)
} finally {
  async function cleanup(name, action) {
    try { await action(); report.cleanup[name] = true } catch (error) {
      primaryError ??= error
      report.cleanup[name] = false
      report.cleanupFailures ??= []; report.cleanupFailures.push(name)
      report.cleanupFailureDetails ??= []; report.cleanupFailureDetails.push({ resource: name, ...closedFailure(`cleanup_${name}`, error) })
    }
  }
  await cleanup('browser', async () => { if (browser) await browser.close() })
  if (extension) await cleanup('extension', extension.cleanup)
  if (base && report.cleanup.browser && report.cleanup.extension) await cleanup('base', base.cleanup)
  if (workspaceName && report.cleanup.browser && report.cleanup.extension && report.cleanup.base) {
    await cleanup('workspaceName', async () => { report.workspaceNameCleanup = await workspaceName.restore({ drained: true }) })
    report.workspaceNameCleanup = workspaceName.read()
  }
  if (scope) await cleanup('lease', () => scope.release({ outcome: report.cleanup.browser && report.cleanup.base && report.cleanup.extension && report.cleanup.workspaceName ? 'clean' : 'dirty' }))
  if (primaryError || Object.values(report.cleanup).some(value => value !== true)) report.result = 'failed'
  report.pageErrors = pageErrors
  report.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(output, 'index.html'), gallery(report))
  await auditEvidence([output], { environment })
}
console.log(JSON.stringify({ status: report.result, product: PRODUCT, overlay: OVERLAY, screenshots: report.screens.length,
  checks: report.checks.length, cleanup: report.cleanup, ...(report.failure ? { failure: report.failure } : {}) }))
if (report.result !== 'passed') process.exitCode = 1
