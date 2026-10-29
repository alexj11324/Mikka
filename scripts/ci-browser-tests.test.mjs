import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { browserPlan, BROWSER_SMOKE, BROWSER_SCOPED_SPECS } from './ci-docs-only.mjs'
import { browserArguments, selectionValidationPlans } from './ci-browser-tests.mjs'

const smoke = [...BROWSER_SMOKE].sort()
const full = { tier: 'full', specs: [], performance: false }

test('documentation alone skips browser runtime; mixed source tests retain every critical flow', () => {
  assert.deepEqual(browserPlan(['README.md', 'docs/backend/checks.md']), { tier: 'docs', specs: [], performance: false })
  for (const files of [['lib/model.test.ts'], ['README.md', '.github/workflows/analytics-ci.yml']]) {
    assert.deepEqual(browserPlan(files), { tier: 'smoke', specs: smoke, performance: false })
  }
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
    'scripts/ci-docs-only.mjs', 'scripts/ci-browser-tests.test.mjs',
    '.github/workflows/browser-tests.yml', '.github/workflows/ui-policy.yml',
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

test('protected browser gate rejects failed/cancelled/skipped jobs, malformed plans and reduced integration runs', () => {
  const source = readFileSync('.github/workflows/browser-tests.yml', 'utf8')
  const block = source.split('      - name: Require the selected browser layer\n')[1]
  const script = block.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  const result = (tier, docs, performance, job, changes = 'success', event = 'pull_request') => spawnSync('bash', ['-e', '-c', script], {
    env: { PATH: process.env.PATH, CHANGES_RESULT: changes, DOCS_ONLY: docs, BROWSER_TIER: tier, BROWSER_PERFORMANCE: performance, FULL_RESULT: job, EVENT_NAME: event },
  }).status === 0
  for (const tier of ['smoke', 'targeted', 'full']) {
    assert(result(tier, 'false', 'false', 'success'))
    for (const job of ['failure', 'cancelled', 'skipped', '']) assert(!result(tier, 'false', 'false', job))
    assert(!result(tier, 'false', 'false', 'success', 'failure'))
  }
  assert(result('docs', 'true', 'false', 'skipped'))
  assert(!result('docs', 'true', 'false', 'skipped', 'failure'))
  for (const [tier, docs, perf] of [['', 'false', 'false'], ['docs', 'false', 'false'], ['full', 'true', 'false'], ['smoke', 'false', 'true'], ['targeted', 'false', 'true']]) assert(!result(tier, docs, perf, 'success'))
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert(result('full', 'false', 'true', 'success', 'success', event))
    assert(!result('full', 'false', 'false', 'success', 'success', event))
    assert(!result('smoke', 'false', 'false', 'success', 'success', event))
    assert(!result('docs', 'true', 'false', 'skipped', 'success', event))
  }
})


test('policy validation exercises both subsets and covers every scoped spec without replacing the full gate', () => {
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
  assert(source.includes('node scripts/ci-browser-tests.mjs --verify-selection'))
  assert(source.includes('node scripts/ci-browser-tests.mjs > "$log_file"'))
  assert(source.includes('if: needs.changes.outputs.verify_selection == \'true\''))
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
