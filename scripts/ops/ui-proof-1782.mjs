import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PRODUCT = 'ce6ad923bbb449023783052d0848db22e4360f1d'
export const PRODUCT_TREE = 'dffda64a4975b22cfc649908a8c5e19749ea8a96'
export const CONTROL_PARENT = '05dcab368eb963393189d8edbe94a6da9e4a6a53'
export const OVERLAY = 'fe20f19bcf82e6541430b62c450920ba42c95fb0'
export const BRANCH = 'ops/1782-official-ui-proof-20261109'
export const DATABASE = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_e2e'
export const PUBLIC_TARGETS = Object.freeze([
  'components/nav/all-threads-data.ts', 'hooks/use-bot-tasks.ts',
  'components/workspace/issue-detail-properties.tsx', 'components/workspace/issue-activity-feed.tsx',
  'components/workspace/project-form.tsx',
  'components/workspace/issue-workspace.tsx', 'components/nav/context-panel.tsx',
  'components/workspace/task-detail.tsx', 'components/workspace/task-detail-frame.tsx',
])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function validateInvocation(env, event, actual) {
  assert.equal(env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
  assert.equal(env.GITHUB_ACTOR, 'alexj11324')
  assert.equal(env.GITHUB_EVENT_NAME, 'push')
  assert.equal(env.GITHUB_REF, `refs/heads/${BRANCH}`)
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1')
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/)
  assert.equal(event.repository?.full_name, env.GITHUB_REPOSITORY)
  assert.equal(event.ref, env.GITHUB_REF)
  assert.equal(event.after, env.GITHUB_SHA)
  assert.equal(event.deleted, false)
  assert.equal(actual.controlHead, env.GITHUB_SHA)
  assert.deepEqual(actual.controlParents, [CONTROL_PARENT])
  assert.equal(actual.controlClean, true)
  assert.equal(actual.productHead, PRODUCT)
  assert.equal(actual.productTree, PRODUCT_TREE)
  assert.equal(actual.productClean, true)
  assert.equal(env.MIKKA_TEST_APP_DIR && isAbsolute(env.MIKKA_TEST_APP_DIR), true)
  assert.equal(env.BETTER_AUTH_URL, 'http://localhost:3000')
  assert.equal(env.MIKKA_EDITION, 'cloud')
  assert.ok(!env.MIKKA_CLOUD_BACKEND_URL)
  for (const key of ['DATABASE_URL', 'MIKKA_DATABASE_URL', 'E2E_DATABASE_URL']) assert.equal(env[key], DATABASE)
  return { product: PRODUCT, productTree: PRODUCT_TREE, overlay: OVERLAY, repository: env.GITHUB_REPOSITORY, branch: BRANCH, attempt: 1 }
}

const FAILURE_PHASES = new Set(['source', 'acquire', 'workspace_name_baseline', 'base_seed', 'extension_seed', 'scope', 'browser',
  'browser_launch', 'browser_context', 'browser_home', 'workspace_menu', 'workspace_sidebar', 'workspace_selection',
  'workspace_navigation', 'workspace_ready', 'theme_persist', 'theme_reload', 'theme_ready',
  'task_list', 'task_detail', 'task_detail_title', 'task_detail_properties', 'task_detail_assignee',
  'task_detail_delegate', 'task_detail_status', 'task_detail_activity', 'task_detail_history', 'project_stale_form', 'source_after',
  'cleanup_browser', 'cleanup_extension', 'cleanup_base', 'cleanup_workspaceName', 'cleanup_lease'])
