import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, matchesGlob } from 'node:path'
import { tmpdir } from 'node:os'
import { PRODUCTION_VERSION_URL, assertProductionSource,
  assertCurrentMain, waitForWebDeployment, containsDesktopSource } from './web-deploy.mjs'

const SHA = 'a'.repeat(40)
test('runtime release accepts only the exact source currently served by Cloudflare', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return Response.json({ build: SHA }, { headers: { 'cf-ray': 'fixture' } })
  }
  await assertProductionSource({ expectedBuild: SHA, fetchImpl })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, PRODUCTION_VERSION_URL)
  assert.equal(calls[0].init.headers.authorization, undefined)
  await assert.rejects(assertProductionSource({ expectedBuild: OTHER, fetchImpl }), /production_source_changed/)
  const staleProvider = async () => Response.json({ build: SHA }, { headers: { 'x-vercel-id': 'retired-provider' } })
  await assert.rejects(assertProductionSource({ expectedBuild: SHA, fetchImpl: staleProvider }), /production_source_changed/)
})

const OTHER = 'b'.repeat(40)
function webFixture({ main = () => SHA, version = () => SHA, overlay = () => undefined, budget = 500 } = {}) {
  let elapsed = 0
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ path: url.pathname, origin: url.origin, method: init.method ?? 'GET', at: elapsed })
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer read-only-fixture')
      assert.equal(url.pathname, '/repositories/1427517699/git/ref/heads/main')
      return Response.json({ object: { type: 'commit', sha: main(elapsed, value => { elapsed = value }) } })
    }
    assert.equal(String(input), PRODUCTION_VERSION_URL)
    assert.equal(init.headers.authorization, undefined)
    assert.equal(init.cache, 'no-store')
    return Response.json({ build: version(elapsed, value => { elapsed = value }), overlaySha: overlay(elapsed) },
      { headers: { 'cf-ray': 'fixture' } })
  }
  return { calls, run: extra => waitForWebDeployment({ expectedBuild: SHA, token: 'read-only-fixture', fetchImpl,
    now: () => elapsed, wait: async ms => { elapsed += ms }, intervalMs: 100, maxWaitMs: budget, ...extra }), elapsed: () => elapsed }
}

test('waits until the exact source is observed through Cloudflare and returns provider evidence', async () => {
  const fixture = webFixture({ version: elapsed => elapsed < 300 ? OTHER : SHA })
  const result = await fixture.run()
  assert.deepEqual(result, { sourceCommit: SHA, publicBuild: SHA, provider: 'cloudflare', verifiedAt: result.verifiedAt })
  assert.ok(Number.isFinite(Date.parse(result.verifiedAt)))
  assert.equal(fixture.elapsed(), 300)
  assert.deepEqual(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').map(call => call.at), [0, 100, 200, 300])
  assert.ok(fixture.calls.every(call => call.method === 'GET'))
  assert.ok(fixture.calls.every(call => call.origin !== 'https://api.vercel.com'))
})

test('only an exact Cloudflare-served build with the requested overlay is accepted', async () => {
  const fixture = webFixture({ version: () => SHA, overlay: elapsed => elapsed < 200 ? OTHER : SHA })
  assert.equal((await fixture.run({ expectedOverlay: SHA })).publicBuild, SHA)
  assert.equal(fixture.elapsed(), 200)
})

test('a Vercel response cannot satisfy the production source fence', async () => {
  const fetchImpl = async input => String(input) === PRODUCTION_VERSION_URL
    ? Response.json({ build: SHA }, { headers: { 'x-vercel-id': 'retired-provider' } })
    : Response.json({ object: { type: 'commit', sha: SHA } })
  await assert.rejects(waitForWebDeployment({ expectedBuild: SHA, token: 'read-only-fixture', fetchImpl,
    maxWaitMs: 100, intervalMs: 100, now: (() => { let t = 0; return () => t++ })(), wait: async () => {} }),
  /matchingWebDeploymentTimedOut/)
})

test('a public build mismatch has a finite wait and cannot pass after the deadline', async () => {
  const fixture = webFixture({ version: () => OTHER, budget: 250 })
  await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 250)
})

