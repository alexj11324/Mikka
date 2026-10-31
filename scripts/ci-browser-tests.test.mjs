import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  browserPlan, BROWSER_MAIN_SPECS, BROWSER_NIGHTLY_SPECS, BROWSER_SCOPED_SPECS, BROWSER_SMOKE_FILES,
  BROWSER_INFRA_FILES, needsSelectionValidation,
} from './ci-docs-only.mjs'
import { browserArguments, selectionPlan, selectionValidationPlans, specGrep, turnstileArguments, TURNSTILE_TEST_SECRET } from './ci-browser-tests.mjs'

const smoke = { tier: 'smoke', specs: [], performance: false }
const full = { tier: 'full', specs: [], performance: false }
const specFiles = readdirSync('tests/e2e').filter(file => file.endsWith('.spec.ts')).sort()
const workflow = () => readFileSync('.github/workflows/browser-tests.yml', 'utf8')

test('documentation alone skips browser runtime; everything else runs at least the smoke set', () => {
  assert.deepEqual(browserPlan(['README.md', 'docs/backend/checks.md']), { tier: 'docs', specs: [], performance: false })
  assert.deepEqual(browserPlan(['AGENTS.md']), { tier: 'docs', specs: [], performance: false })
  for (const files of [
    ['lib/model.test.ts'], ['README.md', '.github/workflows/analytics-ci.yml'], ['drizzle/202610290001.sql'],
    ['lib/db/schema.ts'], ['package.json'], ['pnpm-lock.yaml'], ['playwright.config.ts'], ['tests/e2e/fixtures.ts'],
    ['components/ui/button.tsx'], ['new/unknown.ts'], ['messages/zh-CN.json'], ['drizzle/202610290001.sql', 'app/page.tsx'],
  ]) assert.deepEqual(browserPlan(files), smoke, files.join(','))
})

test('mapped paths add whole area specs next to the smoke set', () => {
  for (const [file, expected] of [
    ['app/api/search/route.ts', ['site-search.spec.ts', 'global-search-scope.spec.ts']],
    ['lib/federated-search/input.ts', ['site-search.spec.ts']],
    ['lib/slack/webhook.ts', ['slack-webhook.spec.ts']],
    ['components/settings/members-panel.tsx', ['members.spec.ts', 'settings.spec.ts', 'profile.spec.ts', 'bots.spec.ts']],
    ['app/[locale]/settings/page.tsx', ['settings.spec.ts', 'teams.spec.ts']],
    ['lib/factory/store.ts', ['factory-acceptance-ui.spec.ts', 'factory-acceptance-a2.spec.ts', 'thread-question.spec.ts', 'factory-execution-claim.spec.ts']],
    ['components/workspace/factory-approval-bar.tsx', ['factory-acceptance-a2.spec.ts']],
    ['components/coordinator/thread-card.tsx', ['thread-cards.spec.ts', 'thread-stop.spec.ts', 'issue-threads.spec.ts', 'coordinator-choice-card.spec.ts']],
    ['lib/device-enrollment.ts', ['device-authorization.spec.ts', 'mobile-handoff.spec.ts']],
    ['components/device-authorization.tsx', ['device-authorization.spec.ts']],
    ['lib/auth.ts', ['sign-out.spec.ts', 'workspace.spec.ts']],
    ['lib/suggestions/card.ts', ['suggestions-rail.spec.ts', 'suggestion-entry-contract.spec.ts']],
    ['lib/issue-relations.ts', ['relations.spec.ts']],
  ]) {
    const plan = browserPlan([file])
    assert.equal(plan.tier, 'targeted', file)
    for (const spec of expected) assert(plan.specs.includes(spec), `${file} → ${spec}`)
    assert.deepEqual(plan.specs, [...plan.specs].sort())
  }
  const mixed = browserPlan(['lib/slack/webhook.ts', 'lib/search/search.ts', 'README.md'])
  assert.deepEqual(mixed.specs, ['global-search-scope.spec.ts', 'site-search.spec.ts', 'slack-webhook.spec.ts'])
})

