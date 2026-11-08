import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { select, diffRange, area } from './select.mjs'
import { buildGraph, dbId, sourceId } from './graph.mjs'
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
test('web component edits select their consumers without server DB or Docker', async () => {
  const result = await pick('components/settings/settings-view.tsx')
  assert.equal(result.full, false)
  assert.equal(result.image, false)
  assert.equal(result.daemon, false)
  assert.deepEqual(result.db_suites, [])
  assert(result.source)
})
test('daemon is selected through its package dependency and protocol expands globally', async () => {
  const result = await pick('packages/daemon/src/index.ts')
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
})
for (const file of ['drizzle/new.sql','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','.github/workflows/ui-policy.yml','scripts/ci/select.mjs','lib/db/schema.ts','lib/auth.ts','lib/credentials/store.ts','unmapped.bin']) test(`high risk or unmapped input expands: ${file}`, async () => {
  const r = await pick(file)
  assert(r.full)
  assert.equal(r.db_suites.length, plan.db.scripts.length)
  assert(r.daemon && r.image && r.desktop)
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
  for (const job of ['ui-policy','browser-tests']) {
    const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0]
    const script = block.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n')
    const run = overrides => {
      const env = {PATH:process.env.PATH,GITHUB_STEP_SUMMARY:'/dev/null',CHANGES_RESULT:'success',EXPECT_CORE:'true',EXPECT_INTEGRATION:'true',EXPECT_SOURCE:'true',EXPECT_DAEMON:'true',CORE:'success',INTEGRATION:'success',SOURCE:'success',DAEMON:'success',EXPECT_DB:'true',DB_RESULT:'success',...overrides}
      try { execFileSync('bash',['-e','-c',script],{env,stdio:'ignore'});return true } catch { return false }
    }
    assert(run({}))
    assert(!run({CHANGES_RESULT:'failure'}))
    for(const result of ['skipped','failure','cancelled','timed_out','']) {
      if(job==='ui-policy') for(const key of ['CORE','INTEGRATION','SOURCE','DAEMON']) assert(!run({[key]:result}))
      else assert(!run({DB_RESULT:result}))
    }
    if(job==='browser-tests') { assert(run({EXPECT_DB:'false',DB_RESULT:'skipped'}));assert(!run({EXPECT_DB:'false',DB_RESULT:'failure'})) }
  }
})