test('main advancing during public verification rejects the obsolete source', async () => {
  const fixture = webFixture({ main: (elapsed, advance) => { if (elapsed) return OTHER; advance(1); return SHA } })
  await assert.rejects(fixture.run(), /mainChanged/)
})

test('invalid source, missing identity or invalid wait fails without any network request', async () => {
  const fetchImpl = async () => assert.fail('no request for an invalid release')
  await assert.rejects(assertCurrentMain({ expectedBuild: 'main', token: 't', fetchImpl }), /commitShaRequired/)
  await assert.rejects(assertCurrentMain({ expectedBuild: SHA, fetchImpl }), /githubTokenRequired/)
  await assert.rejects(waitForWebDeployment({ expectedBuild: SHA, token: 't', maxWaitMs: 0, fetchImpl }), /invalidVerificationWait/)
})

test('GitHub errors do not expose response bodies or transport messages', async () => {
  for (const fetchImpl of [async () => new Response('private-response-marker', { status: 403 }),
    async () => new Response('private-response-marker'), async () => { throw Error('private-response-marker') }]) {
    await assert.rejects(assertCurrentMain({ expectedBuild: SHA, token: 't', fetchImpl }), error => {
      assert.match(error.message, /webDeploy:github/)
      assert.doesNotMatch(error.message, /private-response-marker/)
      return true
    })
  }
})

test('the runtime release holds one non-cancelling queue and never publishes through Vercel', () => {
  const e2b = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
    + readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(e2b, /^concurrency:/m)
  const callerQueue = e2b.slice(e2b.indexOf('\n  release:'), e2b.indexOf('name: E2B serialized'))
  assert.match(callerQueue, /cancel-in-progress: false\n      queue: max/)
  assert.match(callerQueue, /e2b-official-runtime-release/)
  assert.doesNotMatch(callerQueue, /web-deploy-production/)
  const waitJob = e2b.slice(e2b.indexOf('\n  await-web:'), e2b.indexOf('\n  templates:'))
  assert.match(waitJob, /actions: read/)
  assert.match(waitJob, /run: node scripts\/release\/cloudflare-promoted-web\.mjs\n/)
  assert.doesNotMatch(waitJob, /concurrency:|id-token:|Infisical|publish-template-env\.mjs/)
  assert.doesNotMatch(e2b, /web-deploy\.mjs await-|uses: \.\/\.github\/workflows\/web-deploy\.yml|\n  publish:/)
  assert.match(e2b, /workflow_dispatch:\n    inputs:\n      runtime-refresh:\n        description: [^\n]+\n        type: boolean\n        default: false/)
  // A push only reports changed inputs; the paid release starts from a dispatch carrying the Cloudflare receipt.
  const webReady = e2b.slice(e2b.indexOf('\n  web-ready:'), e2b.indexOf('\n  release:'))
  assert.match(webReady, /needs: check\n    if: needs\.check\.outputs\.changed == 'true' && github\.event_name != 'push'/)
  assert.match(webReady, /if: needs\.check\.outputs\.receipt == ''\n        run: \|\n[^\n]+\n          exit 1\n/)
  assert.match(webReady, /run: node scripts\/release\/cloudflare-promoted-web\.mjs\n/)
  assert.doesNotMatch(webReady, /id-token:|Infisical|web-deploy-production|e2b-official-runtime-release/)
  assert.match(e2b, /release:\n    needs: \[test, check, web-ready\]\n    if: needs\.check\.outputs\.changed == 'true' && github\.event_name != 'push'/)
  const checkJob = e2b.slice(e2b.indexOf('\n  check:'), e2b.indexOf('\n  release:'))
  // A Cloudflare gateway observation starts the release; only that run's receipt is used.
  assert.match(e2b, /workflow_run:\n    workflows: \[Cloudflare application deployment\]\n    types: \[completed\]/)
  assert.match(checkJob, /receipt: \$\{\{ github\.event\.inputs\.cloudflare_receipt \|\| steps\.trigger\.outputs\.receipt \}\}/)
  assert.match(checkJob, /if: github\.event_name == 'workflow_run'\n        run: node scripts\/release\/cloudflare-promoted-web\.mjs trigger runtime/)
  assert.match(checkJob, /if: github\.event_name != 'workflow_run' \|\| steps\.trigger\.outputs\.ready == 'true'\n        run: node scripts\/e2b\/runtime-inputs\.mjs\n/)
  assert.match(e2b, /uses: \.\/\.github\/workflows\/e2b-runtime-release\.yml\n    with:\n      cloudflare_receipt: \$\{\{ needs\.check\.outputs\.receipt \}\}/)
  assert.doesNotMatch(e2b, /github\.event\.inputs\.cloudflare_receipt \}\}/)
  assert.match(checkJob, /fetch-depth: 0/)
  // The runtime publishes the served commit; later merges to main do not invalidate a running release.
  assert.doesNotMatch(e2b, /web-deploy\.mjs main/)
  assert.match(e2b, /source_sha: \$\{\{ needs\.web-ready\.outputs\.source \}\}/)
  assert.doesNotMatch(checkJob, /Infisical|VERCEL_TEAM_TOKEN|publish-template-env|RUNTIME_REFRESH/)
  assert.match(checkJob, /steps\.history\.outputs\.changed/)
  // queue:max is GitHub's documented queue contract, not a locally simulated
  // scheduler. Stale jobs still need the main fences regardless of queue order.
})

