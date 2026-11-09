import assert from 'node:assert/strict'
import test from 'node:test'
import { BRANCH, CONTROL_PARENT, DATABASE, OVERLAY, PRODUCT, PRODUCT_TREE, PUBLIC_TARGETS, REQUIRED_SLOTS, closedFailure, gallery, validateInventory, validateInvocation, validateWorkspaceNameCleanup } from './ui-proof-1782.mjs'
import { CASES, freshTaskContent } from './ui-proof-1782-fixtures.mjs'

const control = '1234567890abcdef1234567890abcdef12345678'
function valid() {
  return {
    env: { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_ACTOR: 'alexj11324', GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: `refs/heads/${BRANCH}`, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: control,
      MIKKA_TEST_APP_DIR: '/isolated/app', BETTER_AUTH_URL: 'http://localhost:3000',
      MIKKA_EDITION: 'cloud',
      DATABASE_URL: DATABASE, MIKKA_DATABASE_URL: DATABASE, E2E_DATABASE_URL: DATABASE },
    event: { repository: { full_name: 'alexj11324/Mikka' }, ref: `refs/heads/${BRANCH}`, after: control, deleted: false },
    actual: { controlHead: control, controlParents: [CONTROL_PARENT], controlClean: true, productHead: PRODUCT, productTree: PRODUCT_TREE, productClean: true },
  }
}

test('exact source and owned push pass before the sole checkout credential', () => {
  const { env, event, actual } = valid()
  assert.deepEqual(validateInvocation(env, event, actual), { product: PRODUCT, productTree: PRODUCT_TREE, overlay: OVERLAY,
    repository: 'alexj11324/Mikka', branch: BRANCH, attempt: 1 })
})

for (const [name, section, field, value] of [
  ['foreign repository', 'env', 'GITHUB_REPOSITORY', 'foreign/Mikka'],
  ['foreign actor', 'env', 'GITHUB_ACTOR', 'other-owner'],
  ['manual input', 'env', 'GITHUB_EVENT_NAME', 'workflow_dispatch'],
  ['another branch', 'env', 'GITHUB_REF', 'refs/heads/main'],
  ['new attempt', 'env', 'GITHUB_RUN_ATTEMPT', '2'],
  ['relative app', 'env', 'MIKKA_TEST_APP_DIR', './app'],
  ['remote app', 'env', 'BETTER_AUTH_URL', 'https://mikka.app'],
  ['different edition', 'env', 'MIKKA_EDITION', 'community'],
  ['remote cloud service', 'env', 'MIKKA_CLOUD_BACKEND_URL', 'https://mikka-cloud.vercel.app'],
  ['application DB mismatch', 'env', 'MIKKA_DATABASE_URL', 'postgresql://remote/app'],
  ['workspace DB mismatch', 'env', 'DATABASE_URL', 'postgresql://remote/app'],
  ['test DB mismatch', 'env', 'E2E_DATABASE_URL', 'postgresql://remote/app'],
  ['deleted branch', 'event', 'deleted', true],
  ['event source mismatch', 'event', 'after', PRODUCT],
  ['event ref mismatch', 'event', 'ref', 'refs/heads/main'],
  ['event repository mismatch', 'event', 'repository', { full_name: 'foreign/Mikka' }],
  ['controller checkout mismatch', 'actual', 'controlHead', PRODUCT],
  ['controller parent mismatch', 'actual', 'controlParents', [OVERLAY]],
  ['controller multiple parents', 'actual', 'controlParents', [CONTROL_PARENT, OVERLAY]],
  ['dirty controller', 'actual', 'controlClean', false],
  ['product checkout mismatch', 'actual', 'productHead', OVERLAY],
  ['product tree mismatch', 'actual', 'productTree', OVERLAY],
  ['dirty product', 'actual', 'productClean', false],
]) test(`refuses ${name}`, () => {
  const values = valid()
  values[section][field] = value
  assert.throws(() => validateInvocation(values.env, values.event, values.actual), { name: 'AssertionError' })
})

test('the diagnostic append refuses to adopt the original product as its controller parent', () => {
  const { env, event, actual } = valid()
  actual.controlParents = [PRODUCT]
  assert.throws(() => validateInvocation(env, event, actual), { name: 'AssertionError' })
})

