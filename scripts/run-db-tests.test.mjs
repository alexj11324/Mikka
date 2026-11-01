import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserArguments } from './ci-browser-tests.mjs'
import { BOOTSTRAP, BROWSER_SUITES, REQUIRED_SUITES, SELF_MANAGED, checkSummary, inventory, scriptSteps, shardScripts, main, parseSummary, readTree, validateTarget } from './run-db-tests.mjs'

const target = 'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e'
const env = { CI: 'true', GITHUB_ACTIONS: 'true', E2E_DATABASE_URL: target, MIKKA_DATABASE_URL: target, DATABASE_URL: target }
const sample = REQUIRED_SUITES[0]
const files = { [sample.marker]: '', [sample.file]: "import { Pool } from 'pg'" }
const scripts = { [sample.script]: `node --test ${sample.file}` }

function runnerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'tests'))
  const commands = Object.fromEntries(['a', 'b', 'c'].map(name => {
    const file = `tests/${name}.db.test.mjs`
    writeFileSync(join(root, file), '')
    return [`test:${name}-db`, `node --test ${file}`]
  }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: commands }))
  return { root, scripts: Object.keys(commands) }
}

test('DB shards are deterministic, disjoint and exhaustive, with unsharded execution as default', () => {
  const scripts = ['test:g', 'test:c', 'test:f', 'test:a', 'test:d', 'test:b', 'test:e']
  assert.deepEqual(shardScripts(scripts), scripts)
  assert.deepEqual(shardScripts(scripts, '1/4'), ['test:a', 'test:e'])
  for (let count = 1; count <= scripts.length; count++) {
    const shards = Array.from({ length: count }, (_, index) => shardScripts(scripts, `${index + 1}/${count}`))
    const combined = shards.flat()
    assert.equal(new Set(combined).size, scripts.length, `no overlap for ${count} shards`)
    assert.deepEqual(combined.sort(), [...scripts].sort(), `complete inventory for ${count} shards`)
    assert.ok(shards.every(shard => shard.length > 0))
  }
  assert.deepEqual(scripts, ['test:g', 'test:c', 'test:f', 'test:a', 'test:d', 'test:b', 'test:e'])
})

test('DB shard configuration rejects malformed, unsafe, out-of-range and empty selections', () => {
  for (const shard of ['', ' ', '1', '0/4', '1/0', '5/4', '1/-1', '1.5/4', '01/4', '1/04', '1/4\n', '1/4/2', '1/9007199254740992', null]) {
    assert.throws(() => shardScripts(['test:a'], shard), /DB_TEST_SHARD/, String(shard))
  }
  assert.throws(() => shardScripts(['test:a'], '2/2'), /selects no database suites/)
})

test('runner invokes only the selected scripts and retains full inventory and required environment', t => {
  const fixture = runnerFixture(t)
  const logs = []
  t.mock.method(console, 'log', message => logs.push(message))
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: '# tests 1\n# pass 1\n', stderr: '' }
  }
  const fullEnv = { ...env, DB_TEST_EXPECTED: fixture.scripts.join(',') }
  assert.equal(main({ root: fixture.root, env: { ...fullEnv, DB_TEST_SHARD: '1/2' }, run }), 0)
  assert.deepEqual(calls.map(call => call.args), [['-s', 'test:a-db'], ['-s', 'test:c-db']])
  assert.ok(logs.some(line => line.startsWith('Required DB inventory: ') && line.includes('test:b-db')))
  assert.ok(logs.includes('Required DB selection: {"shard":"1/2","total":3,"scripts":["test:a-db","test:c-db"]}'))
  for (const call of calls) {
    assert.equal(call.command, 'pnpm')
    assert.equal(call.options.cwd, fixture.root)
    assert.equal(call.options.env.REQUIRE_DB, '1')
    assert.equal(call.options.env.CONVERSATION_READS_REQUIRE_DB, '1')
    assert.equal(call.options.env.MIKKA_TEST_DB_PORT, '5432')
    assert.equal(call.options.env.DATABASE_URL, target)
  }
  calls.length = 0
  assert.equal(main({ root: fixture.root, env: fullEnv, run }), 0)
  assert.deepEqual(calls.map(call => call.args[1]), fixture.scripts)
})