test('an edited spec runs whole; fixtures and deleted specs do not widen the run', () => {
  for (const file of specFiles) {
    const plan = browserPlan([`tests/e2e/${file}`])
    assert.equal(plan.tier, 'targeted', file)
    assert.deepEqual(plan.specs, [file])
  }
  assert.deepEqual(browserPlan(['tests/e2e/fixtures.ts', 'tests/e2e/support/server.ts']), smoke)
  assert.deepEqual(browserPlan(['tests/e2e/removed-flow.spec.ts']), smoke)
  assert.deepEqual(browserPlan(['tests/e2e/../../evil.spec.ts']), smoke)
})

test('performance runs before merge only when its budgets or specs change', () => {
  for (const file of ['tests/e2e/navigation-performance.spec.ts', 'tests/e2e/agent-performance.spec.ts', 'components/app-sidebar.tsx', 'components/settings/settings-sidebar.tsx', 'lib/settings-navigation.ts', 'next.config.mjs']) {
    assert.equal(browserPlan([file]).performance, true, file)
  }
  for (const file of ['lib/auth.ts', 'app/page.tsx', 'lib/model.test.ts']) assert.equal(browserPlan([file]).performance, false, file)
})

test('main pushes run the main tier, nightly and manual runs run full plus performance; unsafe input fails closed', () => {
  assert.deepEqual(browserPlan(['app/page.tsx'], { mainPush: true }), { tier: 'main', specs: [], performance: false })
  assert.deepEqual(browserPlan(['README.md'], { mainPush: true }), { tier: 'docs', specs: [], performance: false })
  for (const files of [[], ['README.md'], ['lib/slack/webhook.ts']]) {
    assert.deepEqual(browserPlan(files, { integration: true }), { ...full, performance: true })
  }
  assert.deepEqual(browserPlan([]), full)
  assert.deepEqual(browserPlan(['README.md'], { unsafeModes: true }), full)
  assert.deepEqual(browserPlan(['app/page.tsx'], { unsafeModes: true, mainPush: true }), { ...full, performance: true })
})

test('every spec file has exactly one post-merge tier, and every listed spec exists', () => {
  const main = new Set(BROWSER_MAIN_SPECS), nightly = new Set(BROWSER_NIGHTLY_SPECS)
  assert.equal(main.size, BROWSER_MAIN_SPECS.length)
  assert.equal(nightly.size, BROWSER_NIGHTLY_SPECS.length)
  for (const file of specFiles) assert.notEqual(main.has(file), nightly.has(file), `${file} must be in exactly one of main or nightly-only`)
  for (const spec of [...main, ...nightly, ...BROWSER_SCOPED_SPECS]) assert(existsSync(`tests/e2e/${spec}`), spec)
  for (const spec of BROWSER_SMOKE_FILES) assert(main.has(spec), spec)
})

