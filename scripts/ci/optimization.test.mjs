import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

const workflow = name => yaml.load(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const evaluate = (expression, context) => runInNewContext(expression.replace(/^\$\{\{|\}\}$/g, '').replace(/\.([\w-]+)/g, '[$1]').replace(/\[([\w-]+)\]/g, '["$1"]'), { always: () => true, cancelled: () => false, ...context })

test('Desktop platform caches warm on changed main install inputs without duplicating acceptance on main', () => {
  const warmer = workflow('ci-dependencies')
  assert.deepEqual(warmer.on.push.branches, ['main'])
  assert(!warmer.on.pull_request)
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/package.json', '.github/actions/pnpm-install/**', 'scripts/ci/dependency-cache.mjs']) assert(warmer.on.push.paths.includes(path), path)
  assert.equal(warmer.jobs['desktop-dependencies']['runs-on'], 'ubuntu-latest')
  assert.deepEqual(warmer.permissions, { contents: 'read' })
  const setup = warmer.jobs['desktop-dependencies'].steps.find(step => step.uses === './.github/actions/pnpm-install')
  assert.deepEqual(setup.with, { profile: 'desktop', 'skip-electron': 'true' })
  // Analytics can consume the full Linux tree populated by the main Image job,
  // which already suppresses Electron's unused runtime download.
  const analyticsSetup = workflow('analytics-ssr').jobs['analytics-ssr-full'].steps.find(step => step.uses === './.github/actions/pnpm-install')
  assert.equal(analyticsSetup.with['skip-electron'], 'true')
})

test('selected specialty calls reuse the parent decision; direct dispatch still runs trusted selection', () => {
  const parent = workflow('ui-policy')
  const automatic = [['analytics-ssr', 'analytics'], ['self-hosted-image', 'image']]
  for (const [, lane] of automatic) assert.equal(parent.jobs[`${lane}-checks`].with.selected, true)
  assert.equal(parent.jobs['desktop-checks'], undefined)
  assert.ok(Object.hasOwn(workflow('desktop').on, 'workflow_dispatch'), 'Desktop acceptance remains available manually')
  for (const [name, lane] of [...automatic, ['desktop', 'desktop']]) {
    const w = workflow(name)
    assert.equal(w.on.workflow_call.inputs.selected.default, false)
    assert.equal(evaluate(w.jobs.changes.if, { inputs: { selected: true } }), false)
    assert.equal(evaluate(w.jobs.changes.if, { inputs: { selected: false } }), true)
    for (const job of Object.values(w.jobs).filter(j => j.needs?.includes('changes') && j.if?.includes('inputs.selected'))) {
      for (const [selected, result, output, expected] of [[true, 'skipped', 'false', true], [false, 'success', 'true', true], [false, 'success', 'false', false], [false, 'failure', 'true', false]]) {
        assert.equal(evaluate(job.if, { inputs: { selected }, needs: { changes: { result, outputs: { [lane]: output } } } }), expected, `${name}: ${selected}/${result}/${output}`)
      }
    }
  }
})

test('the analytics gate accepts a reused decision but rejects failed, cancelled and skipped selected work', () => {
  const gate = workflow('analytics-ssr').jobs['analytics-ssr'].steps[0]
  for (const selected of [true, false]) {
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      const context = { inputs: { selected }, needs: { changes: { result: selected ? 'skipped' : 'success', outputs: { analytics: 'true' } }, 'analytics-ssr-full': { result } } }
      const env = Object.fromEntries(Object.entries(gate.env).map(([key, value]) => [key, evaluate(value, context)]))
      assert.equal(spawnSync('bash', ['-e', '-c', gate.run], { env }).status, result === 'success' ? 0 : 1, `${selected}/${result}`)
    }
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
    for (const phase of ['production-eve-postgres', 'production-eve-maintenance', 'production-api', 'stage-all']) {
      const output = join(directory, 'output')
      await writeFile(output, '')
      const child = spawnSync(process.execPath, ['--input-type=module'], { input: script, cwd: directory,
        env: { PATH: process.env.PATH, MIKKA_DEPLOYMENT_PHASE: phase, GITHUB_OUTPUT: output }, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(await readFile(output, 'utf8'), 'source=' + (['production-eve-postgres', 'production-eve-maintenance'].includes(phase) ? eve : application) + '\n')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
