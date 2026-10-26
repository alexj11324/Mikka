import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { BOOTSTRAP, REQUIRED_SUITES, SELF_MANAGED, checkSummary, inventory, main, parseSummary, readTree, validateTarget } from './run-db-tests.mjs'

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
  const extra = 'scripts/suggestions.db.test.ts'
  const tree = { ...files, [extra]: '', 'lib/another.test.ts': "const pg = await import('pg')" }
  assert.throws(() => inventory(tree, scripts), /needs one explicit/)
  const full = { ...scripts, 'test:suggestions-db': `node --test ${extra}`, 'test:another-db': 'node --test lib/another.test.ts' }
  assert.deepEqual(inventory(tree, full).scripts, ['test:another-db', sample.script, 'test:suggestions-db'].sort())
  assert.deepEqual(inventory(tree, full, ['test:another-db', sample.script, 'test:suggestions-db']).scripts, ['test:another-db', sample.script, 'test:suggestions-db'].sort(), 'pinned discovered suites are validated after enrollment')
  assert.throws(() => inventory(tree, full, ['test:not-present']), /Expected DB script not enrolled/)
  assert.throws(() => inventory(tree, { ...full, 'test:duplicate': `node --test ${extra}` }), /found 2/)
})
test('self-managed suites are excluded only with a reason and a live dedicated runner', () => {
  const own = { file: 'lib/own-db.test.ts', runner: 'scripts/test-own-db.mjs', reason: 'starts its own Postgres' }
  const tree = { ...files, [own.file]: "import { Pool } from 'pg'", [own.runner]: `spawn('node', ['--test', '${own.file}'])` }
  assert.throws(() => inventory(tree, scripts), /needs one explicit/, 'without the exclusion it must be enrolled')
  const plan = inventory(tree, scripts, [], REQUIRED_SUITES, [own])
  assert.deepEqual(plan.scripts, [sample.script])
  assert.deepEqual(plan.selfManaged, [own.file])
  assert.throws(() => inventory({ ...tree, [own.runner]: '' }, scripts, [], REQUIRED_SUITES, [own]), /no longer runs/)
  assert.throws(() => inventory(tree, scripts, [], REQUIRED_SUITES, [{ ...own, runner: 'scripts/gone.mjs' }]), /missing/)
  assert.throws(() => inventory(tree, scripts, [], REQUIRED_SUITES, [{ ...own, reason: '' }]), /needs a reason/)
  assert.throws(() => inventory({ ...tree, [own.runner]: sample.file }, scripts, [], REQUIRED_SUITES, [{ ...own, file: sample.file }]), /both required and self-managed/)
  for (const entry of SELF_MANAGED) assert.ok(entry.reason && entry.runner)
})
test('this tree has explicit complete DB inventory and retains bootstrap ordering and pure gates', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const tree = readTree()
  assert.ok(Object.hasOwn(tree, 'scripts/run-db-tests.test.mjs'), 'script-hosted suites are discovered too')
  const plan = inventory(tree, pkg)
  assert.ok(plan.scripts.includes('test:groups'))
  assert.ok(plan.scripts.includes('test:workspace-migration-db'))
  assert.ok(plan.scripts.includes('test:relation-cycle'))
  assert.ok(plan.scripts.includes('test:coordinator-native'))
  assert.ok(plan.files.includes('lib/coordinator/native-relay.db.test.ts'))
  assert.ok(plan.selfManaged.includes('lib/auth-email.test.ts'))
  assert.ok(plan.scripts.includes('test:factory'))
  assert.ok(plan.files.includes('lib/self-improvement/wiring-postgres.test.ts'))
  const workflow = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const browser = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  assert.match(browser, /run: pnpm test:factory-http/ , 'Factory HTTP probes remain mandatory against the built app')
  assert.ok(browser.indexOf('run: pnpm build') < browser.indexOf('run: pnpm test:factory-http'))
  // Pure gates also run without a database in the fast job; their DB run is still only through pnpm test:db.
  const pureGates = ['test:groups', 'test:active-agents', 'test:group-turns', 'test:issue-search']
  for (const script of plan.scripts) {
    if (!pureGates.includes(script)) assert.ok(!new RegExp(`pnpm ${script}(?:\\s|$)`).test(workflow), `${script} runs once, through pnpm test:db`)
  }
  assert.ok(!/node --test tests\/workspace-migration\.test\.mjs/.test(workflow), 'workspace migration runs once, through pnpm test:db')
  const pinned = workflow.match(/DB_TEST_EXPECTED: ([^\n]+)/)?.[1].split(',').sort()
  assert.deepEqual(pinned, plan.scripts, 'workflow explicitly pins every suite expected on this tree')
  for (const script of pureGates.slice(1)) {
    if (pkg[script]) {
      assert.ok(workflow.includes(`pnpm ${script}`), `${script} strict pure gate retained`)
      assert.ok(pkg.check.includes(`pnpm ${script}`), `${script} pure gate in check`)
    }
  }
  assert.ok(workflow.includes(BOOTSTRAP))
  assert.ok(workflow.indexOf(BOOTSTRAP) < workflow.indexOf('- run: pnpm test:e2e:setup'))
  assert.ok(workflow.indexOf('- run: pnpm test:e2e:setup') < workflow.indexOf('run: pnpm test:db\n'))
  assert.match(workflow, /MIGRATION_BOOTSTRAP_CI: '1'/)
  assert.match(workflow, /REQUIRE_DB: '1'/)
  assert.match(browser, /pnpm test:performance --output=performance-results/)
  assert.match(browser, /pnpm test:e2e --grep-invert @performance/)
  assert.match(workflow, /image: postgres:17/)
  for (const name of ['test:agent', 'test:suggestions', 'test:integrations', 'test:issues', 'test:db-runner']) {
    assert.ok(workflow.includes(`pnpm ${name}`), `${name} strict gate retained`)
    assert.ok(pkg.check.includes(`pnpm ${name}`), `${name} in check`)
  }
  assert.ok(pkg['test:integrations'].includes('lib/issue-owner-scope.test.ts'))
})

test('self-improvement DB suite stays mandatory when its feature exists', () => {
  const required = [{ marker: 'lib/self-improvement/store.ts', file: 'lib/self-improvement/postgres.test.ts', script: 'test:self-improvement-db' }]
  const tree = { [required[0].marker]: '', [required[0].file]: "import { Pool } from 'pg'" }
  const scripts = { 'test:self-improvement-db': 'node --import tsx --test lib/self-improvement/postgres.test.ts' }
  assert.deepEqual(inventory(tree, scripts, [], required).scripts, ['test:self-improvement-db'])
  assert.throws(() => inventory({ [required[0].marker]: '' }, scripts, [], required), /Expected DB suite missing/)
  assert.throws(() => inventory(tree, {}, [], required), /Required script/)
})
