import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { browserPlan, BROWSER_SMOKE, BROWSER_SCOPED_SPECS, BROWSER_INFRA_FILES, needsSelectionValidation } from './ci-docs-only.mjs'
import { browserArguments, selectionPlan, selectionValidationPlans } from './ci-browser-tests.mjs'

const smoke = [...BROWSER_SMOKE].sort()
const full = { tier: 'full', specs: [], performance: false }

test('documentation alone skips browser runtime; mixed source tests retain every critical flow', () => {
  assert.deepEqual(browserPlan(['README.md', 'docs/backend/checks.md']), { tier: 'docs', specs: [], performance: false })
  assert.deepEqual(browserPlan(['AGENTS.md']), { tier: 'docs', specs: [], performance: false })
  assert.deepEqual(browserPlan(['AGENTS.md', 'README.md']), { tier: 'docs', specs: [], performance: false })
  for (const files of [['lib/model.test.ts'], ['README.md', '.github/workflows/analytics-ci.yml']]) {
    assert.deepEqual(browserPlan(files), { tier: 'smoke', specs: smoke, performance: false })
  }
})

test('schema-only migrations run migration gates plus critical flows; any application code still runs full', () => {
  assert.deepEqual(browserPlan(['drizzle/202610290001.sql']), { tier: 'smoke', specs: smoke, performance: false })
  assert.deepEqual(browserPlan(['README.md', 'drizzle/202610290001.sql']), { tier: 'smoke', specs: smoke, performance: false })
  assert.deepEqual(browserPlan(['drizzle/202610290001.sql', 'drizzle/202610290002.sql']), { tier: 'smoke', specs: smoke, performance: false })
  for (const file of ['app/page.tsx', 'lib/db/schema.ts', 'tests/e2e/fixtures.ts', 'playwright.config.ts']) {
    assert.deepEqual(browserPlan(['drizzle/202610290001.sql', file]), full, file)
  }
  assert.deepEqual(browserPlan(['drizzle/202610290001.sql'], { unsafeModes: true }), full)
})

test('scoped backend and settings paths add complete relevant specs to the critical flows', () => {
  for (const [file, expected] of [
    ['app/api/search/route.ts', 'site-search.spec.ts'],
    ['lib/search/search.ts', 'site-search.spec.ts'],
    ['lib/federated-search/input.ts', 'site-search.spec.ts'],
    ['app/api/issues/search/route.ts', 'site-search.spec.ts'],
    ['lib/slack/webhook.ts', 'slack-webhook.spec.ts'],
    ['app/api/webhooks/slack/route.ts', 'slack-webhook.spec.ts'],
    ['components/settings/members.tsx', 'members.spec.ts'],
    ['app/[locale]/settings/page.tsx', 'settings.spec.ts'],
  ]) {
    const plan = browserPlan([file])
    assert.equal(plan.tier, 'targeted', file)
    assert.equal(plan.performance, false)
    assert(plan.specs.includes(expected), file)
    for (const spec of BROWSER_SMOKE) assert(plan.specs.includes(spec), file)
  }
  const mixed = browserPlan(['lib/slack/webhook.ts', 'lib/search/search.ts'])
  assert(mixed.specs.includes('site-search.spec.ts'))
  assert(mixed.specs.includes('slack-webhook.spec.ts'))
  assert.equal(new Set(mixed.specs).size, mixed.specs.length)
})

test('unknown, shared, auth, permission, dependency, schema and test infrastructure changes run full functionality', () => {
  for (const file of [
    'lib/auth.ts', 'lib/db/schema.ts', 'lib/issue-team-access-policy.ts',
    'app/api/auth/[...all]/route.ts', 'middleware.ts', 'proxy.ts',
    'components/ui/button.tsx', 'components/app-sidebar.tsx', 'app/globals.css',
    'next.config.mjs', 'pnpm-lock.yaml', 'package.json', 'messages/zh.json',
    'drizzle/202610290001.sql', 'packages/protocol/src/events.ts',
    'scripts/setup-e2e-db.mjs', 'tests/e2e/fixtures.ts', 'playwright.config.ts',
    'docs/generate.mjs', 'docs/AGENTS.md', 'new/unknown.ts',
  ]) assert.deepEqual(browserPlan(['README.md', 'lib/search/search.ts', file]), full, file)
  assert.deepEqual(browserPlan([]), full)
  assert.deepEqual(browserPlan(['README.md'], { unsafeModes: true }), full)
  assert.deepEqual(browserPlan(['lib/model.test.ts'], { unsafeModes: true }), full)
})

