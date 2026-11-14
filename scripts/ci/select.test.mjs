import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { select, diffRange, area } from './select.mjs'
import { buildGraph, dbId, sourceId, strictCommand } from './graph.mjs'
import { selectScripts, shardScripts } from '../run-db-tests.mjs'

const change = (file, extra = {}) => ({file, status:'M', mode:'100644', oldMode:'100644', ...extra})
const plan = buildGraph()
const pick = (file, extra) => select(plan, [change(file, extra)])

test('mobile does not select server DB, daemon, Docker or macOS', async () => {
  const result = await pick('apps/mobile/lib/theme.ts')
  assert.equal(result.full, false)
  for (const key of ['daemon','image','desktop','analytics']) assert.equal(result[key], false, key)
  assert.deepEqual(result.db_suites, [])
  assert.deepEqual(result.db_matrix.shard, [])
  assert(result.mobile)
})
test('non-documentation plans keep the suite that actually exercises the docs classifier', async () => {
  const planForMobile = await pick('apps/mobile/lib/theme.ts')
  const owners = planForMobile.units.filter(unit =>
    plan.graph.dependencies[unit]?.some(edge => edge.target === sourceId('scripts/ci-docs-only.test.mjs')))
  assert.deepEqual(owners, ['ci-core-7'])
})