test('the smoke tag marks exactly the approved tests, and only in the declared files', () => {
  const tagged = specFiles.filter(file => readFileSync(`tests/e2e/${file}`, 'utf8').includes("'@smoke'"))
  assert.deepEqual(tagged, [...BROWSER_SMOKE_FILES].sort())
  const count = specFiles.reduce((sum, file) => sum + (readFileSync(`tests/e2e/${file}`, 'utf8').match(/'@smoke'/g) ?? []).length, 0)
  assert.equal(count, 10)
  assert.equal((readFileSync('tests/mvp/core-loop.spec.ts', 'utf8').match(/'@smoke'/g) ?? []).length, 1)
  // The keyed Turnstile run selects the sign-up smoke test.
  assert.match(readFileSync('tests/e2e/workspace.spec.ts', 'utf8'), /test\('注册、创建任务、菜单、搜索、视图切换和退出登录', \{ tag: \['@smoke', '@turnstile'\] \}/)
})

test('runner turns each tier into fixed argv and refuses anything else', () => {
  assert.deepEqual(browserArguments('smoke', '[]'), ['exec', 'playwright', 'test', '--grep', '@smoke', '--grep-invert', '@performance'])
  assert.deepEqual(browserArguments('targeted', JSON.stringify(['settings.spec.ts', 'teams.spec.ts'])),
    ['exec', 'playwright', 'test', '--grep', '@smoke|(?:^| )(?:settings\\.spec\\.ts|teams\\.spec\\.ts) ', '--grep-invert', '@performance'])
  const main = browserArguments('main', '[]', '2/2')
  assert.deepEqual(main.slice(3, -3), BROWSER_MAIN_SPECS.map(spec => `tests/e2e/${spec}`))
  assert.deepEqual(main.slice(-3), ['--grep-invert', '@performance', '--shard=2/2'])
  assert.deepEqual(browserArguments('full', '[]'), ['exec', 'playwright', 'test', '--grep-invert', '@performance'])
  assert.deepEqual(browserArguments('full', '[]', '4/4').at(-1), '--shard=4/4')
  for (const [tier, list] of [
    ['full', ['routes.spec.ts']], ['main', ['routes.spec.ts']], ['smoke', ['routes.spec.ts']], ['targeted', []],
    ['docs', []], ['', []], ['targeted', ['../evil.spec.ts']], ['targeted', ['--pass-with-no-tests']],
    ['targeted', ['routes.spec.ts', 'routes.spec.ts']], ['targeted', ['$(touch /tmp/injected)']], ['smoke', [null]],
    ['targeted', ['missing-flow.spec.ts']], ['targeted', ['fixtures.ts']], ['targeted', ['a|b.spec.ts']],
  ]) assert.throws(() => browserArguments(tier, JSON.stringify(list)), `${tier} ${JSON.stringify(list)}`)
  assert.throws(() => browserArguments('full', 'not JSON'))
  assert.throws(() => browserArguments('full', '{}'))
  for (const shard of ['0/4', '4/3', '1/0', '1', '1/x', '../1/2', '01/4', ' 1/4']) assert.throws(() => browserArguments('full', '[]', shard), shard)
  assert.throws(() => browserArguments('smoke', '[]', '1/2'))
  assert.throws(() => browserArguments('targeted', '["routes.spec.ts"]', '1/2'))
})

test('targeted grep selects whole files by name and the smoke tag, nothing else', () => {
  const grep = new RegExp(specGrep(['settings.spec.ts', 'teams.spec.ts']))
  // Playwright's grep title: root (empty), project, file, describe, test title, tags.
  assert(grep.test(' chromium settings.spec.ts 工作区访问拒绝 拒绝访问'))
  assert(grep.test(' chromium teams.spec.ts 公开团队'))
  assert(grep.test(' chromium routes.spec.ts 旧入口 @smoke'))
  assert(!grep.test(' chromium settings-surface.spec.ts settings row dividers'))
  assert(!grep.test(' chromium workspace-settings.spec.ts x'))
  assert(!grep.test(' chromium profile.spec.ts 切换界面语言'))
})

test('runner invokes pnpm without a shell, preserves failure, and gives the Turnstile secret only to the keyed run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-runner-retained-'))
  console.log(`Retained browser runner evidence: ${dir}`)
  const trace = join(dir, 'argv.json'), envTrace = join(dir, 'env.json')
  writeFileSync(join(dir, 'pnpm'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.env.TEST_TRACE, JSON.stringify(process.argv.slice(2))); writeFileSync(process.env.TEST_ENV_TRACE, JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY ?? null, report: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? null })); process.exit(Number(process.env.TEST_EXIT));\n`, { mode: 0o700 })
  const env = { PATH: dir, TEST_TRACE: trace, TEST_ENV_TRACE: envTrace }
  for (const status of [0, 7]) {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs')], {
      encoding: 'utf8', env: { ...env, BROWSER_TIER: 'smoke', BROWSER_SPECS: '[]', TEST_EXIT: String(status) },
    })
    assert.equal(result.status, status, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), browserArguments('smoke', '[]'))
    // The ordinary run never holds the secret, so token-less API sign-ups keep working.
    assert.deepEqual(JSON.parse(readFileSync(envTrace, 'utf8')), { secret: null, report: null })
  }
  for (const status of [0, 5]) {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs'), '--turnstile'], { encoding: 'utf8', env: { ...env, TEST_EXIT: String(status) } })
    assert.equal(result.status, status, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), turnstileArguments())
    assert.deepEqual(JSON.parse(readFileSync(envTrace, 'utf8')), { secret: TURNSTILE_TEST_SECRET, report: 'playwright-turnstile-report' })
  }
  assert.equal(TURNSTILE_TEST_SECRET, '1x0000000000000000000000000000000AA')
  assert.notEqual(spawnSync(process.execPath, [resolve('scripts/ci-browser-tests.mjs'), '--turnstile', '--shard=1/2'], { encoding: 'utf8', env }).status, 0)
})

test('each selection plan can run as an independent unsharded job', () => {
  assert.deepEqual(selectionPlan('smoke'), smoke)
  assert.equal(selectionPlan('targeted').tier, 'targeted')
  assert.deepEqual(selectionPlan('targeted').specs, [...BROWSER_SCOPED_SPECS])
  assert.equal(selectionValidationPlans().length, 2)
  assert.throws(() => selectionPlan('full'))
  assert.throws(() => selectionPlan(''))
})

test('selection validation cannot be sharded or use both modes', () => {
  for (const args of [['--verify-selection', '--shard=1/4'], ['--verify-selection-plan=smoke', '--shard=1/4']]) {
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
  const base = git(['commit-tree', tree(`100644 blob ${blob}\tREADME.md\n`), '-m', 'base'])
  const changed = git(['hash-object', '-w', '--stdin'], 'source-only test')
  const libTree = tree(`100644 blob ${changed}\tmodel.test.ts\n`)
  const head = git(['commit-tree', tree(`100644 blob ${blob}\tREADME.md\n040000 tree ${libTree}\tlib\n`), '-p', base, '-m', 'test-only'])
  const slackTree = tree(`100644 blob ${changed}\twebhook.ts\n`)
  const scopedHead = git(['commit-tree', tree(`100644 blob ${blob}\tREADME.md\n040000 tree ${tree(`040000 tree ${slackTree}\tslack\n`)}\tlib\n`), '-p', base, '-m', 'slack'])
  const executableTree = tree(`100755 blob ${changed}\tmodel.test.ts\n`)
  const unsafeHead = git(['commit-tree', tree(`040000 tree ${executableTree}\tlib\n`), '-p', base, '-m', 'unsafe mode'])
  const script = resolve('scripts/ci-docs-only.mjs')
  let count = 0
  for (const [event, payload, ref, tier, perf] of [
    ['pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, '', 'smoke', 'false'],
    ['pull_request', { pull_request: { base: { sha: base }, head: { sha: scopedHead } } }, '', 'targeted', 'false'],
    ['pull_request', { pull_request: { base: { sha: base }, head: { sha: unsafeHead } } }, '', 'full', 'false'],
    ['pull_request', {}, '', 'full', 'false'],
    ['pull_request', { pull_request: { base: { sha: 'missing' }, head: { sha: head } } }, '', 'full', 'false'],
    ['push', { before: base, after: head }, 'refs/heads/main', 'main', 'false'],
    ['push', {}, 'refs/heads/main', 'full', 'true'],
    ['schedule', {}, '', 'full', 'true'], ['workflow_dispatch', {}, '', 'full', 'true'],
  ]) {
    const eventPath = join(dir, `${count}-event.json`), output = join(dir, `${count++}-output`)
    writeFileSync(eventPath, JSON.stringify(payload))
    execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { ...env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_REF: ref, GITHUB_SHA: payload.after ?? '', GITHUB_OUTPUT: output } })
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
    assert.equal(outputs.browser_tier, tier, `${event} ${tier}`)
    assert.equal(outputs.browser_performance, perf)
    assert.equal(outputs.docs_only, 'false')
    assert.equal(outputs.verify_selection, 'false')
    browserArguments(outputs.browser_tier, outputs.browser_specs, tier === 'main' || tier === 'full' ? '1/2' : undefined)
  }
})

function gateScript() {
  const block = workflow().split('      - name: Require the selected browser layer\n')[1].split('\n\n  main-red-issue:\n')[0]
  return block.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
}

test('protected browser gate requires exactly the jobs of the selected tier', () => {
  const script = gateScript()
  const result = (options = {}) => {
    const tier = options.tier ?? 'smoke'
    const sharded = !['smoke', 'targeted'].includes(tier)
    return spawnSync('bash', ['-e', '-c', script], {
      env: {
        PATH: process.env.PATH,
        CHANGES_RESULT: options.changes ?? 'success',
        PR_RESULT: options.pr ?? (sharded ? 'skipped' : 'success'),
        SELECTION_RESULT: options.selection ?? (options.verify === 'true' ? 'success' : 'skipped'),
        BUILD_RESULT: options.build ?? (sharded ? 'success' : 'skipped'),
        RUNTIME_RESULT: options.runtime ?? (sharded ? 'success' : 'skipped'),
        FULL_RESULT: options.full ?? (sharded ? 'success' : 'skipped'),
        DOCS_ONLY: options.docs ?? 'false',
        BROWSER_TIER: tier,
        BROWSER_PERFORMANCE: options.performance ?? 'false',
        EVENT_NAME: options.event ?? 'pull_request',
        VERIFY_SELECTION: options.verify ?? 'false',
      },
    }).status === 0
  }
  // Pull request tiers: the single job, nothing sharded.
  for (const tier of ['smoke', 'targeted']) {
    assert(result({ tier }))
    assert(result({ tier, performance: 'true' }))
    for (const value of ['failure', 'cancelled', 'skipped', '']) assert(!result({ tier, pr: value }), `${tier} pr ${value}`)
    for (const job of ['build', 'runtime', 'full']) assert(!result({ tier, [job]: 'success' }), `${tier} ${job} must not run`)
    assert(result({ tier, verify: 'true', selection: 'success' }))
    assert(!result({ tier, verify: 'true', selection: 'failure' }))
    assert(!result({ tier, verify: 'true', selection: 'skipped' }))
    assert(!result({ tier, verify: 'false', selection: 'success' }))
  }
  assert(!result({ changes: 'failure' }))
  assert(!result({ verify: 'maybe' }))
  assert(!result({ performance: 'maybe' }))
  // Sharded tiers: build, runtime and every shard, never the pull request job.
  for (const [event, tier, performance] of [['push', 'main', 'false'], ['push', 'full', 'true'], ['schedule', 'full', 'true'], ['workflow_dispatch', 'full', 'true'], ['pull_request', 'full', 'true'], ['pull_request', 'full', 'false']]) {
    assert(result({ event, tier, performance }), `${event} ${tier}`)
    for (const value of ['failure', 'cancelled', 'skipped', '']) {
      for (const job of ['build', 'runtime', 'full']) assert(!result({ event, tier, performance, [job]: value }), `${event} ${tier} ${job} ${value}`)
    }
    assert(!result({ event, tier, performance, pr: 'success' }))
  }
  assert(result({ event: 'pull_request', tier: 'full', verify: 'true', selection: 'success' }))
  assert(!result({ event: 'pull_request', tier: 'full', verify: 'true', selection: 'failure' }))
  // Tier and event must agree.
  for (const [event, tier, performance] of [
    ['push', 'main', 'true'], ['push', 'smoke', 'false'], ['push', 'full', 'false'], ['schedule', 'main', 'false'],
    ['schedule', 'full', 'false'], ['workflow_dispatch', 'targeted', 'false'], ['pull_request', 'main', 'false'], ['pull_request', '', 'false'],
  ]) assert(!result({ event, tier, performance }), `${event} ${tier} ${performance}`)
  // Documentation: no browser runtime, but the classification must have succeeded.
  for (const event of ['pull_request', 'push']) {
    assert(result({ event, tier: 'docs', docs: 'true', pr: 'skipped', build: 'skipped', runtime: 'skipped', full: 'skipped' }))
    assert(!result({ event, tier: 'docs', docs: 'false' }))
    assert(!result({ event, tier: 'docs', docs: 'true', changes: 'failure' }))
  }
})

test('workflow wires each tier to its jobs and keeps the protected check name', () => {
  const source = workflow()
  assert(source.includes('    name: Browser tests (before merge)\n'))
  assert(source.includes('needs: [changes, browser-pr, browser-selection, browser-build, browser-runtime, browser-e2e-full]'))
  // One pull request runner: build, runtime gates, MVP smoke, smoke/targeted, Turnstile, performance.
  const pr = source.split('\n  browser-pr:\n')[1].split('\n  browser-selection:\n')[0]
  for (const step of ['pnpm exec next build', 'pnpm test:test-accounts-db', 'pnpm test:factory-http', 'node scripts/test-accounts/run-http.mjs',
    'pnpm test:e2e:mvp --grep @smoke', 'node scripts/ci-browser-tests.mjs >', 'node scripts/ci-browser-tests.mjs --turnstile', 'pnpm test:performance',
    'node scripts/test-accounts/evidence.mjs', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY: 1x00000000000000000000AA']) assert(pr.includes(step), step)
  assert(!pr.includes('name: browser-build-'), 'no build artifact round trip on pull requests')
  assert(!pr.includes('pnpm lint') && !pr.includes('pnpm build'), 'lint runs once, in ui-policy.yml')
  assert(!pr.includes('TURNSTILE_SECRET_KEY'), 'the secret reaches only the keyed run')
  assert(source.includes("shard: ${{ fromJSON(needs.changes.outputs.browser_tier == 'main' && '[1, 2]' || '[1, 2, 3, 4]') }}"))
  assert(source.includes('node scripts/ci-browser-tests.mjs --shard=${{ matrix.shard }}/$BROWSER_SHARDS'))
  assert(source.includes('node scripts/ci-browser-tests.mjs --verify-selection-plan=targeted'))
  assert(source.includes("cron: '17 19 * * *'"))
  assert(source.includes('  workflow_dispatch:\n'))
  for (const name of ['browser-build-${{ github.sha }}', 'browser-test-report-runtime-${{ github.sha }}', 'browser-test-report-pull-request-${{ github.sha }}',
    'browser-test-report-selection-targeted-${{ github.sha }}', 'browser-test-report-shard-${{ matrix.shard }}-${{ github.sha }}']) assert(source.includes(`name: ${name}`), name)
  // Every uploaded path is one the evidence scanner audits first.
  const scanned = readFileSync('scripts/test-accounts/evidence.mjs', 'utf8')
  for (const path of ['playwright-turnstile-report', 'turnstile-results', '.cache/e2e/playwright-turnstile.log', 'playwright-selection-targeted-report', 'selection-targeted-results', '.cache/e2e/playwright-selection.log']) {
    assert(source.includes(path), path)
    assert(scanned.includes(path), path)
  }
  // A red main run is tracked in one issue that names the merged PR's author.
  const issue = source.split('\n  main-red-issue:\n')[1]
  assert(issue.includes('issues: write'))
  assert(issue.includes('listPullRequestsAssociatedWithCommit'))
  assert(issue.includes("github.event_name == 'push' && github.ref == 'refs/heads/main'"))
  // Every install goes through the read-only-on-PR cache action.
  assert(!source.includes('cache: pnpm'))
  assert.equal(source.match(/uses: \.\/\.github\/actions\/pnpm-install/g).length, 5)
})

test('pnpm store cache is restored everywhere and saved only on main', () => {
  const action = readFileSync('.github/actions/pnpm-install/action.yml', 'utf8')
  assert.match(action, /uses: actions\/cache\/restore@[a-f0-9]{40}\b/)
  assert.match(action, /uses: actions\/cache\/save@[a-f0-9]{40}\b/)
  assert(action.includes("if: github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.restore.outputs.cache-hit != 'true'"))
  assert(!action.includes('cache: pnpm'))
  assert(!readFileSync('.github/workflows/ui-policy.yml', 'utf8').includes('cache: pnpm'))
})

test('real subset entrypoint retains search receipts and rejects missing evidence or failed subsets', () => {
  for (const [receipt, status, expected] of [[true, 0, 0], [false, 0, 1], [true, 7, 7]]) {
    const dir = mkdtempSync(join(tmpdir(), 'browser-subset-retained-'))
    console.log(`Retained subset entrypoint evidence: ${dir}`)
    // The runner checks spec names against tests/e2e in its working directory.
    mkdirSync(join(dir, 'tests'))
    symlinkSync(resolve('tests/e2e'), join(dir, 'tests/e2e'))
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

test('CI-only updates run smoke with dedicated policy validation, without full functionality or performance', () => {
  for (const file of BROWSER_INFRA_FILES) {
    assert.deepEqual(browserPlan([file]), smoke, file)
    assert.deepEqual(browserPlan([file, 'lib/slack/webhook.ts']).specs, ['slack-webhook.spec.ts'], `${file} mixed with a mapped path`)
  }
  assert(needsSelectionValidation(['scripts/ci-docs-only.mjs']))
  assert(needsSelectionValidation(['.github/workflows/browser-tests.yml']))
  assert.equal(needsSelectionValidation(['.github/workflows/analytics-ci.yml']), false)
  assert.equal(needsSelectionValidation(['README.md']), false)
})

test('actual workflow bootstrap cannot let an edited classifier narrow app changes, unknown modes, or integration', () => {
  const wrapper = workflow().split(`<<'BROWSER_BOOTSTRAP'\n`)[1].split('          BROWSER_BOOTSTRAP')[0].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
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
  for (const [files, mode, event, tier, performance, verify] of [
    [BROWSER_INFRA_FILES, '100644', 'pull_request', 'smoke', 'false', 'true'],
    [['scripts/ci-docs-only.mjs', 'app/page.tsx'], '100644', 'pull_request', 'full', 'false', 'true'],
    [['scripts/ci-docs-only.mjs', 'new/unknown.ts'], '100644', 'pull_request', 'full', 'false', 'true'],
    [['scripts/ci-docs-only.mjs', 'tests/e2e/routes.spec.ts'], '100644', 'pull_request', 'full', 'false', 'true'],
    [['scripts/ci-docs-only.mjs'], '100755', 'pull_request', 'full', 'false', 'true'],
    [['scripts/ci-docs-only.mjs'], '120000', 'pull_request', 'full', 'false', 'true'],
    [['scripts/ci-docs-only.mjs', 'tests/e2e/navigation-performance.spec.ts'], '100644', 'pull_request', 'full', 'true', 'true'],
    [BROWSER_INFRA_FILES, '100644', 'push', 'full', 'true', 'false'],
    [BROWSER_INFRA_FILES, '100644', 'schedule', 'full', 'true', 'false'],
    [BROWSER_INFRA_FILES, '100644', 'workflow_dispatch', 'full', 'true', 'false'],
  ]) {
    const head = git(['commit-tree', tree([['README.md','100644'], ...files.map(file => [file,mode])]), '-p', base, '-m', 'change'])
    const eventFile = join(dir, `${count}-event.json`), outputFile = join(dir, `${count++}-output`)
    writeFileSync(eventFile, JSON.stringify({pull_request:{base:{sha:base},head:{sha:head}}}))
    execFileSync(process.execPath, ['--input-type=module','-',trusted], {cwd:dir, encoding:'utf8', input:wrapper, env:{...env,GITHUB_EVENT_NAME:event,GITHUB_EVENT_PATH:eventFile,GITHUB_OUTPUT:outputFile}})
    const outputs = Object.fromEntries(readFileSync(outputFile,'utf8').trim().split('\n').map(line => { const at=line.indexOf('='); return [line.slice(0,at),line.slice(at+1)] }))
    assert.equal(outputs.docs_only, 'false')
    assert.equal(outputs.verify_selection, verify)
    assert.equal(outputs.browser_tier, tier)
    assert.equal(outputs.browser_performance, performance)
    assert.deepEqual(JSON.parse(outputs.browser_specs), [])
  }
})

// Run 41155092993: an unsafe main push was classified push:full without performance, which the gate refuses.
test('the required browser gate accepts every plan the classifier emits', () => {
  const workflow = readFileSync(resolve('.github/workflows/browser-tests.yml'), 'utf8')
  const accepted = workflow.match(/case "\$EVENT_NAME:\$BROWSER_TIER:\$DOCS_ONLY:\$BROWSER_PERFORMANCE" in\n([\s\S]*?)\n\s*\*\) fail/)[1]
  const patterns = [...accepted.matchAll(/^\s*([^)]+)\)/gm)].flatMap(match => match[1].split('|'))
  const allowed = key => patterns.some(pattern => new RegExp(`^${pattern.replaceAll('*', '.*')}$`).test(key))
  const plans = {
    push: [browserPlan(['app/page.tsx'], { mainPush: true }), browserPlan(['app/page.tsx'], { mainPush: true, unsafeModes: true }), browserPlan([], { mainPush: true }), browserPlan(['README.md'], { mainPush: true })],
    pull_request: [browserPlan(['app/page.tsx']), browserPlan(['components/settings/x.tsx']), browserPlan(['README.md'], { unsafeModes: true }), browserPlan([])],
    schedule: [browserPlan([], { integration: true })],
  }
  for (const [event, list] of Object.entries(plans)) for (const plan of list) {
    const key = `${event}:${plan.tier}:${plan.tier === 'docs'}:${plan.performance}`
    assert.ok(allowed(key), `gate refuses ${key}`)
  }
})