const ACCOUNT_FAILURE_CODES = new Set([
  'ACCOUNT_POOL_DATABASE_ERROR', 'ACCOUNT_FOOTPRINT_UNPROVEN', 'INVALID_REQUEST', 'STALE_LEASE', 'LEASE_LOST',
  'LEASE_CLOSED', 'LEASE_ALREADY_COMPLETED', 'TEST_ACCOUNT_SESSION_FAILED', 'ACCOUNT_DIRTY',
  'SESSION_STATE_RETENTION_FAILED', 'SESSION_REVOCATION_NOT_AUTHORIZED',
  'RESOURCE_TYPE_FORBIDDEN', 'RESOURCE_OWNER_MISMATCH', 'RESOURCE_NOT_OWNED', 'RESOURCE_ALREADY_EXISTS', 'RESOURCE_STILL_PRESENT',
  'PARITY_FIXTURE_EPOCH_INVALID', 'PARITY_TASK_IDENTITY_INVALID',
  'PARITY_READ_BASELINE_PRESENT', 'PARITY_READ_OWNERSHIP_UNPROVEN', 'PARITY_READ_CHANGED',
  'PARITY_DEFAULT_CLOCK_UNPROVEN', 'PARITY_DEFAULT_BASELINE_PRESENT', 'PARITY_DEFAULT_OWNERSHIP_UNPROVEN', 'PARITY_DEFAULT_CHANGED',
  'PRIVATE_DIRECTORY_UNSAFE', 'PRIVATE_FILE_UNSAFE', 'SECRET_AUDIT_INVALID', 'SECRET_AUDIT_UNREADABLE', 'SECRET_AUDIT_MISSING',
])
const PARITY_INSERT_FAILURE = /^PARITY_FIXTURE_INSERT_(mikka_workspaces|mikka_workspace_members|mikka_teams|mikka_team_members|bots|coordinator_bots|issues|issue_versions|mikka_team_issues|devices|agents|agent_runs|run_chunks|artifacts|artifact_versions|artifact_shares|coordinator_messages|conversations|conversation_members|conversation_messages)_([A-Z0-9]{5}|UNKNOWN)$/
const WORKSPACE_NAME_FAILURE_CODES = new Set(['WORKSPACE_NAME_SCOPE_REQUIRED', 'WORKSPACE_NAME_DRAIN_REQUIRED',
  'WORKSPACE_NAME_CLEANUP_UNPROVEN', 'WORKSPACE_NAME_REAUTH_REQUIRED', 'WORKSPACE_NAME_RESTORE_FAILED'])

/** Preserve only the fixture's existing closed code. Never serialize a message,
 * stack, SQL, parameter, identity or arbitrary driver property into evidence. */
export function closedFailure(phase, error) {
  const kind = ['AssertionError', 'TimeoutError', 'TestAccountError', 'EnvironmentError'].includes(error?.name) ? error.name : 'Error'
  const result = { phase: FAILURE_PHASES.has(phase) ? phase : 'unknown', kind }
  if (kind === 'Error' && WORKSPACE_NAME_FAILURE_CODES.has(error?.code)) return { ...result, code: error.code }
  if (kind !== 'TestAccountError') return result
  const code = typeof error.code === 'string' ? error.code : ''
  if (ACCOUNT_FAILURE_CODES.has(code)) return { ...result, code }
  const inserted = PARITY_INSERT_FAILURE.exec(code)
  if (inserted) return { ...result, code: 'PARITY_FIXTURE_INSERT', table: inserted[1], sqlstate: inserted[2] }
  return { ...result, code: 'unclassified' }
}

/** The pinned official shell exposes its real Workspace menu as a radio menu.
 * Use ordinary clicks and observe its actual document navigation. The public
 * shell's fixed button label and aria-current contract do not apply here. */
export async function selectOfficialWorkspace(page, { workspaceName, basePath, onPhase = () => {} }) {
  assert.equal(basePath, '/mikka')
  assert.ok(typeof workspaceName === 'string' && workspaceName.length > 0 && workspaceName.length <= 120)
  onPhase('workspace_menu')
  const trigger = page.locator('.ui-as-ws-menu > button.ui-as-side__workspace')
  await trigger.waitFor({ state: 'attached' })
  assert.equal(await trigger.count(), 1)
  if (!(await trigger.isVisible())) {
    onPhase('workspace_sidebar')
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  }
  await trigger.waitFor({ state: 'visible' })
  await trigger.click()
  onPhase('workspace_selection')
  const item = page.getByRole('menuitemradio', { name: workspaceName, exact: false })
  await item.waitFor({ state: 'visible' })
  assert.equal(await item.count(), 1)
  const current = await item.getAttribute('aria-checked')
  assert.ok(current === 'true' || current === 'false')
  if (current === 'true') await item.click()
  else {
    onPhase('workspace_navigation')
    await Promise.all([page.waitForEvent('domcontentloaded'), item.click()])
  }
  onPhase('workspace_ready')
  await page.waitForURL(url => url.pathname === `${basePath}/en` || url.pathname === `${basePath}/en/`)
  const selected = page.locator('.ui-as-ws-menu .ui-as-side__name').filter({ hasText: workspaceName })
  await selected.waitFor({ state: 'attached' })
  assert.equal(await selected.count(), 1)
  assert.equal(await selected.textContent(), workspaceName)
}