test('web component edits select their consumers without server DB or Docker', async () => {
  const result = await pick('components/settings/settings-view.tsx')
  assert.equal(result.full, false)
  assert.equal(result.image, false)
  assert.equal(result.daemon, false)
  assert.deepEqual(result.db_suites, [])
  assert(result.source)
})
test('daemon is selected through its package dependency and protocol expands globally', async () => {
  const result = await pick('packages/daemon/src/adapters/codex.ts')
  assert.equal(result.full, false)
  assert.equal(result.daemon, true)
  const shared = await pick('packages/protocol/src/run.ts')
  assert(shared.full)
  assert(shared.daemon && shared.desktop && shared.image)
  assert.deepEqual(shared.db_suites, plan.db.scripts)
})
test('Factory store selects marker-backed suites and real downstream imports', async () => {
  const result = await pick('lib/factory/store.ts')
  for (const suite of ['test:factory','test:factory-routing-db']) assert(result.db_suites.includes(suite), suite)
  assert(result.affected.includes(dbId('test:factory')))
  assert(result.db_suites.length < plan.db.scripts.length)
  assert(result.image, 'a new backend capability must validate self-hosted dependencies and exercise the image')
})
test('Eve model changes select native unit tests and schedule authority selects its database gate', async () => {
  const unit = await pick('lib/eve/streaming-model.ts')
  assert(unit.units.includes('ci-core-41'))
  const database = await pick('lib/eve/scheduled-read.ts')
  assert(database.db_suites.includes('test:eve-db'))
  assert(database.affected.includes(dbId('test:eve-db')))
})
for (const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','.github/workflows/ui-policy.yml','scripts/ci/select.mjs','lib/db/schema.ts','lib/auth.ts','lib/credentials/store.ts','unmapped.bin']) test(`high risk or unmapped input expands: ${file}`, async () => {
  const r = await pick(file)
  assert(r.full)
  assert.equal(r.db_suites.length, plan.db.scripts.length)
  assert(r.daemon && r.image && r.desktop)
})
// A migration changes the schema every suite runs against, so it keeps the full
// DB inventory; it says nothing about rendering, so it must not turn on the
// macOS packaged acceptance the other global inputs do. Uses a migration that
// exists, because a name absent from the graph expands for an unrelated reason.
test('a migration keeps every DB suite without turning on the packaged desktop build', async () => {
  const migration = Object.keys(plan.graph.nodes).find(id => id.startsWith('source:drizzle/') && id.endsWith('.sql'))
  assert.ok(migration, 'the graph must map at least one migration')
  const r = await pick(migration.slice('source:'.length))
  assert(!r.full)
  assert.equal(r.db_suites.length, plan.db.scripts.length)
  assert(!r.desktop)
  assert(r.image, 'a schema migration must validate the real self-hosted image')
})
test('deletes, renames, executable modes, symlinks and empty diffs run all', async () => {
  for(const extra of [{status:'D'},{status:'R100'},{mode:'100755'},{mode:'120000'},{oldMode:'100755'}]) assert((await pick('README.md', extra)).full)
  assert((await select(plan, [])).full)
})
test('unknown graph and unresolved sources cannot skip jobs', async () => {
  const missing = await select({...plan, graph:{nodes:{},dependencies:{}}}, [change('lib/factory/store.ts')])
  assert(missing.full)
  const unresolved = await select({...plan, unresolved:[{file:'components/settings/settings-view.tsx'}]}, [change('components/settings/settings-view.tsx')])
  assert(unresolved.full)
})
test('docs retain the fast tier but inventory is built before that decision', async () => {
  const r = await pick('docs/dev-workflow.md')
  assert((await pick('packages/daemon/README.md')).docs_only)
  assert((await pick('.github/workflows/README.md')).docs_only)
  assert(r.docs_only)
  assert.equal(r.source, false)
  assert.equal(r.units.length, 0)
  assert.equal(r.db_suites.length, 0)
  assert(plan.db.files.length > 70)
})
test('fork PRs, main and merge queue use full immutable SHA ranges; other events full', () => {
  assert.deepEqual(diffRange({GITHUB_EVENT_NAME:'pull_request'}, {pull_request:{base:{sha:'base'},head:{sha:'fork'}}}), ['base','fork'])
  assert.deepEqual(diffRange({GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main'}, {before:'before',after:'after'}), ['before','after'])
  assert.deepEqual(diffRange({GITHUB_EVENT_NAME:'merge_group'}, {merge_group:{base_sha:'base',head_sha:'merge'}}), ['base','merge'])
  for (const name of ['schedule','workflow_dispatch','unknown']) assert.deepEqual(diffRange({GITHUB_EVENT_NAME:name}, {}), [])
})
test('selected DB suites remain a nonempty subset and dynamic shards are exhaustive', () => {
  for (const selection of ['[]','null','["unknown"]','["test:a","test:a"]']) assert.throws(()=>selectScripts(['test:a'],selection))
  const scripts = selectScripts(plan.db.scripts, JSON.stringify(plan.db.scripts.slice(0,2)))
  assert.equal(shardScripts(scripts,'1/1').length,2)
  assert.throws(()=>shardScripts(scripts,'3/3'))
})
test('shared aliases and glob imports become graph edges rather than missed test inputs', () => {
  assert(plan.graph.dependencies[sourceId('apps/mobile/app/(tabs)/(chats)/_layout.tsx')].some(e=>e.target===sourceId('apps/mobile/lib/theme.ts')))
  assert(Object.values(plan.graph.dependencies).some(edges=>edges.some(e=>e.target.startsWith('source:packages/protocol/'))))
})
test('every heavy consumer uses the same trusted triage and required names remain', () => {
  for(const file of ['ui-policy','desktop','analytics-ssr','self-hosted-image']) assert(readFileSync(`.github/workflows/${file}.yml`,'utf8').includes('uses: ./.github/workflows/ci-selection.yml'))
  const bootstrap=readFileSync('scripts/ci/bootstrap.sh','utf8')
  assert(bootstrap.includes('git archive "$trusted_sha"'))
  assert(bootstrap.includes('--frozen-lockfile --ignore-scripts'))
  assert(bootstrap.includes('CI_CANDIDATE_ROOT="$candidate"'))
  const ci=readFileSync('.github/workflows/ui-policy.yml','utf8')
  assert(ci.includes('name: UI policy (strict)'))
  assert(ci.includes('name: Production build and browser interactions'))
  assert(!ci.includes('playwright install'))
  assert.equal(area('apps/mobile/lib/theme.ts'),'mobile')
})

test('the actual required gate scripts reject unselected failures and selected skips', () => {
  const workflow = readFileSync('.github/workflows/ui-policy.yml','utf8')
  const uiChecks = ['CORE', 'INTEGRATION', 'SOURCE', 'DAEMON', 'IMAGE', 'ANALYTICS', 'GOVERNANCE']
  for (const job of ['ui-policy','browser-tests']) {
    const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0]
    const script = block.split('        run: |\n')[1].split('      - uses:')[0].split('\n').map(line => line.slice(10)).join('\n')
    const run = overrides => {
      const env = {
        PATH: process.env.PATH,
        GITHUB_STEP_SUMMARY: '/dev/null',
        CHANGES_RESULT: 'success',
        EXPECT_DB: 'true',
        DB_RESULT: 'success',
      }
      for (const key of uiChecks) {
        env['EXPECT_' + key] = 'true'
        env[key] = 'success'
      }
      Object.assign(env, overrides)
      try { execFileSync('bash',['-e','-c',script],{env,stdio:'ignore'});return true } catch { return false }
    }
    assert(run({}))
    assert(!run({CHANGES_RESULT:'failure'}))
    for(const result of ['skipped','failure','cancelled','timed_out','']) {
      if(job==='ui-policy') for(const key of uiChecks) assert(!run({[key]:result}))
      else assert(!run({DB_RESULT:result}))
    }
    if (job === 'ui-policy') {
      assert(!/\b(?:EXPECT_)?DESKTOP\b/.test(script), 'the automatic gate has no Desktop consumer')
      for (const result of ['success', 'skipped', 'failure', 'cancelled', 'timed_out', '']) {
        assert(run({ EXPECT_DESKTOP: 'true', DESKTOP: result }), 'a retired Desktop result does not affect the automatic gate')
      }
      for (const key of uiChecks) {
        assert(run({['EXPECT_' + key]: 'false', [key]: 'skipped'}), key)
        for (const result of ['success', 'failure', 'cancelled']) {
          assert(!run({['EXPECT_' + key]: 'false', [key]: result}), key)
        }
      }
    }
    if(job==='browser-tests') { assert(run({EXPECT_DB:'false',DB_RESULT:'skipped'}));assert(!run({EXPECT_DB:'false',DB_RESULT:'failure'})) }
  }
})

test('Nx commands retain Actions fail-fast and pipefail, including multiline steps', () => {
  const result = spawnSync('sh',['-c',strictCommand("printf '%s' 'literal $HOME'\nfalse\necho masked-failure")],{encoding:'utf8'})
  assert.equal(result.status,1)
  assert.equal(result.stdout,'literal $HOME')
  assert.equal(spawnSync('sh',['-c',strictCommand('false | cat')]).status,1)
})

for (const [name, source] of [
  ['new.db.test.ts', ''],
  ['new.test.ts', "import {Pool} from " + "'pg'"],
  ['dynamic.test.mjs', "const pg = await import(" + "'pg')"],
]) test(`a new DB test outside legacy inventory roots fails before selection: ${name}`, t => {
  const root = mkdtempSync(join(tmpdir(),'mikka-ci-inventory-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  mkdirSync(join(root,'tests'))
  mkdirSync(join(root,'apps/api'),{recursive:true})
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:fixture-db':'node --test tests/fixture.db.test.ts'}}))
  writeFileSync(join(root,'tests/fixture.db.test.ts'),'')
  writeFileSync(join(root,`apps/api/${name}`),source)
  execFileSync('git',['init','-q'],{cwd:root})
  execFileSync('git',['add','.'],{cwd:root})
  assert.throws(()=>buildGraph(root),/DB test outside inventory roots/)
})

test('filesystem-based i18n and generated catalog policies cannot disappear from import-only selection', async () => {
  const commands = JSON.parse(readFileSync('scripts/ci/tasks.json','utf8'))
  for (const file of ['messages/en.json','apps/mobile/lib/theme.ts']) {
    const result = await pick(file)
    for (const command of ['pnpm test:i18n','pnpm i18n:check','pnpm check:agent-ui']) {
      const key = Object.entries(commands).find(([,task])=>task.command===command)?.[0]
      assert(result.units.includes(`ci-${key}`), `${file}: ${command}`)
    }
  }
})