test('fixture diagnostics distinguish base and extension failures without changing their outcome', () => {
  const error = Object.assign(new Error('private fixture detail'), { name: 'TestAccountError', code: 'RESOURCE_ALREADY_EXISTS' })
  for (const phase of ['base_seed', 'extension_seed']) {
    assert.deepEqual(closedFailure(phase, error), { phase, kind: 'TestAccountError', code: 'RESOURCE_ALREADY_EXISTS' })
  }
  assert.equal(error.message, 'private fixture detail')
})

test('official parity insert diagnostics retain only the finite table and SQLSTATE shape', () => {
  assert.deepEqual(closedFailure('base_seed', { name: 'TestAccountError', code: 'PARITY_FIXTURE_INSERT_agent_runs_23514',
    message: 'secret parameter', stack: 'secret stack', detail: 'secret SQL' }),
  { phase: 'base_seed', kind: 'TestAccountError', code: 'PARITY_FIXTURE_INSERT', table: 'agent_runs', sqlstate: '23514' })
  assert.deepEqual(closedFailure('base_seed', { name: 'TestAccountError', code: 'PARITY_FIXTURE_INSERT_issues_UNKNOWN' }),
    { phase: 'base_seed', kind: 'TestAccountError', code: 'PARITY_FIXTURE_INSERT', table: 'issues', sqlstate: 'UNKNOWN' })
})

test('unknown codes, private fields and foreign table names never become evidence', () => {
  for (const code of ['secret-token', 'PARITY_FIXTURE_INSERT_private_table_23514', 'PARITY_FIXTURE_INSERT_issues_23514 secret',
    'PARITY_FIXTURE_INSERT_issues_23514\n', undefined, { message: 'secret-token' }]) {
    const result = closedFailure('extension_seed', { name: 'TestAccountError', code, message: 'secret-token', stack: 'secret-token', detail: 'secret-token' })
    assert.deepEqual(result, { phase: 'extension_seed', kind: 'TestAccountError', code: 'unclassified' })
    assert.ok(!JSON.stringify(result).includes('secret-token'))
  }
})

test('a generic error cannot impersonate an account code or emit an unbounded phase', () => {
  assert.deepEqual(closedFailure('private phase', { name: 'foreign name', code: 'RESOURCE_ALREADY_EXISTS', message: 'secret-token' }),
    { phase: 'unknown', kind: 'Error' })
  assert.deepEqual(closedFailure('scope', { name: 'AssertionError', code: 'RESOURCE_ALREADY_EXISTS' }),
    { phase: 'scope', kind: 'AssertionError' })
})

test('cleanup exposes only the existing closed lease and generated-name failure codes', () => {
  assert.deepEqual(closedFailure('cleanup_lease', { name: 'TestAccountError', code: 'ACCOUNT_DIRTY', message: 'private account contents' }),
    { phase: 'cleanup_lease', kind: 'TestAccountError', code: 'ACCOUNT_DIRTY' })
  assert.deepEqual(closedFailure('cleanup_workspaceName', { name: 'Error', code: 'WORKSPACE_NAME_CLEANUP_UNPROVEN', message: 'private workspace name' }),
    { phase: 'cleanup_workspaceName', kind: 'Error', code: 'WORKSPACE_NAME_CLEANUP_UNPROVEN' })
  assert.deepEqual(closedFailure('cleanup_workspaceName', { name: 'Error', code: 'WORKSPACE_NAME_PRIVATE_VALUE', message: 'private workspace name' }),
    { phase: 'cleanup_workspaceName', kind: 'Error' })
})

test('official browser initialization keeps each finite wait identifiable', () => {
  for (const phase of ['browser_launch', 'browser_context', 'browser_home', 'workspace_menu', 'workspace_sidebar',
    'workspace_selection', 'workspace_navigation', 'workspace_ready', 'theme_persist', 'theme_reload', 'theme_ready']) {
    assert.deepEqual(closedFailure(phase, { name: 'TimeoutError', message: 'private page or locator' }), { phase, kind: 'TimeoutError' })
  }
})

test('generated-name cleanup requires both sealed account baselines and only the proven name change', () => {
  const base = { captured: true, phase: 'unchanged', restored: false, ownerMatchesSealedBaseline: true, peerMatchesSealedBaseline: true }
  assert.equal(validateWorkspaceNameCleanup(base), true)
  assert.equal(validateWorkspaceNameCleanup({ ...base, phase: 'restored', restored: true, onlyGeneratedNameDifference: true }), true)
})