test('desktop replaces obsolete preflights while preserving active signing and documentation does not trigger a release', () => {
  const desktop = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(desktop, /^concurrency:/m, 'a new workflow must not cancel a running signing job')
  const preflight = desktop.slice(desktop.indexOf('\n  preflight:'), desktop.indexOf('\n  macos:'))
  const signing = desktop.slice(desktop.indexOf('\n  macos:'))
  assert.ok(preflight.includes("group: desktop-release-preflight-${{ github.ref }}-${{ github.event_name == 'workflow_run' && format('observed-{0}', github.event.workflow_run.id) || github.event_name == 'push' && 'push' || 'promoted' }}"),
    'a push must not supersede the independently verified Cloudflare promotion')
  assert.match(preflight, /cancel-in-progress: true/)
  assert.match(signing, /group: .*'desktop-release'.*\n      cancel-in-progress: false/)
  assert.doesNotMatch(signing, /queue: max|cancel-in-progress: true/, 'keep one active signer and only the latest pending candidate')
  assert.doesNotMatch(desktop, /web-deploy\.mjs/)
  const paths = [...desktop.slice(desktop.indexOf('\n  push:'), desktop.indexOf('\n  workflow_dispatch:'))
    .matchAll(/^\s+- '([^']+)'$/gm)].map(match => match[1])
  assert.ok(paths.length > 0)
  for (const file of ['docs/operations/web-runtime.md', 'docs/acceptance/issue-1415/final-evidence.md',
    'docs/acceptance/issue-1415/final-report.md', 'README.md', 'README.zh-CN.md',
    'docs/assets/architecture-dark.svg', 'docs/assets/architecture-light.svg',
    'docs/assets/architecture-zh-dark.svg', 'docs/assets/architecture-zh-light.svg']) {
    assert.equal(paths.some(pattern => matchesGlob(file, pattern)), false, file)
  }
})

