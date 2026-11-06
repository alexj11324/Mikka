import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { frontendRuntimeSource } from '../../frontend/scripts/frontend-runtime.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const renderer = join(repository, 'apps/desktop/src/renderer')
let sequence = 0
const names = ['window', 'fetch', '__earlyWorkspaceImports', '__earlyWorkspaceRenders', '__earlyAppStarts', '__earlyAppGate', '__earlyStartupApi']
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }

async function runtimeFixture(t, { url = 'mikka://app/mikka/en', identity } = {}) {
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const window = { location: new URL(url) }
  let calls = 0, requests = 0
  window.mikka = { bundled: { session: () => { calls++; return identity ?? Promise.resolve(null) } } }
  const gate = deferred()
  Object.assign(globalThis, {
    window, __earlyWorkspaceImports: 0, __earlyWorkspaceRenders: 0, __earlyAppStarts: 0, __earlyAppGate: gate.promise,
    fetch: async () => { requests++; throw new Error('LOCAL_PRELOAD_MUST_NOT_FETCH_DATA') },
  })
  const runtime = frontendRuntimeSource('desktop', { frontend: join(repository, 'apps/frontend'), renderer })
  const result = await build({
    absWorkingDir: repository, entryPoints: [join(repository, 'apps/frontend/src/index.tsx')],
    write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2023',
    tsconfig: join(repository, 'apps/desktop/tsconfig.renderer.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
    plugins: [{ name: 'installed-startup-order-fixture', setup(builder) {
      builder.onResolve({ filter: /^mikka:frontend-runtime$/ }, () => ({ path: 'runtime', namespace: 'startup-runtime' }))
      builder.onLoad({ filter: /.*/, namespace: 'startup-runtime' }, () => ({ contents: runtime, resolveDir: repository, loader: 'js' }))
      builder.onResolve({ filter: /^\.\.\/\.\.\/desktop\/src\/renderer\/index$/ }, () => ({ path: 'app', namespace: 'startup-app' }))
      builder.onLoad({ filter: /.*/, namespace: 'startup-app' }, () => ({
        contents: `import * as api from ${JSON.stringify(join(renderer, 'workspace-loader.ts'))};
          globalThis.__earlyStartupApi = api;
          globalThis.__earlyAppStarts++;
          await globalThis.__earlyAppGate;`, resolveDir: repository, loader: 'js',
      }))
      builder.onResolve({ filter: /^\.\/workspace$/ }, args => args.importer.endsWith('workspace-loader.ts') ? { path: 'workspace', namespace: 'startup-workspace' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'startup-workspace' }, () => ({
        contents: 'globalThis.__earlyWorkspaceImports++; export default function Workspace() { globalThis.__earlyWorkspaceRenders++; return null }', loader: 'js',
      }))
    } }],
  })
  const entry = import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#early-startup-${++sequence}`)
  t.after(async () => {
    gate.resolve()
    await entry
    for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]
  })
  const until = async predicate => {
    const end = performance.now() + 1000
    while (!predicate()) { assert.ok(performance.now() < end, 'STARTUP_FIXTURE_DEADLINE'); await delay(1) }
  }
  await until(() => globalThis.__earlyAppStarts === 1)
  return { entry, gate, until, calls: () => calls, requests: () => requests }
}

test('the real desktop runtime starts one retained-session code hint before the application graph finishes', async t => {
  const identity = deferred()
  const run = await runtimeFixture(t, { identity: identity.promise })
  assert.equal(run.calls(), 1, 'main identity hint begins before the application module can finish')
  assert.equal(globalThis.__earlyWorkspaceImports, 0, 'the identity hint is still pending')
  const first = globalThis.__earlyStartupApi.preloadWorkspace()
  assert.equal(globalThis.__earlyStartupApi.preloadWorkspace(), first, 'later React effects join the same optional preload')
  assert.equal(run.calls(), 1, 'entry and React effect do not issue duplicate session IPC')
  identity.resolve({ user: { id: 'owner' }, session: { id: 'public-session-id' } })
  await first
  assert.equal(globalThis.__earlyWorkspaceImports, 1)
  assert.equal(globalThis.__earlyWorkspaceRenders, 0, 'installed code does not mount an authenticated application')
  assert.equal(run.requests(), 0, 'only installed code and the existing private main identity hint are used')
  const loading = globalThis.__earlyStartupApi.loadWorkspace()
  assert.equal(globalThis.__earlyStartupApi.loadWorkspace(), loading)
  await loading
  assert.equal(globalThis.__earlyWorkspaceImports, 1, 'React.lazy reuses the warmed module')
  run.gate.resolve()
  await run.entry
})

test('the early desktop entry keeps signed-out and public/auth documents lazy and excludes foreign/web origins', async t => {
  for (const url of [
    'mikka://app/mikka', 'mikka://app/mikka/en/sign-in', 'mikka://app/mikka/en/a/shared-fixture',
    'mikka://app/mikka/en/device', 'mikka://other/mikka/en', 'https://app.example/mikka/en',
  ]) await t.test(url, async t => {
    const run = await runtimeFixture(t, { url })
    await globalThis.__earlyStartupApi.preloadWorkspace()
    assert.equal(run.calls(), url === 'mikka://app/mikka' ? 1 : 0)
    assert.equal(globalThis.__earlyWorkspaceImports, 0)
    assert.equal(globalThis.__earlyWorkspaceRenders, 0)
    assert.equal(run.requests(), 0)
  })
})

test('the web runtime remains its existing production/development instrumentation entry without the desktop warm-up', () => {
  for (const development of [false, true]) {
    const original = `${development ? 'globalThis[Symbol.for("openui.devtools.autoMount")] = true;\n' : ''}import ${JSON.stringify(join(repository, 'apps/frontend/src/web/runtime.ts'))};\n`
    assert.equal(frontendRuntimeSource('web', { development, frontend: join(repository, 'apps/frontend'), renderer }), original)
  }
})

test('a failed early identity hint cannot prevent the normal application or authenticated lazy path', async t => {
  const identity = deferred()
  const run = await runtimeFixture(t, { identity: identity.promise })
  const cause = new Error('fixture identity IPC failure')
  identity.reject(cause)
  await assert.rejects(globalThis.__earlyStartupApi.preloadWorkspace(), error => error === cause)
  assert.equal(globalThis.__earlyWorkspaceImports, 0)
  assert.equal(run.requests(), 0)
  run.gate.resolve()
  await run.entry
  assert.equal(typeof (await globalThis.__earlyStartupApi.loadWorkspace()).default, 'function')
  assert.equal(globalThis.__earlyWorkspaceImports, 1)
  assert.equal(globalThis.__earlyWorkspaceRenders, 0)
})