test('unproven, unrelated or incomplete generated-name cleanup cannot pass the gallery audit', () => {
  const base = { captured: true, phase: 'restored', restored: true, onlyGeneratedNameDifference: true,
    ownerMatchesSealedBaseline: true, peerMatchesSealedBaseline: true }
  for (const patch of [{ captured: false }, { phase: 'verify' }, { restored: false }, { onlyGeneratedNameDifference: false },
    { ownerMatchesSealedBaseline: false }, { peerMatchesSealedBaseline: false }]) {
    assert.throws(() => validateWorkspaceNameCleanup({ ...base, ...patch }), { name: 'AssertionError' })
  }
})

test('the finite fixture matrix includes an open Task with a successful attempt', () => {
  assert.equal(CASES.length, 5)
  assert.equal(CASES.filter(row => row.state === 'waiting').length, 1)
  assert.deepEqual(CASES.reduce((counts, row) => ({ ...counts, [row.group]: (counts[row.group] ?? 0) + 1 }), {}), { pending: 3, todo: 1, done: 1 })
  assert.deepEqual(CASES.find(row => row.key === 'open'), { key: 'open', title: 'Follow-up remains open', taskStatus: 'doing', runStatus: 'succeeded', outcome: 'done', group: 'todo', state: 'todo' })
  assert.ok(CASES.every(row => ['succeeded', 'failed'].includes(row.runStatus)))
})

test('new Task content releases only the inherited number and preserves the original Task', () => {
  const original = { type: 'doc', attrs: { mikka: { number: 17,
    assignee: { kind: 'member', id: 'leased-owner', name: 'Test owner', image: null },
    delegate: null, labels: ['review'], subscriberUserIds: ['leased-owner'], deletedAt: null } },
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic review' }] }] }
  const before = structuredClone(original)
  const fresh = freshTaskContent(original)
  assert.equal(Object.hasOwn(fresh.attrs.mikka, 'number'), false)
  assert.deepEqual(original, before)
  const expected = structuredClone(before); delete expected.attrs.mikka.number
  assert.deepEqual(fresh, expected)
  fresh.attrs.mikka.labels.push('new-task-only')
  assert.deepEqual(original, before, 'the existing Task and its history keep their own metadata and number')
})

test('gallery escapes labels and links only the supplied local screen files', () => {
  const html = gallery({ product: PRODUCT, overlay: OVERLAY,
    screens: [{ title: '<script>bad</script>', theme: 'light', viewport: { width: 390, height: 844 }, filename: 'narrow-light-task-groups-expanded.png' }] })
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('src="narrow-light-task-groups-expanded.png"'))
  assert.ok(html.includes(PRODUCT) && html.includes(OVERLAY))
  assert.ok(html.includes('no production or provider acceptance claim'))
})

const selectedInputs = REQUIRED_SLOTS.map(slot => `.hosted-ui/slots/${slot}.tsx`)
function inventory() { return { version: 1, target: 'web', rendererBuild: 'a'.repeat(64), serverModules: [],
  inputs: [...PUBLIC_TARGETS, ...selectedInputs], usedActions: ['issues.getIssue', 'agents.pollIssueThreads', 'projects.saveProject'] } }

test('requires the real production inventory to include all five public files and four private slots', () => {
  assert.deepEqual(validateInventory(inventory(), selectedInputs), { rendererBuild: 'a'.repeat(64), transformedModuleCount: 9 })
})
for (const path of [...PUBLIC_TARGETS, ...selectedInputs]) test(`refuses a build without ${path}`, () => {
  const value = inventory(); value.inputs = value.inputs.filter(input => input !== path)
  assert.throws(() => validateInventory(value, selectedInputs), { name: 'AssertionError' })
})
test('a desktop inventory, duplicate sources, server code and omitted save RPC are not proof', () => {
  for (const change of [value => { value.target = 'desktop' }, value => { value.inputs.push(value.inputs[0]) },
    value => { value.serverModules = ['server-code'] }, value => { value.usedActions.pop() }]) {
    const value = inventory(); change(value)
    assert.throws(() => validateInventory(value, selectedInputs), { name: 'AssertionError' })
  }
})
