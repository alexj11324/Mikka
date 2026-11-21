import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import yaml from 'js-yaml'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const load = path => yaml.load(read(path))

test('all declared product engines accept Node 22, with 24 still the default', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '**/package.json', 'package.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const file of files) {
    const pkg = JSON.parse(read(file))
    if (pkg.engines?.node) assert.equal(pkg.engines.node, '>=22', file)
  }
  assert.equal(read('.node-version').trim(), '24')
  assert.equal(JSON.parse(read('node_modules/eve/package.json')).engines.node, '>=22')
  const workspace = load('pnpm-workspace.yaml')
  assert.equal(workspace.patchedDependencies['eve@1.3.0'], 'patches/eve@1.3.0.patch')
})

test('Node bundles target 22 rather than relying on the compiler host version', () => {
  for (const file of ['packages/daemon/scripts/build-cloud-worker.mjs', 'services/credential-broker/build.mjs',
    'scripts/build-cloudflare-world.mjs', 'apps/api/workflow-development-aliases.mjs', 'apps/api/scripts/finalize-build.mjs']) {
    assert.match(read(file), /target: 'node22'/, file)
    assert.doesNotMatch(read(file), /target: 'node24'/, file)
  }
})

test('runtime version gates accept 22/24 and still reject 20 before any application code', () => {
  // Exercise the shipped entries in subprocesses. Downstream configuration or
  // missing build files may fail, but must not be mistaken for a version refusal.
  for (const version of ['22.23.5', '24.22.1', '20.19.0']) {
    for (const [file, expected] of [['scripts/self-hosted-start.mjs', 'SELF_HOSTED_NODE22_REQUIRED'],
      ['cloudflare/api/start.mjs', 'CLOUDFLARE_API_NODE22_REQUIRED']]) {
      const code = `Object.defineProperty(process, 'version', {value: 'v${version}'}); Object.defineProperty(process.versions, 'node', {value: '${version}'}); process.argv[1] = ${JSON.stringify(new URL(file, root).pathname)}; await import(${JSON.stringify(new URL(file, root).href)});`
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5_000 })
      assert.equal(result.status, 1, `${file} ${version}: ${result.stderr}`)
      if (version.startsWith('20.')) assert.match(result.stderr, new RegExp(expected))
      else assert.doesNotMatch(result.stderr, /NODE_?2[24]_REQUIRED/)
    }
  }
})

test('CI installs, builds and starts both real runtimes without a daemon-only duplicate', () => {
  const compat = load('.github/workflows/local-device-node22.yml')
  const job = compat.jobs['node22-unit']
  assert.deepEqual(job.strategy.matrix.node, ['22', '24'])
  const setup = job.steps.find(step => step.uses === './.github/actions/pnpm-install')
  assert.equal(setup.with['node-version'], '${{ matrix.node }}')
  const commands = job.steps.map(step => step.run ?? '').join('\n')
  for (const command of ['pnpm build:app', 'node scripts/runtime-compatibility-smoke.mjs', 'pnpm test:eve', 'pnpm --filter @mikka/daemon test']) assert(commands.includes(command), command)
  const ci = load('.github/workflows/ui-policy.yml')
  for (const key of ['ui-policy-full', 'ui-policy-integrations', 'browser-tests-full']) {
    const job = ci.jobs[key]
    assert.deepEqual(job.strategy.matrix.node, ['22', '24'], key)
    assert.equal(job.steps.find(step => step.uses === './.github/actions/pnpm-install').with['node-version'], '${{ matrix.node }}')
  }
  assert.equal(ci.jobs['browser-tests-full'].strategy.matrix.shard, '${{ fromJSON(needs.changes.outputs.db_matrix).shard }}')
  const action = load('.github/actions/pnpm-install/action.yml')
  assert.equal(action.inputs['node-version'].default, '24')
  assert.equal(action.runs.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '${{ inputs.node-version }}')
})

test('pinned Eve development cleanup works without Node 24 resource-management globals', () => {
  const workspace = load('pnpm-workspace.yaml')
  assert.equal(workspace.packageExtensions['eve@1.3.0'].dependencies['core-js-pure'], '3.51.0')
  const source = read('node_modules/eve/dist/src/internal/nitro/host/start-development-server.js')
  assert.match(source, /import AsyncDisposableStack from "core-js-pure\/actual\/async-disposable-stack\/index.js"/)
  assert.match(source, /import SuppressedError from "core-js-pure\/actual\/suppressed-error.js"/)
  const code = `
    import assert from 'node:assert/strict'
    import {createRequire} from 'node:module'
    import {realpathSync} from 'node:fs'
    import {fileURLToPath} from 'node:url'
    delete globalThis.AsyncDisposableStack
    delete globalThis.SuppressedError
    const require=createRequire(realpathSync(fileURLToPath(${JSON.stringify(new URL('../node_modules/eve/package.json', import.meta.url).href)})))
    const Stack=require('core-js-pure/actual/async-disposable-stack/index.js')
    const Suppressed=require('core-js-pure/actual/suppressed-error.js')
    const seen=[], stack=new Stack()
    stack.defer(async()=>{await Promise.resolve();seen.push('first')})
    stack.defer(()=>seen.push('second'))
    const owned=stack.move()
    await stack.disposeAsync()
    assert.deepEqual(seen,[])
    await owned.disposeAsync()
    await owned.disposeAsync()
    assert.deepEqual(seen,['second','first'])
    const failed=new Stack(), first=Error('first'), second=Error('second')
    failed.defer(()=>{throw first})
    failed.defer(async()=>{throw second})
    await assert.rejects(failed.disposeAsync(),error=>error instanceof Suppressed && error.error===first && error.suppressed===second)
    assert.equal(globalThis.AsyncDisposableStack,undefined)
    assert.equal(globalThis.SuppressedError,undefined)
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
})