test('main, nightly and manual integration run all functionality and performance, including docs-only changes', () => {
  for (const files of [[], ['README.md'], ['lib/model.test.ts'], ['lib/slack/webhook.ts']]) {
    assert.deepEqual(browserPlan(files, { integration: true }), { ...full, performance: true })
  }
  for (const file of ['tests/e2e/navigation-performance.spec.ts', 'tests/e2e/agent-performance.spec.ts']) {
    assert.deepEqual(browserPlan([file]), { ...full, performance: true })
  }
})

test('every existing spec either adds its complete file or escalates to the full regression', () => {
  for (const file of readdirSync('tests/e2e').filter(file => file.endsWith('.spec.ts'))) {
    const plan = browserPlan([`tests/e2e/${file}`])
    if (plan.tier === 'targeted') assert(plan.specs.includes(file))
    else assert.equal(plan.tier, 'full', file)
  }
  for (const spec of [...BROWSER_SMOKE, ...BROWSER_SCOPED_SPECS]) assert(existsSync(`tests/e2e/${spec}`), spec)
  assert.deepEqual(browserPlan(['tests/e2e/new-flow.spec.ts']), full)
})

test('runner selects only fixed files, refuses partial critical flows, and never narrows a full run', () => {
  assert.deepEqual(browserArguments('full', '[]'), ['exec', 'playwright', 'test', '--grep-invert', '@performance'])
  assert.deepEqual(browserArguments('full', '[]', '2/4'), ['exec', 'playwright', 'test', '--grep-invert', '@performance', '--shard=2/4'])
  const args = browserArguments('smoke', JSON.stringify(smoke))
  assert.deepEqual(args.slice(3, -2), smoke.map(spec => `tests/e2e/${spec}`))
  for (const [tier, list] of [
    ['full', smoke], ['smoke', smoke.slice(1)], ['targeted', []],
    ['docs', []], ['', []], ['targeted', [...smoke, '../evil.spec.ts']],
    ['targeted', [...smoke, '--pass-with-no-tests']], ['smoke', [...smoke, smoke[0]]],
    ['targeted', [...smoke, '$(touch /tmp/injected)']], ['smoke', [null]],
  ]) assert.throws(() => browserArguments(tier, JSON.stringify(list)))
  assert.throws(() => browserArguments('full', 'not JSON'))
  assert.throws(() => browserArguments('full', '{}'))
  for (const shard of ['0/4', '4/3', '1/0', '1', '1/x', '../1/2', '01/4', ' 1/4']) {
    assert.throws(() => browserArguments('full', '[]', shard), shard)
  }
  assert.deepEqual(browserArguments('full', '[]', '4/4').at(-1), '--shard=4/4')
})