/** The property summary and activity event intentionally share their wording.
 * Select the actual named activity section so one cannot stand in for the other. */
export function taskActivityLocators(task, { label, delegated }) {
  const region = task.getByRole('region', { name: label, exact: true })
  return { region, delegation: region.getByText(delegated, { exact: false }),
    result: region.locator('[data-run-result="done"]') }
}

/** The official frame moves Overview into the conversation work area. Follow
 * its visible controls; an old ?threads= address now redirects to Tasks. */
export async function openOfficialOverview(page, { overviewLabel, panelLabel, tasksLabel }) {
  for (const value of [overviewLabel, panelLabel, tasksLabel]) assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 120)
  const opener = page.getByRole('button', { name: 'Open artifacts', exact: true })
  await opener.waitFor({ state: 'visible' })
  assert.equal(await opener.count(), 1)
  await opener.click()
  const area = page.getByRole('complementary', { name: 'Artifacts', exact: true })
  await area.waitFor({ state: 'visible' })
  assert.equal(await area.count(), 1)
  const overview = area.getByRole('region', { name: 'Tools', exact: true }).getByRole('button', { name: overviewLabel, exact: true })
  await overview.waitFor({ state: 'visible' })
  assert.equal(await overview.count(), 1)
  await overview.click()
  const panel = area.getByRole('complementary', { name: panelLabel, exact: true })
  await panel.waitFor({ state: 'visible' })
  assert.equal(await panel.count(), 1)
  const tasks = panel.getByRole('tab', { name: tasksLabel, exact: true })
  await tasks.waitFor({ state: 'visible' })
  assert.equal(await tasks.count(), 1)
  await tasks.click()
  assert.equal(await tasks.getAttribute('aria-selected'), 'true')
  return panel
}

/** The same global pending count now belongs to the official Inbox navigation
 * item. It is independent of the dispatcher whose Overview is open. */
export function officialInboxLocators(page, label) {
  assert.ok(typeof label === 'string' && label.length > 0 && label.length <= 120)
  const item = page.locator('nav.ui-as-side__nav button.ui-as-side__item').filter({ has: page.getByText(label, { exact: true }) })
  return { item, count: item.locator('.ui-as-side__count') }
}

/** Match the pinned hosted frame itself, never silently accept the old public
 * fallback. Human responsibility, explicit delegation and historical activity
 * each have their own named element. */
export function officialTaskLocators(page, { title, titleLabel, propertiesLabel, assigneeLabel, delegateLabel, activityLabel, delegated, threadLabel }) {
  for (const value of [title, titleLabel, propertiesLabel, assigneeLabel, delegateLabel, activityLabel, delegated, threadLabel]) assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 250)
  const task = page.getByRole('region', { name: title, exact: true }).filter({ has: page.locator('textarea.ui-kb-issue__title') })
  const properties = task.getByRole('complementary', { name: propertiesLabel, exact: true })
  const activity = task.getByRole('region', { name: activityLabel, exact: true })
  const assignee = properties.getByRole('button', { name: assigneeLabel, exact: true })
  const delegate = properties.getByLabel(delegateLabel, { exact: true })
  return { task, title: task.getByRole('textbox', { name: titleLabel, exact: true }), properties,
    assignee, assigneeValue: assignee.locator(':scope > span.ui-kb-create__clip'),
    delegate, delegateValue: delegate.locator(':scope > span.ui-kb-create__clip'),
    activity, delegation: activity.getByText(delegated, { exact: false }),
    result: activity.getByRole('button', { name: threadLabel, exact: true }) }
}

/** Compile inventory and visible UI are different evidence. The gallery must
 * name exactly the surfaces actually traversed in each theme and viewport. */
