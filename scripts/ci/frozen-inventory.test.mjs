import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

// Exact public registry from main ancestor 82d285edd2dfc9ee95622ec4a22c58436bffc255.
// PR #2624 retained it; #2904's real CI later received 93 incompatible main names.
const frozenBytes = readFileSync(new URL('./fixtures/frozen-82d285-tasks.json', import.meta.url))
const frozenTasks = JSON.parse(frozenBytes)
const currentTasks = readFileSync(new URL('./tasks.json', import.meta.url))
const selector = resolve('scripts/ci/select.mjs')
const runner = readFileSync(new URL('./fixtures/frozen-82d285-run-units.mjs.txt', import.meta.url))

function fixture(t, baseEdit) {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-frozen-ci-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'candidate')
  mkdirSync(root)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'CI fixture', GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'CI fixture', GIT_COMMITTER_EMAIL: 'ci@example.invalid' }
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (file, value) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), value) }
  const commit = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  git('init', '-q', '--initial-branch=main')
  write('package.json', JSON.stringify({ type: 'module', scripts: { 'test:fixture-db': 'node --test tests/fixture.db.test.mjs' } }))
  write('scripts/ci/tasks.json', frozenBytes)
  write('scripts/ci/run-units.mjs', runner)
  write('nx.json', JSON.stringify({ plugins: ['./scripts/ci/nx-plugin.mjs'] }))
  write('playwright.smoke.config.ts', 'export default { testMatch: "tests/*.test.mjs" }\n')
  write('scripts/ci/nx-plugin.mjs', 'export default {}\n')
  write('tests/fixture.db.test.mjs', '// Existing database inventory entry. No database runs in this selector test.\n')
  write('lib/fixture.type-test.ts', 'export const typed: string = "fixture"\n')
  write('packages/worker/fixture_test.go', 'package worker\n')
  write('config/self-hosted-requirements.json', JSON.stringify({ 'lib/binding.ts': { mode: 'built-in', environment: [], behavior: 'Existing local dependency', test: 'tests/fixture.db.test.mjs' } }))
  write('lib/db/schema.ts', 'export const columns = []\n')
  const anchor = commit('reviewed historical main registry')
  write('scripts/ci/tasks.json', currentTasks)
  const policy = commit('main evolves its command inventory')
  git('update-ref', 'refs/remotes/origin/main', policy)
  git('checkout', '-qb', 'frozen-dependency', anchor)
  write('lib/binding.ts', 'export const binding = 1\n')
  baseEdit?.({ root, write })
  const base = commit('reviewed product backport without changing CI')
  write('lib/db/schema.ts', 'export const columns = ["creditsModel"]\n')
  const head = commit('schema backport candidate')
  const event = join(directory, 'event.json'), output = join(directory, 'selection.json')
  const run = (overrides = {}, payload = { pull_request: { base: { sha: base }, head: { sha: head } } }) => {
    writeFileSync(event, JSON.stringify(payload))
    execFileSync(process.execPath, [selector], { cwd: root, env: { ...env,
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '',
      CI_CANDIDATE_ROOT: root, CI_SELECTION_FILE: output, CI_BASE: '', CI_HEAD: '',
      CI_FORCE_FULL: 'true', CI_POLICY_FALLBACK: 'true', CI_POLICY_SHA: policy, GITHUB_SHA: git('rev-parse', 'HEAD'), ...overrides,
    }, stdio: 'pipe' })
    return JSON.parse(readFileSync(output, 'utf8'))
  }
  return { root, env, git, write, commit, anchor, policy, base, head, run }
}

