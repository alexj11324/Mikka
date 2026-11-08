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
  assert.deepEqual(warmer.jobs['desktop-dependencies'].strategy.matrix.os, ['ubuntu-latest', 'macos-26'])
  assert.deepEqual(warmer.permissions, { contents: 'read' })
  const setup = warmer.jobs['desktop-dependencies'].steps.find(step => step.uses === './.github/actions/pnpm-install')
  assert.deepEqual(setup.with, { profile: 'desktop', 'skip-electron': 'true' })
})

test('selected specialty calls reuse the parent decision; direct dispatch still runs trusted selection', () => {
  const parent = workflow('ui-policy')
  for (const [name, lane] of [['desktop', 'desktop'], ['analytics-ssr', 'analytics'], ['self-hosted-image', 'image']]) {
    const w = workflow(name)
    assert.equal(parent.jobs[`${lane}-checks`].with.selected, true)
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

test('macOS acceptance starts independently and retains icon, package, crypto and functional checks', () => {
  const desktop = workflow('desktop'), native = desktop.jobs['native-arm64']
  assert.deepEqual(native.needs, ['changes'])
  assert(!desktop.jobs.icon, 'icon preflight shares the native runner')
  for (const name of ['checks', 'smoke', 'native-arm64']) {
    assert(desktop.jobs[name].steps.some(step => step.uses === './.github/actions/pnpm-install'))
    assert(!desktop.jobs[name].steps.some(step => step.with?.cache === 'pnpm'), 'PRs must not upload setup-node caches')
  }
  const commands = native.steps.map(step => step.run || '').join('\n')
  for (const required of ['actool', 'pnpm build:app', 'package-dev.mjs --acceptance', 'native-crypto.mjs', 'bundled-smoke parity lifecycle', 'native-evidence.mjs']) assert(commands.includes(required), required)
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
  const fingerprint = action.runs.steps.find(step => step.id === 'modules-key')
  for (const [optIn, inherited, expected] of [['true', '', '1'], ['false', '1', '1'], ['false', undefined, '']]) {
    const context = { inputs: { 'skip-electron': optIn }, env: { ELECTRON_SKIP_BINARY_DOWNLOAD: inherited } }
    assert.equal(evaluate(install.env.ELECTRON_SKIP_BINARY_DOWNLOAD, context), expected)
    assert.equal(evaluate(fingerprint.env.ELECTRON_SKIP_BINARY_DOWNLOAD, context), expected)
  }
})
