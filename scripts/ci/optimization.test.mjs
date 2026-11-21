import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

const workflow = name => yaml.load(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const evaluate = (expression, context) => runInNewContext(expression.replace(/^\$\{\{|\}\}$/g, '').replace(/\.([\w-]+)/g, '[$1]').replace(/\[([\w-]+)\]/g, '["$1"]'), { always: () => true, cancelled: () => false, ...context })

test('dedicated self-hosted CI is retired while cloud compatibility and official builds remain', () => {
  for (const name of ['self-hosted-image', 'self-hosted-stable-release', 'self-hosting-ui'])
    assert.equal(existsSync(`.github/workflows/${name}.yml`), false, name)
  const parent = workflow('ui-policy')
  assert.equal(parent.jobs['image-checks'], undefined)
  assert(!parent.jobs['ui-policy'].needs.includes('image-checks'))
  assert.equal(workflow('self-hosted-production').name, 'Mikka cloud core compatibility')
  for (const name of ['cloudflare-api-image', 'cloudflare-eve-image', 'cloudflare-litellm-image', 'desktop-release'])
    assert.ok(workflow(name).jobs, name)
})

test('Desktop platform caches warm on changed main install inputs without duplicating acceptance on main', () => {
  const warmer = workflow('ci-dependencies')
  assert.deepEqual(warmer.on.push.branches, ['main'])
  assert(!warmer.on.pull_request)
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/package.json', '.github/actions/pnpm-install/**', 'scripts/ci/dependency-cache.mjs']) assert(warmer.on.push.paths.includes(path), path)
  assert.equal(warmer.jobs['desktop-dependencies']['runs-on'], 'ubuntu-latest')
  assert.deepEqual(warmer.permissions, { contents: 'read' })
  const setup = warmer.jobs['desktop-dependencies'].steps.find(step => step.uses === './.github/actions/pnpm-install')
  assert.deepEqual(setup.with, { profile: 'desktop', 'skip-electron': 'true' })
  // Analytics does not need Electron's runtime download.
  const analyticsSetup = workflow('analytics-ssr').jobs['analytics-ssr-full'].steps.find(step => step.uses === './.github/actions/pnpm-install')
  assert.equal(analyticsSetup.with['skip-electron'], 'true')
})

test('selected specialty calls reuse the parent decision; direct dispatch still runs trusted selection', () => {
  const parent = workflow('ui-policy')
  const automatic = [['analytics-ssr', 'analytics']]
  for (const [, lane] of automatic) assert.equal(parent.jobs[`${lane}-checks`].with.selected, true)
  assert.equal(parent.jobs['desktop-checks'], undefined)
  assert.ok(Object.hasOwn(workflow('desktop').on, 'workflow_dispatch'), 'Desktop acceptance remains available manually')
  for (const [name, lane] of [...automatic, ['desktop', 'desktop']]) {
    const w = workflow(name)
    assert.equal(w.on.workflow_call.inputs.selected.default, false)
    assert.equal(evaluate(w.jobs.changes.if, { inputs: { selected: true } }), false)
    assert.equal(evaluate(w.jobs.changes.if, { inputs: { selected: false } }), true)
    if (name === 'analytics-ssr') continue // Its native job validates malformed selection before any build step.
    for (const job of Object.values(w.jobs).filter(j => j.needs?.includes('changes') && j.if?.includes('inputs.selected'))) {
      for (const [selected, result, output, expected] of [[true, 'skipped', 'false', true], [false, 'success', 'true', true], [false, 'success', 'false', false], [false, 'failure', 'true', false]]) {
        assert.equal(evaluate(job.if, { inputs: { selected }, needs: { changes: { result, outputs: { [lane]: output } } } }), expected, `${name}: ${selected}/${result}/${output}`)
      }
    }
  }
})

test('Analytics reports its real build and browser result without a second queued summary runner', () => {
  const w = workflow('analytics-ssr')
  const [jobId, job] = Object.entries(w.jobs).find(([, job]) => job.name === 'analytics-ssr')
  assert(job.steps.some(step => step.run === 'pnpm build'), 'the named check must perform the actual build')
  assert(job.steps.some(step => step.run === 'node scripts/check-analytics-ssr.mjs --check-build'))
  assert(job.steps.some(step => step.run === 'node scripts/check-analytics-ssr.mjs'), 'the named check must render the real compiled pages')
  assert.equal(job['continue-on-error'], undefined)
  assert(job.steps.every(step => !step['continue-on-error']), 'native step failures must fail the check')
  assert(!Object.values(w.jobs).some(candidate => [candidate.needs].flat().includes(jobId)), 'native job status needs no second summary allocation')

  const gate = job.steps[0]
  for (const [selected, result, output, scheduled, status] of [
    [true, 'skipped', undefined, true, 0],
    [false, 'success', 'true', true, 0],
    [false, 'success', 'false', false, null],
    [false, 'failure', 'true', true, 1],
    [false, 'cancelled', 'true', true, 1],
    [false, 'skipped', 'true', true, 1],
    [false, 'success', undefined, true, 1],
    [false, 'success', 'invalid', true, 1],
  ]) {
    const context = { inputs: { selected }, needs: { changes: { result, outputs: { analytics: output } } } }
    assert.equal(evaluate(job.if, context), scheduled, `${selected}/${result}/${output}`)
    if (!scheduled) continue
    const env = Object.fromEntries(Object.entries(gate.env).map(([key, value]) => [key, evaluate(value, context)]))
    assert.equal(spawnSync('bash', ['-e', '-c', gate.run], { env }).status, status, `${selected}/${result}/${output}`)
  }
  assert.equal(evaluate(job.if, { inputs: { selected: true }, needs: { changes: {} }, cancelled: () => true }), false)
})

test('the protected parent requires success from selected Analytics work', () => {
  const gate = workflow('ui-policy').jobs['ui-policy'].steps.find(step => step.name === 'Require every selected source, unit and daemon job')
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    const context = { github: { event_name: 'pull_request' }, needs: {
      changes: { result: 'success', outputs: { core: 'false', integration: 'false', source: 'false', daemon: 'false', analytics: 'true', db: 'false' } },
      'ui-policy-full': { result: 'skipped' }, 'ui-policy-integrations': { result: 'skipped' },
      'source-checks': { result: 'skipped' }, 'daemon-checks': { result: 'skipped' },
      'workspace-governance-checks': { result: 'skipped' }, 'analytics-checks': { result },
    } }
    const env = { ...Object.fromEntries(Object.entries(gate.env).map(([key, value]) => [key, evaluate(value, context)])), GITHUB_STEP_SUMMARY: '/dev/null' }
    assert.equal(spawnSync('bash', ['-e', '-c', gate.run], { env }).status, result === 'success' ? 0 : 1, result)
  }
})

test('Desktop keeps Linux checks and acceptance without allocating Mac acceptance runners', () => {
  const desktop = workflow('desktop')
  assert.equal(desktop.jobs['native-arm64'], undefined)
  assert.equal(workflow('cloud-computer').jobs['local-driver-macos'], undefined)
  assert.deepEqual(Object.keys(workflow('local-device-node22').jobs), ['node22-unit'])
  // Assert the purpose — one reusable dependency installation whose credential
  // handling main's pinned-pnpm boundary can audit — not the mechanism. A
  // desktop job may reach that through the shared composite action or through a
  // literal install step, so long as exactly one step installs and no job hands
  // dependency caching to setup-node (which uploads per-PR caches).
  for (const name of ['checks', 'smoke']) {
    const job = desktop.jobs[name]
    const shared = job.steps.filter(step => step.uses === './.github/actions/pnpm-install')
    const literal = job.steps.filter(step => step.run === 'pnpm install --frozen-lockfile')
    assert.equal(shared.length + literal.length, 1, `${name}: exactly one dependency installation`)
    assert(!job.steps.some(step => step.with?.cache === 'pnpm'), `${name}: PRs must not upload setup-node caches`)
  }
  assert(desktop.jobs.smoke.steps.some(step => step.run?.includes('test:desktop-auth')))
})

test('installed cache writes are main-only and a miss installs; hits do not install or save', () => {
  const action = yaml.load(readFileSync('.github/actions/pnpm-install/action.yml', 'utf8'))
  const install = action.runs.steps.find(step => step.id === 'install')
  const saves = action.runs.steps.filter(step => step.uses?.startsWith('actions/cache/save@'))
  assert.equal(saves.length, 2)
  for (const event of ['pull_request', 'merge_group', 'push', 'workflow_dispatch']) {
    for (const ref of ['refs/pull/10/merge', 'refs/heads/feature', 'refs/heads/main']) {
      for (const reusable of ['true', 'false']) {
        const context = { github: { event_name: event, ref }, steps: { 'modules-key': { outputs: { reusable } }, install: { outcome: 'success' }, restore: { outputs: { 'cache-hit': 'false' } } } }
        const written = saves.filter(save => evaluate(save.if, context))
        const main = ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event)
        assert.equal(written.length, main ? 1 : 0, `${event}/${ref}/${reusable}`)
        if (main) assert.equal(written[0].with.key.includes('modules-key'), reusable === 'true')
      }
    }
  }
  for (const hit of ['true', 'false', undefined]) assert.equal(evaluate(install.if, { steps: { modules: { outputs: { 'cache-hit': hit } } } }), hit !== 'true')
  const restore = action.runs.steps.find(step => step.id === 'modules')
  assert(!restore.with['restore-keys'], 'installed modules never use partial key matches')
  // The desktop jobs render their own literal install step, so the expression
  // lives there rather than on the composite's install step: main's credential
  // boundary requires that step's env to carry FFMPEG_GITHUB_TOKEN alone.
  const desktop = workflow('desktop')
  const desktopInstalls = ['checks', 'smoke'].map(name => desktop.jobs[name].steps.find(step => step.run === 'pnpm install --frozen-lockfile'))
  assert(desktopInstalls.every(Boolean), 'every desktop job installs dependencies')
  const fingerprint = action.runs.steps.find(step => step.id === 'modules-key')
  for (const [optIn, inherited, expected] of [['true', '', '1'], ['false', '1', '1'], ['false', undefined, '']]) {
    const context = { inputs: { 'skip-electron': optIn }, env: { ELECTRON_SKIP_BINARY_DOWNLOAD: inherited } }
    assert.equal(evaluate(fingerprint.env.ELECTRON_SKIP_BINARY_DOWNLOAD, context), expected)
  }
  // Only `checks` installs without the Electron runtime: it only typechecks, lints
  // and tests, so the checksum-verifying installer never runs there. `smoke`
  // installs it, with its install env pinned to FFMPEG_GITHUB_TOKEN alone.
  const [checksInstall, ...installerJobs] = desktopInstalls
  assert.equal(checksInstall.env.ELECTRON_SKIP_BINARY_DOWNLOAD, '1')
  for (const step of installerJobs) assert.equal(step.env.ELECTRON_SKIP_BINARY_DOWNLOAD, undefined)
})


test('Eve migration and maintenance check out the Eve publication source and other phases keep the application source', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const step = workflow('cloudflare-app-deploy').jobs['deploy-application'].steps.find(step => step.id === 'product')
  const script = step.run.split("<<'JS'\n")[1].replace(/\nJS\s*$/, '')
  const directory = await mkdtemp(join(tmpdir(), 'eve-release-source-'))
  try {
    await mkdir(join(directory, 'docs/operations/releases'), { recursive: true })
    const application = 'a'.repeat(40), eve = 'b'.repeat(40)
    await writeFile(join(directory, 'docs/operations/releases/hosted-api-staging.json'), JSON.stringify({ publicSource: application }))
    await writeFile(join(directory, 'docs/operations/releases/eve-runtime-production.json'), JSON.stringify({ maintenancePublication: { publicSource: eve } }))
    const service = 'c'.repeat(40)
    await writeFile(join(directory, 'docs/operations/releases/service-release.json'), JSON.stringify({ service: 'litellm', publicSource: service }))
    for (const phase of ['production-eve-postgres', 'production-eve-maintenance', 'production-api', 'stage-all', 'service-stage', 'service-production']) {
      const output = join(directory, 'output')
      await writeFile(output, '')
      const child = spawnSync(process.execPath, ['--input-type=module'], { input: script, cwd: directory,
        env: { PATH: process.env.PATH, MIKKA_DEPLOYMENT_PHASE: phase, GITHUB_OUTPUT: output }, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(await readFile(output, 'utf8'), 'source=' + (['production-eve-postgres', 'production-eve-maintenance'].includes(phase) ? eve
        : phase.startsWith('service-') ? service : application) + '\n')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})


test('Site search checks types once through its build and a type failure prevents HTTP acceptance', t => {
  const job = workflow('site-search').jobs['site-search']
  const precheck = job.steps.find(step => step.run?.includes('generate-routes.mjs --check'))
  const build = job.steps.find(step => step.run === 'pnpm build')
  const http = job.steps.find(step => step.run?.includes('playwright test tests/e2e/site-search.spec.ts'))
  assert.ok(precheck && build && http, 'route checks, the real build and HTTP acceptance remain selected')
  assert.notEqual(build['continue-on-error'], true)
  const directory = mkdtempSync(join(tmpdir(), 'site-search-typechecks-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const trace = join(directory, 'calls.jsonl')
  // Exercise the actual workflow shell and root build command. Only external
  // package/build tools are recorded here; this is a wiring/failure-boundary
  // regression, not evidence that a compiler, PostgreSQL or HTTP suite passed.
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
appendFileSync(process.env.SDLC_TRACE_FILE, JSON.stringify({ tool: 'pnpm', args }) + '\\n')
if (args[0] === 'build') {
  const command = JSON.parse(readFileSync(process.env.SDLC_PACKAGE_FILE, 'utf8')).scripts.build
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
if (args[0] === 'typecheck' && process.env.SDLC_FAIL_TYPECHECK === '1') process.exit(17)
`, { mode: 0o755 })
  writeFileSync(join(directory, 'node'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.SDLC_TRACE_FILE,
  JSON.stringify({ tool: 'node', args: process.argv.slice(2) }) + '\\n')
`, { mode: 0o755 })
  for (const failed of [false, true]) {
    writeFileSync(trace, '')
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', [precheck.run, build.run, http.run].join('\n')], {
      encoding: 'utf8', env: { PATH: directory + delimiter + process.env.PATH,
        SDLC_TRACE_FILE: trace, SDLC_PACKAGE_FILE: resolve('package.json'), SDLC_FAIL_TYPECHECK: failed ? '1' : '0' },
    })
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(result.status, failed ? 17 : 0, result.stderr)
    assert.equal(calls.filter(call => call.tool === 'pnpm' && call.args[0] === 'typecheck').length, 1,
      'the existing build owns the complete typecheck')
    assert.equal(calls.filter(call => call.tool === 'pnpm' && call.args[0] === 'lint').length, 1)
    assert.equal(calls.filter(call => call.tool === 'node' && call.args.join(' ') === 'apps/api/scripts/generate-routes.mjs --check').length, 1)
    assert.equal(calls.some(call => call.tool === 'pnpm' && call.args.join(' ') === 'exec playwright test tests/e2e/site-search.spec.ts'), !failed)
  }
})
