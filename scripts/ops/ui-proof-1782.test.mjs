import assert from 'node:assert/strict'
import test from 'node:test'
import { BRANCH, DATABASE, OVERLAY, PRODUCT, PRODUCT_TREE, PUBLIC_TARGETS, REQUIRED_SLOTS, gallery, validateInventory, validateInvocation } from './ui-proof-1782.mjs'
import { CASES } from './ui-proof-1782-fixtures.mjs'

const control = '1234567890abcdef1234567890abcdef12345678'
function valid() {
  return {
    env: { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_ACTOR: 'alexj11324', GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: `refs/heads/${BRANCH}`, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: control,
      MIKKA_TEST_APP_DIR: '/isolated/app', BETTER_AUTH_URL: 'http://localhost:3000',
      MIKKA_EDITION: 'cloud',
      DATABASE_URL: DATABASE, MIKKA_DATABASE_URL: DATABASE, E2E_DATABASE_URL: DATABASE },
    event: { repository: { full_name: 'alexj11324/Mikka' }, ref: `refs/heads/${BRANCH}`, after: control, deleted: false },
    actual: { controlHead: control, controlParents: [PRODUCT], controlClean: true, productHead: PRODUCT, productTree: PRODUCT_TREE, productClean: true },
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
  ['controller multiple parents', 'actual', 'controlParents', [PRODUCT, OVERLAY]],
  ['dirty controller', 'actual', 'controlClean', false],
  ['product checkout mismatch', 'actual', 'productHead', OVERLAY],
  ['product tree mismatch', 'actual', 'productTree', OVERLAY],
  ['dirty product', 'actual', 'productClean', false],
]) test(`refuses ${name}`, () => {
  const values = valid()
  values[section][field] = value
  assert.throws(() => validateInvocation(values.env, values.event, values.actual), { name: 'AssertionError' })
})

test('the finite fixture matrix includes an open Task with a successful attempt', () => {
  assert.equal(CASES.length, 5)
  assert.equal(CASES.filter(row => row.state === 'waiting').length, 1)
  assert.deepEqual(CASES.reduce((counts, row) => ({ ...counts, [row.group]: (counts[row.group] ?? 0) + 1 }), {}), { pending: 3, todo: 1, done: 1 })
  assert.deepEqual(CASES.find(row => row.key === 'open'), { key: 'open', title: 'Follow-up remains open', taskStatus: 'doing', runStatus: 'succeeded', outcome: 'done', group: 'todo', state: 'todo' })
  assert.ok(CASES.every(row => ['succeeded', 'failed'].includes(row.runStatus)))
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