test('runner validates all expected and discovered suites before sharding and before subprocesses', t => {
  const fixture = runnerFixture(t)
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  let called = false
  const run = () => { called = true }
  const shardEnv = { ...env, DB_TEST_SHARD: '1/2', DB_TEST_EXPECTED: fixture.scripts.join(',') }
  rmSync(join(fixture.root, 'tests/b.db.test.mjs'))
  assert.equal(main({ root: fixture.root, env: shardEnv, run }), 1)
  assert.ok(errors.some(error => /Expected DB script not enrolled: test:b-db/.test(error)))
  writeFileSync(join(fixture.root, 'tests/b.db.test.mjs'), '')
  writeFileSync(join(fixture.root, 'tests/unregistered.db.test.mjs'), '')
  assert.equal(main({ root: fixture.root, env: shardEnv, run }), 1)
  assert.ok(errors.some(error => /unregistered.db.test.mjs needs one explicit/.test(error)))
  assert.equal(called, false)
})

test('runner rejects invalid shards before execution and preserves per-shard summary failures', t => {
  const fixture = runnerFixture(t)
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  for (const shard of ['', '0/2', '3/2', '4/4']) {
    let called = false
    assert.equal(main({ root: fixture.root, env: { ...env, DB_TEST_SHARD: shard }, run() { called = true } }), 1)
    assert.equal(called, false)
  }
  for (const result of [
    { status: 1, stdout: '# tests 1\n# pass 1\n' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '# tests 0\n# pass 0\n' },
    { status: 0, stdout: '# tests 1\n# pass 0\n# skipped 1\n' },
  ]) {
    const calls = []
    assert.equal(main({ root: fixture.root, env: { ...env, DB_TEST_SHARD: '2/2' }, run(command, args) { calls.push(args[1]); return { ...result, stderr: '' } } }), 1)
    assert.deepEqual(calls, ['test:b-db'])
  }
  assert.ok(errors.some(error => /test:b-db exited with 1/.test(error)))
  assert.ok(errors.some(error => /test:b-db: no node:test summary/.test(error)))
  assert.ok(errors.some(error => /test:b-db: ran no tests/.test(error)))
  assert.ok(errors.some(error => /test:b-db: 1 skipped/.test(error)))
})

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
  // CI is no longer required; any loopback *_e2e database on any port is allowed.
  assert.doesNotThrow(() => validateTarget({ ...env, CI: '', GITHUB_ACTIONS: '' }))
  const local = 'postgresql://e2e:local@127.0.0.1:55594/fac_overnight_e2e'
  assert.doesNotThrow(() => validateTarget({ E2E_DATABASE_URL: local, MIKKA_DATABASE_URL: local, DATABASE_URL: local }))
  for (const changes of [{ E2E_DATABASE_URL: '' }, { E2E_DATABASE_URL: target.replace('mikka_e2e', 'mikka') }, { E2E_DATABASE_URL: target.replace('127.0.0.1', 'db.internal') }, { E2E_DATABASE_URL: 'postgres://business/db' }, { DATABASE_URL: 'postgres://business/db' }, { ORVILO_DATABASE_URL: 'postgres://business/db' }, { E2E_DATABASE_URL: target + '?options=x' }]) assert.throws(() => validateTarget({ ...env, ...changes }))
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
test('type-only pg imports do not enroll source-only tests as database suites', () => {
  const tree = { ...files,
    'lib/pure.test.ts': "import type { Pool, PoolClient } from 'pg'\nconst fakePool = {}",
    'lib/multiline-pure.test.ts': 'import type {\n PoolClient,\n} from "pg";\nconst fakeClient = {}',
  }
  assert.deepEqual(inventory(tree, scripts).scripts, [sample.script])
  assert.deepEqual(inventory(tree, scripts).files, [sample.file])
  assert.throws(() => inventory({ ...tree, 'lib/runtime.test.ts': "import { Pool } from 'pg'" }, scripts), /needs one explicit/)
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
test('dedicated browser inventory requires its spec, config and script, without exempting adjacent DB tests', () => {
  const suite = BROWSER_SUITES[0]
  const tree = { ...files, ...Object.fromEntries(BROWSER_SUITES.flatMap(suite => [[suite.file, "import { Pool } from 'pg'"], [suite.config, 'export default {}']])) }
  const commands = { ...scripts, [suite.script]: `playwright test --config=${suite.config}` }
  const plan = inventory(tree, commands)
  assert.deepEqual(plan.browser, BROWSER_SUITES.map(suite => suite.file).sort())
  assert.deepEqual(plan.scripts, [sample.script], 'Playwright is not sent to the node:test summary checker')
  assert.throws(() => inventory(tree, scripts), /Browser script .* missing/)
  assert.throws(() => inventory(tree, { ...commands, [suite.script]: 'playwright test' }), /no longer runs/)
  const noSpec = { ...tree }; delete noSpec[suite.file]
  assert.throws(() => inventory(noSpec, commands), /Expected browser suite missing/)
  const noConfig = { ...tree }; delete noConfig[suite.config]
  assert.throws(() => inventory(noConfig, commands), /config .* missing/)
  assert.throws(() => inventory({ ...tree, 'tests/mvp/new.db.test.ts': "import { Pool } from 'pg'" }, commands), /needs one explicit package test script/)
  assert.throws(() => inventory({ ...tree, 'tests/mvp/new.spec.ts': "import { Pool } from 'pg'" }, commands), /needs one explicit package test script/)
})
test('real-driver offline exclusions require the actual source guard and the explicit pure script',()=>{
  const entry={file:'scripts/offline.test.mjs',script:'test:offline',guard:'scripts/guard.mjs',reason:'reviewed zero-transport test'}
  const tree={...files,[entry.file]:"import './guard.mjs'; import pg from 'pg'",[entry.guard]:'deny native transport'}
  const commands={...scripts,[entry.script]:`node --import ./${entry.guard} --test ${entry.file}`}
  assert.deepEqual(inventory(tree,commands,[],REQUIRED_SUITES,[],[entry]).offlineGuarded,[entry.file])
  assert.throws(()=>inventory({...tree,[entry.file]:"import pg from 'pg'"},commands,[],REQUIRED_SUITES,[],[entry]),/source guard/)
  assert.throws(()=>inventory(tree,{...commands,[entry.script]:`node --test ${entry.file}`},[],REQUIRED_SUITES,[],[entry]),/source guard/)
  assert.throws(()=>inventory(tree,commands,[],REQUIRED_SUITES,[],[{...entry,reason:''}]),/source guard/)
})
test('offline guard must be on the same step that runs the guarded file (GM3)',()=>{
  const entry={file:'scripts/offline.test.mjs',script:'test:offline',guard:'scripts/guard.mjs',reason:'reviewed zero-transport test'}
  const tree={...files,[entry.file]:"import './guard.mjs'; import pg from 'pg'",[entry.guard]:'deny native transport'}
  const run=command=>inventory(tree,{...scripts,[entry.script]:command},[],REQUIRED_SUITES,[],[entry])
  assert.deepEqual(run(`node --test a.test.mjs; r1=$?; node --import ./${entry.guard} --test ${entry.file}; r2=$?; exit $((r1|r2))`).offlineGuarded,[entry.file])
  for (const sep of ['&&',';','||']) assert.throws(()=>run(`node --test ${entry.file} ${sep} node --import ./${entry.guard} --test other.test.mjs`),/source guard/)
  assert.throws(()=>run(`node --import ./${entry.guard}x --test ${entry.file}`),/source guard/)
  assert.deepEqual(scriptSteps('a && b; c || d'),['a','b','c','d'])
})
test('test:personal-mailbox-core runs the runtime-off step even when the first step fails, and still fails overall',()=>{
  const command=JSON.parse(readFileSync('package.json','utf8')).scripts['test:personal-mailbox-core']
  const steps=command.split(/;\s*/)
  const nodeSteps=steps.filter(step=>/^node\s/.test(step))
  assert.equal(nodeSteps.length,2)
  assert.ok(nodeSteps[1].includes('lib/personal-mailbox-runtime-off.test.ts'))
  const run=(first,second)=>{
    let i=0
    const stubbed=steps.map(step=>/^node\s/.test(step)?(i++===0?`echo first; ${first}`:`echo second; ${second}`):step).join('; ')
    return spawnSync('sh',['-c',stubbed],{encoding:'utf8'})
  }
  for (const [first,second,code] of [['true','true',0],['false','true',1],['true','false',1],['false','false',1]]) {
    const r=run(first,second)
    assert.equal(r.stdout,'first\nsecond\n',`both steps run (${first},${second})`)
    assert.equal(r.status===0?0:1,code,`exit for (${first},${second})`)
  }
})
test('offline guard import is resolved relative to the suite file',()=>{
  const entry={file:'lib/nested/offline.test.ts',script:'test:offline',guard:'scripts/guard.mjs',reason:'reviewed zero-transport test'}
  const tree={...files,[entry.file]:"import '../../scripts/guard.mjs'\nimport pg from 'pg'",[entry.guard]:'deny native transport'}
  const commands={...scripts,[entry.script]:`node --import ./${entry.guard} --test ${entry.file}`}
  assert.deepEqual(inventory(tree,commands,[],REQUIRED_SUITES,[],[entry]).offlineGuarded,[entry.file])
  assert.throws(()=>inventory({...tree,[entry.file]:"import './guard.mjs'\nimport pg from 'pg'"},commands,[],REQUIRED_SUITES,[],[entry]),/source guard/)
})
test('this tree has explicit complete DB inventory and retains bootstrap ordering and pure gates', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const tree = readTree()
  assert.ok(Object.hasOwn(tree, 'scripts/run-db-tests.test.mjs'), 'script-hosted suites are discovered too')
  const plan = inventory(tree, pkg)
  assert.ok(plan.scripts.includes('test:groups'))
  assert.ok(plan.scripts.includes('test:workspace-migration-db'))
  assert.ok(plan.scripts.includes('test:local-repository-migration-db'))
  assert.ok(plan.scripts.includes('test:relation-cycle'))
  assert.ok(plan.scripts.includes('test:coordinator-native'))
  assert.ok(plan.files.includes('lib/coordinator/native-relay.db.test.ts'))
  assert.ok(plan.selfManaged.includes('lib/auth-email.test.ts'))
  assert.ok(plan.scripts.includes('test:factory'))
  assert.ok(plan.files.includes('lib/self-improvement/wiring-postgres.test.ts'))
  const workflow = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const custodyWorkflow = readFileSync('.github/workflows/e2b-byos.yml', 'utf8')
  const browser = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  assert.match(browser, /run: pnpm test:factory-http/ , 'Factory HTTP probes remain mandatory against the built app')
  assert.ok(browser.includes('pnpm exec next build'))
  for (const job of ['\n  browser-pr:\n', '\n  browser-runtime:\n']) {
    const section = browser.split(job)[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0]
    assert.ok(section.includes('run: pnpm test:factory-http'), `${job.trim()} runs Factory HTTP against the built app`)
  }
  const pullRequest = browser.split('\n  browser-pr:\n')[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0]
  assert.ok(pullRequest.indexOf('pnpm exec next build') < pullRequest.indexOf('run: pnpm test:factory-http'))
  for (const { runner } of SELF_MANAGED) {
    const dedicatedScript = Object.entries(pkg).find(([, command]) => command === `node ${runner}`)?.[0]
    assert.ok(workflow.includes(`run: node ${runner}`) || browser.includes(`run: node ${runner}`) || (dedicatedScript && custodyWorkflow.includes(`run: pnpm ${dedicatedScript}`)), `${runner} runs in CI`)
  }
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
  assert.ok(browser.includes('node scripts/ci-browser-tests.mjs --shard=${{ matrix.shard }}/$BROWSER_SHARDS > "$log_file"'), 'each isolated shard runs the selected layer')
  assert.deepEqual(browserArguments('full', '[]'), ['exec', 'playwright', 'test', '--grep-invert', '@performance'], 'integration retains every non-performance browser spec through the selected-layer runner')
  const runtime = browser.split('\n  browser-runtime:\n')[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0]
  assert.match(runtime, /^\s*pnpm test:e2e:mvp > "\$log_file" 2>&1 \|\| test_status=\$\?/m, 'main and full tiers run both MVP cases')
  assert.doesNotMatch(runtime, /mvp_args|BROWSER_TIER:/)
  assert.match(pullRequest, /^\s*pnpm test:e2e:mvp --grep @smoke > /m, 'PR runtime runs the one smoke MVP case')
  assert.match(browser, /log_file=\.cache\/e2e\/playwright-mvp\.log[\s\S]*?audit-evidence --evidence "\$log_file"[\s\S]*?exit "\$test_status"/, 'MVP output is audited before display and the test result is preserved')
  assert.equal(pkg['test:e2e:mvp'], 'playwright test --config=playwright.mvp.config.ts')
  assert.deepEqual(plan.browser, ['tests/mvp/coordinator-streaming.spec.ts', 'tests/mvp/core-loop.spec.ts'])
  const mvpConfig = readFileSync('playwright.mvp.config.ts', 'utf8')
  assert.match(mvpConfig, /testDir:\s*['"]\.\/tests\/mvp['"]/)
  assert.match(mvpConfig, /testMatch:\s*['"]\*\*\/\*\.spec\.ts['"]/)
  assert.ok(tree['tests/mvp/core-loop.spec.ts']?.includes('@playwright/test'), 'the real-daemon browser spec remains present')
  assert.match(browser, /MIKKA_TEST_MODE: '1'/)
  assert.match(browser, /MIKKA_MVP_E2E: '1'/)
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

test('isolated fixture databases reject application targets before I/O', async () => {
  const { isolatedPostgresURL } = await import('../tests/helpers/isolated-postgres.mjs')
  for (const target of ['postgresql://business.invalid/mikka_e2e', 'postgresql://localhost/mikka',
    'https://localhost/mikka_e2e', 'postgresql://localhost/mikka_e2e?options=-c%20search_path=public',
    'postgresql://localhost/mikka_e2e#fragment']) {
    await assert.rejects(isolatedPostgresURL(target), /disposable test database/)
  }
})

test('isolated fixture databases create distinct empty databases and close admin pools on success or failure', async t => {
  const { Pool } = await import('pg')
  const { isolatedPostgresURL } = await import('../tests/helpers/isolated-postgres.mjs')
  const queries = []
  let ended = 0
  t.mock.method(Pool.prototype, 'query', async sql => { queries.push(sql) })
  t.mock.method(Pool.prototype, 'end', async () => { ended++ })
  const first = new URL(await isolatedPostgresURL(target))
  const second = new URL(await isolatedPostgresURL(target))
  assert.notEqual(first.pathname, second.pathname)
  assert.match(first.pathname, /^\/mikka_fixture_[a-f0-9]{32}$/)
  assert.equal(first.origin, new URL(target).origin)
  assert.equal(first.username, new URL(target).username)
  assert.equal(first.password, new URL(target).password)
  assert.deepEqual(queries, [first, second].map(url => `CREATE DATABASE "${url.pathname.slice(1)}" TEMPLATE template0`))
  assert.equal(ended, 2)
  t.mock.method(Pool.prototype, 'query', async () => { throw new Error('no createdb permission') })
  await assert.rejects(isolatedPostgresURL(target), /no createdb permission/)
  assert.equal(ended, 3)
})