export function validateSemanticChecks(checks) {
  assert.ok(Array.isArray(checks))
  assert.equal(checks.length, 12)
  const seen = new Set()
  for (const row of checks) {
    assert.ok(['light', 'dark'].includes(row.theme))
    assert.ok([1440, 390].includes(row.width))
    assert.ok(['task_groups', 'human_delegate_history', 'project_stale_form'].includes(row.case))
    const identity = `${row.case}:${row.theme}:${row.width}`
    assert.ok(!seen.has(identity)); seen.add(identity)
    if (row.case === 'task_groups') {
      assert.equal(row.surface, 'dispatcher_overview')
      assert.equal(row.pendingIndicator, 'inbox')
      assert.equal(row.globalWaitingCount, 1)
      assert.equal(Object.hasOwn(row, 'handCount'), false)
      assert.deepEqual(row.renderedSlots, ['app-frame', 'thread', 'bot-tasks'])
      assert.equal(row.taskCount, 5)
      assert.deepEqual(row.groups, { pending: 3, running: 0, todo: 1, done: 1 })
      assert.equal(row.completedInitiallyFolded, true)
      assert.equal(row.openTaskWithSuccessfulAttempt, 'todo')
      assert.equal(row.emptyDispatcher, true)
      assert.deepEqual(row.icons.map(icon => icon.key), ['waiting', 'blocked', 'failed', 'open', 'done'])
      for (const icon of row.icons) {
        assert.match(icon.shapeSha256, /^[a-f0-9]{64}$/)
        assert.ok(typeof icon.color === 'string' && icon.color.length > 0 && icon.color.length <= 100)
      }
      assert.equal(new Set(row.icons.slice(0, 3).map(icon => icon.shapeSha256)).size, 3)
      assert.equal(new Set(row.icons.slice(0, 3).map(icon => icon.color)).size, 3)
    } else if (row.case === 'human_delegate_history') {
      assert.equal(row.surface, 'hosted_task_detail_frame')
      assert.deepEqual(row.renderedSlots, ['task-detail'])
      for (const key of ['humanAssignee', 'separateDelegate', 'delegationActivity']) assert.equal(row[key], true)
      assert.equal(row.historicalAttemptResult, 'done')
      assert.equal(row.taskStatus, 'doing')
    } else {
      for (const key of ['normalRpcBusinessError', 'serverProjectUnchanged', 'draftPreserved', 'editableAfterError', 'saveEnabledAfterError']) assert.equal(row[key], true)
    }
  }
  return true
}

export function validateWorkspaceNameCleanup(value) {
  assert.equal(value?.captured, true)
  assert.ok(value.phase === 'unchanged' || value.phase === 'restored')
  assert.equal(value.ownerMatchesSealedBaseline, true)
  assert.equal(value.peerMatchesSealedBaseline, true)
  assert.equal(value.restored, value.phase === 'restored')
  if (value.restored) assert.equal(value.onlyGeneratedNameDifference, true)
  return true
}

export async function preflight(control, app, env = process.env) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
  return validateInvocation(env, event, {
    controlHead: git(control, ['rev-parse', 'HEAD']),
    controlParents: git(control, ['show', '-s', '--format=%P', 'HEAD']).split(' '),
    controlClean: git(control, ['status', '--porcelain', '--untracked-files=no']) === '',
    productHead: git(app, ['rev-parse', 'HEAD']), productTree: git(app, ['rev-parse', 'HEAD^{tree}']),
    productClean: git(app, ['status', '--porcelain', '--untracked-files=no']) === '',
  })
}

export const REQUIRED_SLOTS = Object.freeze(['all-threads', 'bot-tasks', 'task-column', 'task-conversation', 'app-frame', 'thread', 'task-detail'])

export function validateInventory(inventory, privateInputs) {
  assert.equal(inventory.version, 1)
  assert.equal(inventory.target, 'web')
  assert.match(inventory.rendererBuild, /^[a-f0-9]{64}$/)
  assert.deepEqual(inventory.serverModules, [])
  assert.ok(Array.isArray(inventory.inputs) && inventory.inputs.length > 0 && inventory.inputs.length <= 10_000)
  const inputs = new Set(inventory.inputs)
  assert.equal(inputs.size, inventory.inputs.length)
  for (const path of [...PUBLIC_TARGETS, ...privateInputs]) assert.ok(inputs.has(path), 'UI_PROOF_SOURCE_NOT_IN_PRODUCTION_BUILD')
  for (const action of ['issues.getIssue', 'agents.pollIssueThreads', 'projects.saveProject']) {
    assert.ok(inventory.usedActions.includes(action), 'UI_PROOF_ACTION_NOT_IN_PRODUCTION_BUILD')
  }
  return { rendererBuild: inventory.rendererBuild, transformedModuleCount: inputs.size }
}