test('runner invokes pnpm without a shell and preserves actual command failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-runner-retained-'))
  console.log(`Retained browser runner evidence: ${dir}`)
  const trace = join(dir, 'argv.json')
  writeFileSync(join(dir, 'pnpm'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.env.TEST_TRACE, JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.TEST_EXIT));\n`, { mode: 0o700 })
  for (const status of [0, 7]) {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs')], {
      encoding: 'utf8', env: { PATH: dir, BROWSER_TIER: 'smoke', BROWSER_SPECS: JSON.stringify(smoke), TEST_TRACE: trace, TEST_EXIT: String(status) },
    })
    assert.equal(result.status, status, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), browserArguments('smoke', JSON.stringify(smoke)))
  }
})

test('each selection plan can run as an independent unsharded job', () => {
  assert.equal(selectionPlan('smoke').tier, 'smoke')
  assert.equal(selectionPlan('targeted').tier, 'targeted')
  for (const spec of BROWSER_SMOKE) assert(selectionPlan('smoke').specs.includes(spec))
  for (const spec of [...BROWSER_SMOKE, ...BROWSER_SCOPED_SPECS]) assert(selectionPlan('targeted').specs.includes(spec))
  assert.throws(() => selectionPlan('full'))
  assert.throws(() => selectionPlan(''))
})

test('selection validation cannot be sharded or use both modes', () => {
  for (const args of [
    ['--verify-selection', '--shard=1/4'],
    ['--verify-selection-plan=smoke', '--shard=1/4'],
  ]) {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs'), ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must run unsharded/)
  }
  const both = spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs'), '--verify-selection', '--verify-selection-plan=smoke'], { encoding: 'utf8' })
  assert.notEqual(both.status, 0)
  assert.match(both.stderr, /Choose one selection validation mode/)
})

test('trusted classifier writes actual GitHub outputs for event ranges and integration, failing closed on missing ranges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-event-retained-'))
  console.log(`Retained browser event evidence: ${dir}`)
  const env = {
    PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
  const git = (args, input) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: dir, env, input, encoding: 'utf8' }).trim()
  git(['init', '--bare', '--template=', '.'])
  const tree = text => git(['mktree'], text)
  const blob = git(['hash-object', '-w', '--stdin'], 'baseline')
  const baseTree = tree(`100644 blob ${blob}\tREADME.md\n`)
  const base = git(['commit-tree', baseTree, '-m', 'base'])
  const changed = git(['hash-object', '-w', '--stdin'], 'source-only test')
  const libTree = tree(`100644 blob ${changed}\tmodel.test.ts\n`)
  const headTree = tree(`100644 blob ${blob}\tREADME.md\n040000 tree ${libTree}\tlib\n`)
  const head = git(['commit-tree', headTree, '-p', base, '-m', 'test-only'])
  const executableTree = tree(`100755 blob ${changed}\tmodel.test.ts\n`)
  const unsafeHead = git(['commit-tree', tree(`040000 tree ${executableTree}\tlib\n`), '-p', base, '-m', 'unsafe mode'])
  const script = resolve('scripts/ci-docs-only.mjs')
  let count = 0
  for (const [event, payload, ref, tier, perf] of [
    ['pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, '', 'smoke', 'false'],
    ['pull_request', { pull_request: { base: { sha: base }, head: { sha: unsafeHead } } }, '', 'full', 'false'],
    ['pull_request', {}, '', 'full', 'false'],
    ['pull_request', { pull_request: { base: { sha: 'missing' }, head: { sha: head } } }, '', 'full', 'false'],
    ['push', {}, 'refs/heads/main', 'full', 'true'],
    ['schedule', {}, '', 'full', 'true'], ['workflow_dispatch', {}, '', 'full', 'true'],
  ]) {
    const eventPath = join(dir, `${count}-event.json`), output = join(dir, `${count++}-output`)
    writeFileSync(eventPath, JSON.stringify(payload))
    execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_REF: ref, GITHUB_OUTPUT: output } })
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
    assert.equal(outputs.browser_tier, tier)
    assert.equal(outputs.browser_performance, perf)
    assert.equal(outputs.docs_only, 'false')
    browserArguments(outputs.browser_tier, outputs.browser_specs)
  }
})

test('protected browser gate requires build, runtime, selection and regression results', () => {
  const source = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  const block = source.split('      - name: Require the selected browser layer\n')[1]
  const script = block.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  const result = (options = {}) => spawnSync('bash', ['-e', '-c', script], {
    env: {
      PATH: process.env.PATH,
      CHANGES_RESULT: options.changes ?? 'success',
      BUILD_RESULT: options.build ?? 'success',
      RUNTIME_RESULT: options.runtime ?? 'success',
      SELECTION_RESULT: options.selection ?? (options.verify === 'true' ? 'success' : 'skipped'),
      FULL_RESULT: options.full ?? 'success',
      DOCS_ONLY: options.docs ?? 'false',
      BROWSER_TIER: options.tier ?? 'full',
      BROWSER_PERFORMANCE: options.performance ?? 'false',
      EVENT_NAME: options.event ?? 'pull_request',
      VERIFY_SELECTION: options.verify ?? 'false',
    },
  }).status === 0
  assert(result())
  for (const tier of ['smoke', 'targeted', 'full']) assert(result({ tier }))
  assert(!result({ changes: 'failure' }))
  for (const value of ['failure', 'cancelled', 'skipped', '']) {
    assert(!result({ build: value }), `build ${value}`)
    assert(!result({ runtime: value }), `runtime ${value}`)
    assert(!result({ full: value }), `full ${value}`)
  }
  assert(result({ docs: 'true', tier: 'docs', full: 'skipped', build: 'skipped', runtime: 'skipped', selection: 'skipped' }))
  assert(!result({ docs: 'true', changes: 'failure', tier: 'docs', full: 'skipped' }))
  // A selection-policy change runs both subsets and skips the regression layer.
  assert(result({ verify: 'true', tier: 'smoke', selection: 'success', full: 'skipped' }))
  assert(!result({ verify: 'true', tier: 'smoke', selection: 'failure', full: 'skipped' }))
  assert(!result({ verify: 'true', tier: 'smoke', selection: 'success', full: 'success' }))
  // A policy change mixed with application code still runs the full regression.
  assert(result({ verify: 'true', tier: 'full', selection: 'success', full: 'success' }))
  assert(!result({ verify: 'true', tier: 'full', selection: 'success', full: 'skipped' }))
  assert(!result({ verify: 'false', selection: 'success' }))
  for (const [tier, docs, performance, verify] of [['', 'false', 'false', 'false'], ['docs', 'false', 'false', 'false'], ['smoke', 'false', 'true', 'false'], ['targeted', 'false', 'true', 'false'], ['smoke', 'false', 'false', 'maybe']]) {
    assert(!result({ tier, docs, performance, verify }), `${tier}:${docs}:${performance}:${verify}`)
  }
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert(result({ event, tier: 'full', performance: 'true' }))
    assert(!result({ event, tier: 'full', performance: 'false' }))
    assert(!result({ event, tier: 'smoke', performance: 'false' }))
    assert(!result({ event, tier: 'docs', docs: 'true', performance: 'false' }))
  }
})


test('policy validation exercises both subsets and covers every scoped spec without duplicating critical flows or replacing a required full layer', () => {
  const [critical, scoped] = selectionValidationPlans()
  assert.equal(critical.tier, 'smoke')
  assert.equal(scoped.tier, 'targeted')
  for (const spec of [...BROWSER_SMOKE, ...BROWSER_SCOPED_SPECS]) assert(scoped.specs.includes(spec), spec)
  assert.equal(browserArguments(critical.tier, JSON.stringify(critical.specs)).length, 9)
  const source = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  for (const path of ['playwright-selection-smoke-report', 'selection-smoke-results', 'playwright-selection-targeted-report', 'selection-targeted-results', '.cache/e2e/playwright-selection.log']) {
    assert(source.includes(path))
    assert(readFileSync('scripts/test-accounts/evidence.mjs', 'utf8').includes(path))
  }
  assert(source.includes("needs.changes.outputs.verify_selection == 'true' && needs.changes.outputs.browser_tier != 'full'"))
  assert(source.includes('node scripts/ci-browser-tests.mjs --verify-selection-plan=${{ matrix.plan }}'))
  assert(source.includes('node scripts/ci-browser-tests.mjs --shard=${{ matrix.shard }}/4'))
  // Independent jobs: build, runtime, two selection plans and four regression
  // shards each get their own PostgreSQL service and artifact name.
  assert(source.includes('matrix:\n        plan: [smoke, targeted]'))
  assert(source.includes('matrix:\n        shard: [1, 2, 3, 4]'))
  assert(source.includes('name: browser-build-${{ github.sha }}'))
  assert(source.includes('name: browser-test-report-runtime-${{ github.sha }}'))
  assert(source.includes('name: browser-test-report-selection-${{ matrix.plan }}-${{ github.sha }}'))
  assert(source.includes('name: browser-test-report-shard-${{ matrix.shard }}-${{ github.sha }}'))
  assert(source.includes('needs: [changes, browser-build, browser-runtime, browser-selection, browser-e2e-full]'))
})


test('real subset entrypoint retains search receipts before full initialization and rejects missing evidence or failed subsets', () => {
  for (const [receipt, status, expected] of [[true, 0, 0], [false, 0, 1], [true, 7, 7]]) {
    const dir = mkdtempSync(join(tmpdir(), 'browser-subset-retained-'))
    console.log(`Retained subset entrypoint evidence: ${dir}`)
    const stub = `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