test('trusted main selects the complete 87-task frozen registry, including its commands and retired core-6', t => {
  const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  assert.equal(blob(frozenBytes), 'a17230d70b3b14b89018c78124b7a4980ba8d35f')
  assert.equal(blob(runner), '21d811ee3dadbc6560cbab70a8cf9b4ba4bd615e')
  const f = fixture(t)
  const result = f.run()
  assert.equal(Object.keys(frozenTasks).length, 87)
  assert.equal(result.full, true)
  assert.equal(result.docs_only, false)
  assert.deepEqual(result.units, Object.keys(frozenTasks).map(key => 'ci-' + key))
  assert.ok(result.units.includes('ci-core-6'))
  assert.equal(result.unit_tasks.find(task => task.project === 'ci-core-43').command, 'pnpm test:coordinator-issue-tools')
  assert.equal(result.unit_tasks.find(task => task.project === 'ci-core-47').command, 'pnpm test:artifacts')
  for (const key of ['source', 'daemon', 'mobile', 'desktop', 'analytics']) assert.equal(result[key], true, key)
  assert.deepEqual(result.db_suites, ['test:fixture-db'])
  // Materialize the same historical runner the frozen branch executes. Main's
  // newer runner translates retired core-6 to core-7 and is a different caller.
  const scheduled = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { main } from './scripts/ci/run-units.mjs';
    const tasks = [];
    for (const kind of ['core', 'integration']) {
      const status = main(kind, process.env, (_bin, args) => { tasks.push(...args[args.indexOf('-t') + 1].split(',')); return { status: 0 } });
      if (status !== 0) throw Error('unitLaneFailed');
    }
    console.log(JSON.stringify(tasks));
  `], { cwd: f.root, env: { ...f.env, CI_UNITS: JSON.stringify(result.units) }, encoding: 'utf8' }))
  assert.deepEqual(scheduled.sort(), Object.keys(frozenTasks).sort())
})

for (const [name, edit] of [
  ['unknown task', f => { const tasks = structuredClone(frozenTasks); tasks['core-unknown'] = { kind: 'core', command: 'echo unregistered' }; f.write('scripts/ci/tasks.json', JSON.stringify(tasks)) }],
  ['deleted task', f => { const tasks = structuredClone(frozenTasks); delete tasks['core-6']; f.write('scripts/ci/tasks.json', JSON.stringify(tasks)) }],
  ['changed command', f => { const tasks = structuredClone(frozenTasks); tasks['core-43'].command = 'true'; f.write('scripts/ci/tasks.json', JSON.stringify(tasks)) }],
  ['changed Nx configuration', f => f.write('nx.json', JSON.stringify({ plugins: [] }))],
  ['changed named acceptance configuration', f => f.write('playwright.smoke.config.ts', 'export default { testIgnore: "**/*" }\n')],
  ['deleted test', f => rmSync(join(f.root, 'tests/fixture.db.test.mjs'))],
  ['deleted type test', f => rmSync(join(f.root, 'lib/fixture.type-test.ts'))],
  ['deleted Go test', f => rmSync(join(f.root, 'packages/worker/fixture_test.go'))],
  ['new unenrolled test', f => f.write('tests/unregistered.test.mjs', '')],
  ['test replaced by symlink', f => { rmSync(join(f.root, 'tests/fixture.db.test.mjs')); symlinkSync('../lib/binding.ts', join(f.root, 'tests/fixture.db.test.mjs')) }],
  ['deleted dependency acceptance', f => f.write('config/self-hosted-requirements.json', '{}')],
  ['changed dependency acceptance', f => f.write('config/self-hosted-requirements.json', JSON.stringify({ 'lib/binding.ts': { mode: 'built-in', environment: [], behavior: 'Changed acceptance', test: 'tests/fixture.db.test.mjs' } }))],
]) test(`frozen compatibility refuses ${name}`, t => {
  const f = fixture(t)
  edit(f)
  f.commit(name)
  assert.throws(() => f.run(), /frozenCiInventoryChanged/)
})

test('frozen compatibility validates working files and refuses a missing committed test', t => {
  const f = fixture(t)
  rmSync(join(f.root, 'tests/fixture.db.test.mjs'))
  assert.throws(() => f.run(), /frozenCiInventoryChanged/)
})

test('same-name test changes retain the full frozen inventory', t => {
  const f = fixture(t)
  f.write('tests/fixture.db.test.mjs', '// Existing enrollment with an added regression.\n')
  const declarations = JSON.parse(readFileSync(join(f.root, 'config/self-hosted-requirements.json')))
  declarations['drizzle/new.sql'] = { mode: 'built-in', environment: [], behavior: 'Additive schema', test: 'tests/fixture.db.test.mjs' }
  f.write('config/self-hosted-requirements.json', JSON.stringify(declarations))
  f.commit('add regression to an existing suite')
  assert.equal(f.run().units.length, 87)
})

for (const change of ['delete', 'modify']) test(`frozen head cannot ${change} a dependency acceptance added by its base`, t => {
  const file = 'config/self-hosted-requirements.json'
  const f = fixture(t, ({ root, write }) => {
    const declarations = JSON.parse(readFileSync(join(root, file)))
    declarations['lib/base.ts'] = { mode: 'built-in', environment: [], behavior: 'Base addition', test: 'tests/fixture.db.test.mjs' }
    write(file, JSON.stringify(declarations))
  })
  const declarations = JSON.parse(readFileSync(join(f.root, file)))
  if (change === 'delete') delete declarations['lib/base.ts']
  else declarations['lib/base.ts'].test = 'other.test.mjs'
  f.write(file, JSON.stringify(declarations))
  f.commit('candidate reduces prior acceptance')
  assert.throws(() => f.run(), /frozenCiInventoryChanged/)
})

test('a candidate cannot nominate its own policy as trusted main', t => {
  const f = fixture(t)
  assert.throws(() => f.run({ CI_POLICY_SHA: f.head }), /frozenCiPolicyNotTrusted/)
})

test('stacked PRs with the complete current registry retain main-policy full coverage', t => {
  const f = fixture(t)
  f.write('scripts/ci/tasks.json', currentTasks)
  f.write('nx.json', JSON.stringify({ plugins: [] }))
  f.write('tests/new.test.mjs', '// New feature test on the ordinary current registry path.\n')
  f.commit('feature stack has current inventory and new CI inputs')
  const result = f.run()
  assert.equal(result.full, true)
  assert.equal(result.unit_inventory, undefined)
  assert.deepEqual(result.units, Object.keys(JSON.parse(currentTasks)).map(key => 'ci-' + key))
})

test('frozen compatibility refuses selective coverage and a forged checkout identity', t => {
  const f = fixture(t)
  assert.throws(() => f.run({ CI_FORCE_FULL: 'false' }), /frozenCiFullCoverageRequired/)
  for (const checkout of [undefined, '', f.policy]) assert.throws(() => f.run({ GITHUB_SHA: checkout }), /frozenCiCandidateIdentityMismatch/)
  assert.throws(() => f.run({}, { pull_request: { base: { sha: f.base }, head: { sha: f.policy } } }), /frozenCiCandidateIdentityMismatch/)
})

test('normal main-history forced-full PRs and pushes do not enter frozen compatibility', t => {
  const f = fixture(t)
  f.git('checkout', '-qb', 'normal-main', f.policy)
  f.write('lib/new.ts', 'export const changed = true\n')
  const head = f.commit('ordinary main-based feature')
  for (const [eventName, payload] of [
    ['pull_request', { pull_request: { base: { sha: f.anchor }, head: { sha: head } } }],
    ['push', { before: f.anchor, after: head }],
  ]) {
    const result = f.run({ GITHUB_EVENT_NAME: eventName, GITHUB_REF: 'refs/heads/main', CI_POLICY_FALLBACK: '', CI_POLICY_SHA: f.anchor }, payload)
    assert.equal(result.full, true)
    assert.equal(result.unit_inventory, undefined)
    assert.deepEqual(result.units, Object.keys(JSON.parse(currentTasks)).map(key => 'ci-' + key))
  }
})