test('real Git ancestry admits the same source or descendants and never an older or divergent public commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-web-ancestry-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = text => {
    writeFileSync(join(dir, 'fixture.txt'), text)
    git(['add', '.'])
    git(['-c', 'user.name=Release fixture', '-c', 'user.email=release@example.invalid', 'commit', '-qm', text])
    return git(['rev-parse', 'HEAD'])
  }
  try {
    git(['init', '-q', '-b', 'main'])
    const older = commit('older'), desktop = commit('desktop'), descendant = commit('deployed descendant')
    git(['checkout', '-qb', 'other', older])
    const divergent = commit('unrelated branch')
    const comparison = (base, head) => {
      const [behind, ahead] = git(['rev-list', '--left-right', '--count', base + '...' + head]).split(/\s+/).map(Number)
      return { url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + base + '...' + head,
        base_commit: { sha: git(['rev-parse', base]) }, merge_base_commit: { sha: git(['merge-base', base, head]) },
        status: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical',
        ahead_by: ahead, behind_by: behind }
    }
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input)
      assert.equal(init.headers.authorization, 'Bearer read-only-fixture')
      const [base, head] = url.pathname.split('/compare/')[1].split('...')
      return Response.json(comparison(base, head))
    }
    for (const [candidate, allowed] of [[desktop, true], [descendant, true], [older, false], [divergent, false]]) {
      assert.equal(await containsDesktopSource({ expectedBuild: desktop, publicCommit: candidate,
        token: 'read-only-fixture', fetchImpl }), allowed, candidate)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unbound or malformed GitHub comparison cannot admit a desktop release', async () => {
  for (const patch of [
    { url: 'https://api.github.com/repos/other/Mikka/compare/' + SHA + '...' + OTHER },
    { url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + SHA + '...' + 'c'.repeat(40) },
    { base_commit: { sha: OTHER } }, { merge_base_commit: {} },
    { status: 'unknown' }, { ahead_by: -1 }, { behind_by: null },
  ]) {
    const fetchImpl = async input => {
      const [base, head] = new URL(input).pathname.split('/compare/')[1].split('...')
      return Response.json({ url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + base + '...' + head,
        base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0, ...patch })
    }
    await assert.rejects(containsDesktopSource({ expectedBuild: SHA, publicCommit: OTHER, token: 'read-only-fixture', fetchImpl }),
      /invalidCommitComparison/)
  }
})

test('large runtime reports cross jobs only as immutable artifact files', () => {
  const files = ['e2b-template.yml', 'e2b-official-runtime.yml']
    .map(name => readFileSync(new URL('../../.github/workflows/' + name, import.meta.url), 'utf8'))
  for (const text of files) {
    assert.doesNotMatch(text, /candidate-report=|release-evidence=|CANDIDATE_REPORT:|RUNTIME_RELEASE_EVIDENCE:|TEMPLATE_MODELS:/,
      'a complete report or model catalogue must not enter a job output, input, argv or environment')
  }
  const [builder, caller] = files
  const runtime = caller + readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
  assert.match(builder, /candidate-artifact-id:.*steps\.candidates\.outputs\.artifact-id/)
  assert.match(builder, /name: e2b-candidates-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(builder, /name: e2b-candidate-build-cleanup-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /artifact-ids: \$\{\{ needs\.validate\.outputs\.candidate-artifact-id \}\}/)
  assert.match(runtime, /name: e2b-release-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /name: e2b-release-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]{0,300}retention-days: 90/,
    'published E2B release attestations must outlive the short-lived candidate evidence')
  assert.match(runtime, /name: e2b-runtime-release-cleanup-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /release-artifact-id: \$\{\{ steps\.release\.outputs\.artifact-id \}\}/)
  assert.match(runtime, /RUNTIME_REPORT_ARTIFACT_ID: \$\{\{ steps\.release\.outputs\.artifact-id \}\}/)
  assert.match(runtime, /merge-multiple: true/,
    'download-artifact v4 otherwise creates a name subdirectory even for one artifact ID')
  const subscription = runtime.slice(runtime.indexOf('\n  templates:'), runtime.indexOf('\n  cleanup:'))
  const reference = subscription.indexOf('node scripts/e2b/runtime-report.mjs reference')
  const download = subscription.indexOf('uses: actions/download-artifact@')
  const verify = subscription.indexOf('node scripts/e2b/runtime-report.mjs verify')
  assert.ok(reference > 0 && reference < download && download < verify && verify < subscription.indexOf('uses: Infisical/'))
  assert.ok(subscription.indexOf('assertReportIdentity(report') < subscription.indexOf('--publish-verified'))
  assert.ok(subscription.indexOf('assertCandidatePreserved(report, candidate)') < subscription.indexOf('--publish-verified'))
  assert.ok(subscription.indexOf('assertCandidatePreserved(report, candidate, { published: true })') > subscription.indexOf('--publish-verified'))
  const cleanup = runtime.slice(runtime.indexOf('\n  cleanup:'))
  assert.match(cleanup, /if: always\(\) && steps\.e2b-key\.outcome == 'success'/)
  assert.match(cleanup, /CANDIDATE_IDENTITIES: \$\{\{ needs\.validate\.outputs\.candidate-identities \}\}/)
  assert.doesNotMatch(cleanup, /download-artifact|candidate-artifact-id/,
    'cleanup uses independently bounded known IDs even when the full report download fails')
})