const targeted = process.argv.includes('--output=selection-targeted-results');
if (targeted) {
  mkdirSync('selection-targeted-results', {recursive:true});
  if (process.env.TEST_RECEIPT === 'true') {
    mkdirSync('test-results', {recursive:true});
    writeFileSync('test-results/site-search-fixtures.json', JSON.stringify({retained:'synthetic evidence'}));
  }
}
process.exit(targeted ? Number(process.env.TEST_EXIT) : 0);
`
    writeFileSync(join(dir, 'pnpm'), stub, { mode: 0o700 })
    const result = spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs'), '--verify-selection'], {
      cwd: dir, encoding: 'utf8', env: { PATH: dir, TEST_RECEIPT: String(receipt), TEST_EXIT: String(status) },
    })
    assert.equal(result.status, expected, result.stderr)
    if (receipt) {
      assert.equal(readFileSync(join(dir, 'selection-targeted-results/site-search-fixtures.json'), 'utf8'), readFileSync(join(dir, 'test-results/site-search-fixtures.json'), 'utf8'))
    } else assert(result.stderr.includes('MISSING_SELECTION_RECEIPT'))
  }
})


test('CI-only updates use dedicated policy validation and critical flows, without full functionality or performance', () => {
  for (const file of BROWSER_INFRA_FILES) {
    assert.deepEqual(browserPlan([file]), { tier:'smoke', specs:smoke, performance:false }, file)
    assert.deepEqual(browserPlan([file, 'app/page.tsx']), full, `${file} mixed with application code`)
  }
  assert(needsSelectionValidation(['scripts/ci-docs-only.mjs']))
  assert(needsSelectionValidation(['.github/workflows/browser-tests.yml']))
  assert.equal(needsSelectionValidation(['.github/workflows/analytics-ci.yml']), false)
  assert.equal(needsSelectionValidation(['README.md']), false)
})

test('actual workflow bootstrap cannot let an edited classifier skip app changes, unknown modes, or integration', () => {
  const workflow = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  const wrapper = workflow.split(`<<'BROWSER_BOOTSTRAP'\n`)[1].split('          BROWSER_BOOTSTRAP')[0].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'browser-bootstrap-retained-'))
  console.log(`Retained workflow bootstrap evidence: ${dir}`)
  const trusted = join(dir, 'trusted-main.mjs')
  writeFileSync(trusted, readFileSync('scripts/ci-docs-only.mjs'))
  const env = { PATH:process.env.PATH, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_AUTHOR_NAME:'Test', GIT_AUTHOR_EMAIL:'test@example.invalid', GIT_COMMITTER_NAME:'Test', GIT_COMMITTER_EMAIL:'test@example.invalid' }
  const git = (args, input) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {cwd:dir, env, input, encoding:'utf8'}).trim()
  git(['init', '--bare', '--template=', '.'])
  const blob = git(['hash-object', '-w', '--stdin'], 'synthetic fixture')
  const tree = files => {
    const groups = new Map()
    for (const [path, mode] of files) {
      const [name, ...rest] = path.split('/')
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push([rest.join('/'), mode])
    }
    return git(['mktree'], [...groups].map(([name, entries]) => entries[0][0] ? `040000 tree ${tree(entries)}\t${name}\n` : `${entries[0][1]} blob ${blob}\t${name}\n`).join(''))
  }
  const base = git(['commit-tree', tree([['README.md','100644']]), '-m', 'base'])
  let count = 0
  for (const [files, mode, event, tier, performance] of [
    [BROWSER_INFRA_FILES, '100644', 'pull_request', 'smoke', 'false'],
    [['scripts/ci-docs-only.mjs', 'app/page.tsx'], '100644', 'pull_request', 'full', 'false'],
    [['scripts/ci-docs-only.mjs', 'new/unknown.ts'], '100644', 'pull_request', 'full', 'false'],
    [['scripts/ci-docs-only.mjs'], '100755', 'pull_request', 'full', 'false'],
    [['scripts/ci-docs-only.mjs'], '120000', 'pull_request', 'full', 'false'],
    [['scripts/ci-docs-only.mjs', 'tests/e2e/navigation-performance.spec.ts'], '100644', 'pull_request', 'full', 'true'],
    [BROWSER_INFRA_FILES, '100644', 'push', 'full', 'true'],
    [BROWSER_INFRA_FILES, '100644', 'schedule', 'full', 'true'],
    [BROWSER_INFRA_FILES, '100644', 'workflow_dispatch', 'full', 'true'],
  ]) {
    const head = git(['commit-tree', tree([['README.md','100644'], ...files.map(file => [file,mode])]), '-p', base, '-m', 'change'])
    const eventFile = join(dir, `${count}-event.json`), outputFile = join(dir, `${count++}-output`)
    writeFileSync(eventFile, JSON.stringify({pull_request:{base:{sha:base},head:{sha:head}}}))
    execFileSync(process.execPath, ['--input-type=module','-',trusted], {cwd:dir, encoding:'utf8', input:wrapper, env:{...env,GITHUB_EVENT_NAME:event,GITHUB_EVENT_PATH:eventFile,GITHUB_OUTPUT:outputFile}})
    const outputs = Object.fromEntries(readFileSync(outputFile,'utf8').trim().split('\n').map(line => { const at=line.indexOf('='); return [line.slice(0,at),line.slice(at+1)] }))
    assert.equal(outputs.docs_only, 'false')
    assert.equal(outputs.verify_selection, 'true')
    assert.equal(outputs.browser_tier, tier)
    assert.equal(outputs.browser_performance, performance)
    assert.deepEqual(JSON.parse(outputs.browser_specs), tier==='smoke' ? smoke : [])
  }
})