/** Use the product's real bundler inventory. No private input list or source is
 * copied to evidence; only its digest, public paths and closed slot booleans. */
export async function sourceEvidence(app, { compiled = false } = {}) {
  assert.equal(git(app, ['rev-parse', 'HEAD']), PRODUCT)
  assert.equal(git(app, ['rev-parse', 'HEAD^{tree}']), PRODUCT_TREE)
  assert.equal(git(app, ['status', '--porcelain', '--untracked-files=no']), '')
  const overlayDirectory = await realpath(join(app, '.hosted-ui'))
  assert.equal(git(overlayDirectory, ['rev-parse', 'HEAD']), OVERLAY)
  assert.equal(git(overlayDirectory, ['status', '--porcelain', '--untracked-files=no']), '')
  assert.equal(await realpath(process.env.MIKKA_UI_OVERLAY_DIR), overlayDirectory)
  assert.equal(process.env.MIKKA_UI_OVERLAY_SHA, OVERLAY)
  const { uiOverlay } = await import(pathToFileURL(join(app, 'lib/ui-overlay.mjs')).href)
  const active = uiOverlay(app)
  assert.equal(active.dir, overlayDirectory)
  for (const slot of REQUIRED_SLOTS) assert.equal(active.slots[slot], join(overlayDirectory, 'slots', `${slot}.tsx`))
  let build = null
  if (compiled) {
    const bytes = await readFile(join(app, '.output/public/mikka/renderer-manifest.json'))
    const inventory = JSON.parse(bytes)
    const privateInputs = REQUIRED_SLOTS.map(slot => relative(app, active.slots[slot]).split(sep).join('/'))
    build = { ...validateInventory(inventory, privateInputs), inventorySha256: sha256(bytes) }
  }
  const targets = []
  for (const path of PUBLIC_TARGETS) targets.push({ path, sha256: sha256(await readFile(join(app, path))), includedInProductionBuild: compiled })
  const slots = REQUIRED_SLOTS.map(name => ({ name, privateOverlaySelected: true, includedInProductionBuild: compiled }))
  return { version: 1, product: PRODUCT, productTree: PRODUCT_TREE, overlay: OVERLAY,
    productionEntry: 'apps/frontend/src/index.tsx',
    inventorySemantics: 'transformed_source_modules_not_render_coverage', build, targets, slots }
}

export function gallery(manifest) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PR 1782 official UI proof</title>'
    + '<style>body{font:16px system-ui;margin:32px;background:#f7f7f8;color:#222}main{max-width:1440px;margin:auto}h1{font-size:26px}code{overflow-wrap:anywhere}figure{margin:24px 0;padding:16px;background:white;border:1px solid #ddd;border-radius:12px}img{display:block;max-width:100%;height:auto;margin-top:12px}figcaption{font-weight:600}p{line-height:1.6}</style><main>'
    + `<h1>PR 1782 · Official UI proof</h1><p>Production build, isolated PostgreSQL 17, ordinary authenticated RPC. Synthetic data; no production or provider acceptance claim.</p><p>Product <code>${escape(manifest.product)}</code><br>UI overlay <code>${escape(manifest.overlay)}</code></p>`
    + manifest.screens.map(screen => `<figure><figcaption>${escape(screen.title)} · ${escape(screen.theme)} · ${screen.viewport.width} × ${screen.viewport.height}</figcaption><img loading="lazy" src="${escape(screen.filename)}" alt="${escape(screen.title)}"></figure>`).join('')
    + '</main></html>\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = resolve(process.env.MIKKA_TEST_APP_DIR ?? '')
    if (process.argv[2] === 'preflight') {
      console.log(JSON.stringify({ status: 'source_guard_passed', ...await preflight(resolve(process.cwd()), app) }))
    } else if (process.argv[2] === 'source') {
      const result = await sourceEvidence(app)
      await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n')
      console.log(JSON.stringify({ status: 'source_pair_verified', product: PRODUCT, overlay: OVERLAY, publicTargets: result.targets.length }))
    } else throw new Error('UI_PROOF_COMMAND_REFUSED')
  } catch {
    console.error('UI_PROOF_SOURCE_GUARD_FAILED')
    process.exitCode = 1
  }
}
