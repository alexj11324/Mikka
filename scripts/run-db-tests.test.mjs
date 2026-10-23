import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { BOOTSTRAP, REQUIRED_SUITES, checkSummary, inventory, main, parseSummary, readTree, validateTarget } from './run-db-tests.mjs'

const target = 'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e'
const env = { CI: 'true', GITHUB_ACTIONS: 'true', E2E_DATABASE_URL: target, MIKKA_DATABASE_URL: target, DATABASE_URL: target }
const sample = REQUIRED_SUITES[0]
const files = { [sample.marker]: '', [sample.file]: "import { Pool } from 'pg'" }
const scripts = { [sample.script]: `node --test ${sample.file}` }

test('parses TAP/spec and rejects missing, zero, skipped, todo, cancelled or failed executions', () => {
  assert.deepEqual(parseSummary('# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'), { tests: 4, pass: 4, fail: 0, skipped: 0 })
  assert.deepEqual(parseSummary('ℹ tests 2\nℹ pass 1\nℹ skipped 1\n'), { tests: 2, pass: 1, skipped: 1 })
  assert.equal(checkSummary('s', 0, { tests: 3, pass: 3 }), null)
  for (const key of ['skipped', 'todo', 'fail', 'cancelled']) assert.match(checkSummary('s', 0, { tests: 3, pass: 2, [key]: 1 }), new RegExp(key))
  assert.match(checkSummary('s', 0, {}), /no node:test summary/)
  assert.match(checkSummary('s', 0, { tests: 0, pass: 0 }), /ran no tests/)
  assert.match(checkSummary('s', 0, { tests: 3, pass: 2 }), /count/)
  assert.match(checkSummary('s', 1, { tests: 3, pass: 3 }), /exited/)
  assert.match(checkSummary('s', null, { tests: 3, pass: 3 }), /exited/)
})
test('only matching ephemeral Actions URLs are permitted; missing DB fails before subprocess', () => {
  assert.doesNotThrow(() => validateTarget(env))
  for (const changes of [{ CI: '' }, { GITHUB_ACTIONS: '' }, { E2E_DATABASE_URL: '' }, { E2E_DATABASE_URL: 'postgres://business/db' }, { DATABASE_URL: 'postgres://business/db' }, { ORVILO_DATABASE_URL: 'postgres://business/db' }, { E2E_DATABASE_URL: target + '?options=x' }]) assert.throws(() => validateTarget({ ...env, ...changes }))
  let called = false
  assert.equal(main({ env: {}, run() { called = true } }), 1)
  assert.equal(called, false)
})
test('feature inventory fails on deleted suite, removed script or zero enrollment', () => {
  assert.deepEqual(inventory(files, scripts).scripts, [sample.script])
  assert.throws(() => inventory({ [sample.marker]: '' }, scripts), /Expected DB suite missing/)
  assert.throws(() => inventory(files, {}), /Required script/)
  assert.throws(() => inventory(files, { [sample.script]: 'node -e 0' }), /no longer runs/)
  assert.throws(() => inventory({}, {}), /No database suites/)
  assert.throws(() => inventory(files, scripts, ['test:active-agents']), /Expected DB suite missing/)
})
test('discovers every present pg/DB suite and rejects unregistered or ambiguous files', () => {
  const extra = 'tests/suggestions.db.test.ts'
  const tree = { ...files, [extra]: '', 'lib/another.test.ts': "const pg = await import('pg')" }
  assert.throws(() => inventory(tree, scripts), /needs one explicit/)
  const full = { ...scripts, 'test:suggestions-db': `node --test ${extra}`, 'test:another-db': 'node --test lib/another.test.ts' }
  assert.deepEqual(inventory(tree, full).scripts, ['test:another-db', sample.script, 'test:suggestions-db'].sort())
  assert.throws(() => inventory(tree, { ...full, 'test:duplicate': `node --test ${extra}` }), /found 2/)
})
test('this tree has explicit complete DB inventory and retains bootstrap ordering and pure gates', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const tree = readTree()
  const plan = inventory(tree, pkg)
  assert.ok(plan.scripts.includes('test:groups'))
  assert.ok(plan.scripts.includes('test:workspace-migration-db'))
  const workflow = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  assert.ok(workflow.includes(BOOTSTRAP))
  assert.ok(workflow.indexOf(BOOTSTRAP) < workflow.indexOf('- run: pnpm test:e2e:setup'))
  assert.ok(workflow.indexOf('- run: pnpm test:e2e:setup') < workflow.indexOf('run: pnpm test:db\n'))
  assert.match(workflow, /MIGRATION_BOOTSTRAP_CI: '1'/)
  assert.match(workflow, /REQUIRE_DB: '1'/)
  for (const name of ['test:agent', 'test:suggestions', 'test:integrations', 'test:issues', 'test:db-runner']) {
    assert.ok(workflow.includes(`pnpm ${name}`), `${name} strict gate retained`)
    assert.ok(pkg.check.includes(`pnpm ${name}`), `${name} in check`)
  }
  assert.ok(pkg['test:integrations'].includes('lib/issue-owner-scope.test.ts'))
})
